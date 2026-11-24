/**
 * /rp/api/* — the plugin-hosted half of the roleplay app.
 *
 *   GET  /rp/api/status          provider inventory + plugin facts
 *   POST /rp/api/chat            SSE/JSON passthrough to an OpenAI-compatible endpoint
 *   GET  /rp/api/migrate         staged migration list
 *   GET  /rp/api/migrate?id=..   one staged payload
 *   POST /rp/api/migrate         stage an exported app backup (CORS-open)
 *   DEL  /rp/api/migrate?id=..   drop one staged payload
 *   GET  /rp/api/settings        plugin settings, keys masked
 *   POST /rp/api/settings        merge a settings patch
 *   GET  /rp/api/backup          list server-side backups
 *   POST /rp/api/backup          write a server-side backup of the page data
 *
 * Trust model: everything except the migration staging endpoint answers
 * same-origin loopback only (the page is served from the same DSH origin).
 * Staging is CORS-open because the old app runs on file:// or :5180 and has
 * to push its export across; it only ever writes a JSON file the user then
 * imports by hand, so the worst a hostile page achieves is junk in data/migrate.
 */
import { DEFAULT_ENDPOINT, isHttpEndpoint, providerOfEndpoint, providerStatus, resolveKey } from './providers.js'

const MIGRATE_MAX_BYTES = 24 * 1024 * 1024

export function isLoopbackHost(hostname) {
  if (!hostname) return false
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1') return true
  return /^127(\.\d{1,3}){3}$/.test(host)
}

/** Same-origin loopback check; refusals are what DNS rebinding and cross-site fetches hit first. */
export function isTrustedRequest(req) {
  const host = req.headers?.host
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHost(hostUrl.hostname)) return false
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers?.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Loopback-only, origin-agnostic: the migration staging door. */
export function isLocalMigrationCall(req) {
  const host = req.headers?.host
  if (typeof host !== 'string' || host === '') return false
  try {
    return isLoopbackHost(new URL(`http://${host}`).hostname)
  } catch {
    return false
  }
}

function sendJson(res, status, body, extraHeaders) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(extraHeaders || {}),
  })
  res.end(text)
}

