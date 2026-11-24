import assert from 'node:assert/strict'
import http from 'node:http'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'

import { createApiHandler, isLoopbackHost, isTrustedRequest } from '../lib/api.js'
import { createStore } from '../lib/store.js'
import { providerOfEndpoint, resolveKey } from '../lib/providers.js'

let server
let base
let dataDir
let store

function request(pathname, init) {
  return fetch(`${base}${pathname}`, init)
}

function jsonRequest(pathname, body, init = {}) {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    body: JSON.stringify(body),
    ...init,
  })
}

before(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-roleplay-test-'))
  store = createStore(dataDir)
  const api = createApiHandler({ store, get version() { return 'test' } })
  server = http.createServer((req, res) => {
    api(req, res).catch((error) => {
      res.writeHead(500)
      res.end(String(error))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  server.close()
  await fsp.rm(dataDir, { recursive: true, force: true })
})

beforeEach(async () => {
  // Wipe staged data between tests but keep the same directory.
  await fsp.rm(path.join(dataDir, 'migrate'), { recursive: true, force: true })
})

describe('providers', () => {
  it('maps known endpoint hosts to provider ids', () => {
    assert.equal(providerOfEndpoint('https://api.deepseek.com/chat/completions'), 'deepseek')
    assert.equal(providerOfEndpoint('https://api.moonshot.cn/v1/chat/completions'), 'kimi')
    assert.equal(providerOfEndpoint('https://example.invalid/v1/chat'), '')
  })

  it('prefers payload key, then stored key, then environment', () => {
    const saved = process.env.DEEPSEEK_API_KEY
    try {
      delete process.env.DEEPSEEK_API_KEY
      assert.equal(resolveKey('deepseek', 'sk-payload', { deepseek: 'sk-stored' }), 'sk-payload')
      assert.equal(resolveKey('deepseek', '', { deepseek: 'sk-stored' }), 'sk-stored')
      process.env.DEEPSEEK_API_KEY = 'sk-env'
      assert.equal(resolveKey('deepseek', '', {}), 'sk-env')
    } finally {
      if (saved === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = saved
    }
  })
})

describe('trust checks', () => {
  it('classifies loopback hosts', () => {
    assert.equal(isLoopbackHost('127.0.0.1'), true)
    assert.equal(isLoopbackHost('::1'), true)
    assert.equal(isLoopbackHost('localhost'), true)
    assert.equal(isLoopbackHost('10.0.0.5'), false)
    assert.equal(isLoopbackHost('evil.example'), false)
  })

  it('refuses cross-site requests and foreign origins', () => {
    assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:1' } }), true)
    assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' } }), false)
    assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:1', origin: 'http://evil.example' } }), false)
    assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:1', origin: 'http://127.0.0.1:1' } }), true)
  })
})

describe('status route', () => {
  it('reports proxy mode, version and key presence', async () => {
    const response = await request('/rp/api/status')
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.proxy, true, 'the app probes this field')
    assert.equal(body.version, 'test')
    for (const name of ['deepseek', 'kimi', 'glm', 'custom']) {
      assert.equal(typeof body.providers[name].hasKey, 'boolean')
    }
  })
})

describe('chat route', () => {
  it('rejects a non-http endpoint', async () => {
    const response = await jsonRequest('/rp/api/chat', { endpoint: 'ftp://x', body: { messages: [] } })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, 'BAD_ENDPOINT')
  })

  it('rejects a body without messages', async () => {
    const response = await jsonRequest('/rp/api/chat', { endpoint: 'https://api.deepseek.com/chat/completions', body: {} })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, 'BAD_BODY')
  })

  it('refuses GET', async () => {
    const response = await request('/rp/api/chat')
    assert.equal(response.status, 405)
  })

  it('answers NO_KEY when no key is available anywhere', async () => {
    const saved = process.env.DEEPSEEK_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    try {
      await store.patchSettings({ keys: { deepseek: '' } })
      const response = await jsonRequest('/rp/api/chat', {
        endpoint: 'https://api.deepseek.com/chat/completions',
        body: { messages: [{ role: 'user', content: 'hi' }] },
      })
      assert.equal(response.status, 401)
      assert.equal((await response.json()).code, 'NO_KEY')
    } finally {
      if (saved !== undefined) process.env.DEEPSEEK_API_KEY = saved
    }
  })

  it('streams an SSE upstream body through unchanged', async () => {
    const chunks = ['data: {"a":1}\n\n', 'data: [DONE]\n\n']
    const upstream = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(chunks[0])
        res.end(chunks[1])
      })
    })
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamPort = upstream.address().port
    try {
      const response = await jsonRequest('/rp/api/chat', {
        endpoint: `http://127.0.0.1:${upstreamPort}/chat/completions`,
        key: 'sk-test',
        body: { messages: [{ role: 'user', content: 'hi' }] },
      })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), /text\/event-stream/)
      assert.equal(await response.text(), chunks.join(''))
    } finally {
      upstream.close()
    }
  })
})

