/**
 * Static file responder for the roleplay app under /rp/.
 *
 * The app is a plain script-per-file page (built to app.js + app.css +
 * vendor/marked.global.js), so no history fallback is needed: anything that is
 * not a real file is a 404 and the browser reports it honestly instead of
 * receiving index.html with the wrong MIME type.
 *
 * Guards: decoded path must stay inside the static root (single-segment
 * dotfiles too), only GET/HEAD, and a Last-Modified/If-Modified-Since pair
 * keeps a 267 KB app.js from re-downloading on every panel toggle.
 */
import { promises as fsp, createReadStream } from 'node:fs'
import path from 'node:path'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm',
}

export function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end('404 Not Found')
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

/**
 * @param {object} options
 * @param {string} options.root absolute directory holding index.html
 * @param {string} [options.urlPrefix] mount point, default '/rp'
 * @param {(html: string) => string} [options.transformIndex] rewrite hook
 */
export function createStaticHandler({ root, urlPrefix = '/rp', transformIndex } = {}) {
  const rootDir = path.resolve(root)

  return async function handleStatic(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }

    const rawUrl = String(req.url || '/')
    const queryAt = rawUrl.indexOf('?')
    const rawPath = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt)

    if (rawPath === urlPrefix) {
      res.writeHead(301, { location: `${urlPrefix}/` })
      res.end()
      return
    }
    if (!rawPath.startsWith(`${urlPrefix}/`)) {
      notFound(res)
      return
    }

    let rel
    try {
      rel = decodeURIComponent(rawPath.slice(urlPrefix.length + 1))
    } catch {
      sendText(res, 400, '400 Bad Request')
      return
    }
    if (!rel || rel.endsWith('/')) rel += 'index.html'

    // Resolve and prove containment before touching the disk: '..', absolute
    // segments and encoded separators all land outside root and are refused.
    const target = path.resolve(rootDir, rel)
    if (target !== rootDir && !target.startsWith(rootDir + path.sep)) {
      sendText(res, 403, '403 Forbidden')
      return
    }
    const segments = rel.split('/')
    if (segments.some((segment) => segment.startsWith('.'))) {
      sendText(res, 403, '403 Forbidden')
      return
    }

    let stat
    try {
      stat = await fsp.stat(target)
    } catch {
      notFound(res)
      return
    }
    if (!stat.isFile()) {
      notFound(res)
      return
    }

    const isIndex = target === path.join(rootDir, 'index.html')
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
    const since = req.headers['if-none-match']
    if (since && String(since) === etag) {
      res.writeHead(304, { etag })
      res.end()
      return
    }

    const headers = {
      'content-type': mimeOf(target),
      // index.html must never be stale: it is what boots the shim and app.js.
      'cache-control': isIndex ? 'no-cache' : 'public, max-age=0, must-revalidate',
      'last-modified': stat.mtime.toUTCString(),
      etag,
      'x-content-type-options': 'nosniff',
    }

    if (req.method === 'HEAD') {
      res.writeHead(200, headers)
      res.end()
      return
    }

    if (isIndex && typeof transformIndex === 'function') {
      let html
      try {
        html = await fsp.readFile(target, 'utf8')
        html = transformIndex(html)
      } catch (error) {
        sendText(res, 500, `500 ${error && error.message ? error.message : 'index unavailable'}`)
        return
      }
      const body = Buffer.from(html, 'utf8')
      headers['content-length'] = String(body.length)
      res.writeHead(200, headers)
      res.end(body)
      return
    }

    headers['content-length'] = String(stat.size)
    res.writeHead(200, headers)
    const stream = createReadStream(target)
    stream.on('error', () => {
      if (!res.writableEnded) res.destroy()
    })
    stream.pipe(res)
  }
}