function sendError(res, status, error, code, extraHeaders) {
  sendJson(res, status, { error: String(error || 'error'), code: code || 'ERROR' }, extraHeaders)
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let done = false
    const fail = (error) => {
      if (done) return
      done = true
      req.destroy()
      reject(error)
    }
    req.on('data', (chunk) => {
      if (done) return
      total += chunk.length
      if (total > limitBytes) {
        fail(Object.assign(new Error(`request body exceeds ${limitBytes} bytes`), { code: 'BODY_TOO_LARGE' }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', fail)
  })
}

async function readJsonBody(req, limitBytes) {
  const raw = await readBody(req, limitBytes)
  if (!raw.length) return {}
  try {
    const parsed = JSON.parse(raw.toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const error = new Error('body must be a JSON object')
      error.code = 'BAD_JSON'
      throw error
    }
    return parsed
  } catch (error) {
    if (error.code === 'BAD_JSON') throw error
    const wrapped = new Error('body is not valid JSON')
    wrapped.code = 'BAD_JSON'
    throw wrapped
  }
}

function maskKeys(keys) {
  const out = {}
  for (const name of Object.keys(keys || {})) {
    const value = String(keys[name] || '')
    out[name] = value ? `${value.slice(0, 4)}…${value.slice(-4)}` : ''
  }
  return out
}

/**
 * The chat passthrough. Mirrors the app's own server/proxy.js contract so the
 * browser half needs no changes beyond its /api -> /rp/api prefix rewrite.
 */
async function handleChat(req, res, ctx) {
  const { store } = ctx
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  const settings = await store.settings()
  const maxBytes = Math.max(1, Number(settings.maxBodyMb) || 64) * 1024 * 1024
  let payload
  try {
    payload = await readJsonBody(req, maxBytes)
  } catch (error) {
    const status = error.code === 'BODY_TOO_LARGE' ? 413 : 400
    sendError(res, status, error.message, error.code || 'BAD_BODY')
    return
  }

  const endpoint = String(payload.endpoint || DEFAULT_ENDPOINT).trim()
  const provider = String(payload.provider || providerOfEndpoint(endpoint) || '').trim()
  const body = payload.body

  if (!isHttpEndpoint(endpoint)) {
    sendError(res, 400, '接口地址必须是 http(s):// 开头', 'BAD_ENDPOINT')
    return
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
    sendError(res, 400, '请求体缺少 messages 数组', 'BAD_BODY')
    return
  }
  const key = resolveKey(provider, payload.key, settings.keys)
  if (!key) {
    sendError(
      res,
      401,
      `没有可用的 API Key：网页设置里没填，插件设置和环境变量里也没有${provider ? `（${provider}）` : ''}`,
      'NO_KEY',
    )
    return
  }

  const upstreamCtrl = new AbortController()
  // `res` close means the browser went away; `req` close fires as soon as the
  // body finished and would abort a healthy request.
  const onClose = () => {
    if (!res.writableEnded) {
      try {
        upstreamCtrl.abort()
      } catch {}
    }
  }
  res.on('close', onClose)

  const timeoutMs = Math.max(1000, Number(settings.upstreamTimeoutMs) || 30 * 60 * 1000)
  const timer = setTimeout(() => {
    upstreamCtrl.abort(new Error(`上游接口 ${Math.round(timeoutMs / 1000)} 秒内没有响应`))
  }, timeoutMs)

  let upstream
  try {
    upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream, application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: upstreamCtrl.signal,
    })
  } catch (error) {
    clearTimeout(timer)
    res.off('close', onClose)
    if (!res.headersSent) {
      const message =
        error && error.name === 'AbortError'
          ? `上游接口超时或已中断：${error.message || ''}`
          : `连不上上游接口：${error && error.message ? error.message : String(error)}`
      sendError(res, 502, message, 'UPSTREAM_UNREACHABLE')
      console.warn(`[roleplay] chat upstream failed: ${message}`)
    }
    return
  }
  clearTimeout(timer)

  if (!res.headersSent) {
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    })
  }

  if (!upstream.body) {
    const text = await upstream.text()
    res.end(text)
    res.off('close', onClose)
    return
  }

  const reader = upstream.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!res.write(Buffer.from(value))) {
        await new Promise((resolve) => res.once('drain', resolve))
      }
    }
    res.end()
  } catch {
    if (!upstreamCtrl.signal.aborted && !res.writableEnded) {
      try {
        res.end()
      } catch {}
    }
  } finally {
    res.off('close', onClose)
    try {
      reader.releaseLock()
    } catch {}
  }
}