describe('migration staging', () => {
  const backup = {
    __app: 'dsh-roleplay-backup',
    __version: 1,
    roleSessions: { roles: [{ id: 'r1', name: '阿岚' }] },
    local: { ds_roles: '[]' },
  }

  it('accepts a cross-origin push and hands back the newest payload', async () => {
    // file:// pages send Origin: null; this endpoint is the only CORS-open one.
    const push = await fetch(`${base}/rp/api/migrate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'null' },
      body: JSON.stringify(backup),
    })
    assert.equal(push.status, 200)
    const pushed = await push.json()
    assert.equal(pushed.ok, true)
    assert.match(pushed.id, /^[a-z0-9-]+$/i)

    const listed = await request('/rp/api/migrate')
    const body = await listed.json()
    assert.equal(body.items.length, 1)
    assert.deepEqual(body.data, backup, 'legacy `data` field carries the payload')
  })

  it('drops the newest payload on DELETE without an id', async () => {
    await fetch(`${base}/rp/api/migrate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(backup),
    })
    const removed = await request('/rp/api/migrate', { method: 'DELETE' })
    assert.equal(removed.status, 200)
    const after = await request('/rp/api/migrate')
    assert.deepEqual((await after.json()).items, [])
  })

  it('answers the preflight with CORS headers', async () => {
    const response = await request('/rp/api/migrate', { method: 'OPTIONS' })
    assert.equal(response.status, 204)
    assert.equal(response.headers.get('access-control-allow-origin'), '*')
  })

  it('rejects an unknown route', async () => {
    const response = await request('/rp/api/nope')
    assert.equal(response.status, 404)
  })
})

describe('settings route', () => {
  it('stores keys but only ever returns masks', async () => {
    const patch = await jsonRequest('/rp/api/settings', { keys: { deepseek: 'sk-abcdef123456' } })
    assert.equal(patch.status, 200)
    const read = await request('/rp/api/settings')
    const body = await read.json()
    assert.ok(!JSON.stringify(body).includes('sk-abcdef123456'), 'plaintext key never echoed')
    assert.equal(body.settings.keys.deepseek, 'sk-a…3456')
    assert.deepEqual(body.settings.keyNames, ['deepseek'])
  })

  it('keeps the real key on disk so chat keeps working', async () => {
    await jsonRequest('/rp/api/settings', { keys: { deepseek: 'sk-real-key-value' } })
    const settings = await store.settings()
    assert.equal(settings.keys.deepseek, 'sk-real-key-value')
  })
})

describe('backup route', () => {
  it('writes and lists a server-side backup', async () => {
    const write = await jsonRequest('/rp/api/backup', { name: 'page', data: { a: 1 } })
    assert.equal(write.status, 200)
    const name = (await write.json()).name
    assert.match(name, /page\.json$/)
    const list = await (await request('/rp/api/backup')).json()
    assert.ok(list.backups.includes(name))
  })
})