export function createApiHandler(ctx) {
  const { store } = ctx
  const versionOf = () => String(ctx.version || '0.0.0')

  async function handleMigrate(req, res, url) {
    const settings = await store.settings()
    if (settings.migrateEnabled === false) {
      sendError(res, 404, 'migration staging is disabled in the plugin settings', 'DISABLED')
      return
    }

    const corsHeaders = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders)
      res.end()
      return
    }
    if (!isLocalMigrationCall(req)) {
      sendError(res, 403, 'request refused: loopback only', 'FORBIDDEN', corsHeaders)
      return
    }

    const id = url.searchParams.get('id')

    if (req.method === 'GET') {
      if (id) {
        const staged = await store.readMigration(id)
        if (!staged) {
          sendError(res, 404, 'no staged migration with that id', 'NOT_FOUND', corsHeaders)
          return
        }
        sendJson(res, 200, staged, corsHeaders)
        return
      }
      // The app's own migrate.js polls `GET /api/migrate` and looks for
      // `data`; hand it the newest payload under that field so the existing
      // import path keeps working, and keep `items` for the newer UI.
      const items = await store.listMigrations()
      const newest = items.length ? await store.readMigration(items[0].id) : null
      sendJson(
        res,
        200,
        { ok: true, items, data: newest ? newest.payload ?? null : null },
        corsHeaders,
      )
      return
    }

    if (req.method === 'DELETE') {
      // `DELETE /api/migrate` without an id drops the newest item, matching
      // the app's post-import cleanup call.
      let target = id
      if (!target) {
        const items = await store.listMigrations()
        target = items.length ? items[0].id : null
      }
      if (!target) {
        sendJson(res, 200, { ok: true, dropped: null }, corsHeaders)
        return
      }
      await store.dropMigration(target)
      sendJson(res, 200, { ok: true, dropped: target }, corsHeaders)
      return
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST, DELETE, OPTIONS', ...corsHeaders })
      res.end()
      return
    }

    try {
      const payload = await readJsonBody(req, MIGRATE_MAX_BYTES)
      // Accept either a raw export ({__app, roleSessions, local}) or an
      // envelope that wraps it under `data`.
      const staged = payload.data !== undefined ? payload.data : payload
      const stagingId = await store.stageMigration(staged, req.headers.origin || 'unknown')
      console.info(`[roleplay] staged migration ${stagingId} from ${req.headers.origin || 'unknown'}`)
      sendJson(res, 200, { ok: true, id: stagingId }, corsHeaders)
    } catch (error) {
      const status = error.code === 'BODY_TOO_LARGE' ? 413 : 400
      sendError(res, status, error.message, error.code || 'BAD_BODY', corsHeaders)
    }
  }

  return async function handleApi(req, res) {
    const url = new URL(String(req.url || '/'), 'http://localhost')
    const route = url.pathname.replace(/^\/rp\/api\/?/, '') || 'status'

    // Migration staging is reachable from the old app's own origins.
    if (route === 'migrate') return handleMigrate(req, res, url)

    if (!isTrustedRequest(req)) {
      sendError(res, 403, 'request refused: this route answers same-origin loopback only', 'FORBIDDEN')
      return
    }

    if (route === 'status') {
      const settings = await store.settings()
      sendJson(res, 200, {
        ok: true,
        // The app probes this field to decide whether to use the passthrough.
        proxy: true,
        version: versionOf(),
        mode: 'plugin',
        providers: providerStatus(settings.keys),
        migratedAt: settings.migratedAt || null,
      })
      return
    }

    if (route === 'chat') return handleChat(req, res, ctx)

    if (route === 'settings') {
      if (req.method === 'GET') {
        const settings = await store.settings()
        sendJson(res, 200, {
          ok: true,
          settings: {
            ...settings,
            keys: maskKeys(settings.keys),
            keyNames: Object.keys(settings.keys || {}),
          },
        })
        return
      }
      if (req.method !== 'POST' && req.method !== 'PATCH') {
        res.writeHead(405, { allow: 'GET, POST' })
        res.end()
        return
      }
      try {
        const patch = await readJsonBody(req, 1 * 1024 * 1024)
        const next = await store.patchSettings(patch)
        sendJson(res, 200, { ok: true, settings: { ...next, keys: maskKeys(next.keys) } })
      } catch (error) {
        sendError(res, 400, error.message, error.code || 'BAD_BODY')
      }
      return
    }

    if (route === 'backup') {
      if (req.method === 'GET') {
        const backups = await store.listBackups()
        sendJson(res, 200, { ok: true, backups })
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'GET, POST' })
        res.end()
        return
      }
      try {
        const payload = await readJsonBody(req, 64 * 1024 * 1024)
        const name = await store.writeBackup(payload.name || 'page', payload.data !== undefined ? payload.data : payload)
        sendJson(res, 200, { ok: true, name })
      } catch (error) {
        const status = error.code === 'BODY_TOO_LARGE' ? 413 : 400
        sendError(res, status, error.message, error.code || 'BAD_BODY')
      }
      return
    }

    sendError(res, 404, `unknown roleplay api route: ${route}`, 'NOT_FOUND')
  }
}
