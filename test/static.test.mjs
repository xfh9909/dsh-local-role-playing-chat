import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createStaticHandler } from '../lib/static.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STATIC = path.resolve(HERE, '..', 'static')

let server
let base

function request(pathname, init) {
  return fetch(`${base}${pathname}`, init)
}

before(async () => {
  const handler = createStaticHandler({
    root: STATIC,
    urlPrefix: '/rp',
    transformIndex: (html) => html.replace('<head>', '<head>\n<script src="/rp/boot.js"></script>'),
  })
  server = http.createServer((req, res) => {
    handler(req, res).catch(() => {
      res.writeHead(500)
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => {
  server.close()
})

describe('static handler', () => {
  it('serves the index with the shim injected', async () => {
    const response = await request('/rp/')
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/html/)
    const html = await response.text()
    assert.ok(html.includes('/rp/boot.js'), 'boot shim script tag present')
    assert.ok(html.includes('app.js'), 'app bundle referenced')
  })

  it('redirects /rp to /rp/', async () => {
    const response = await fetch(`${base}/rp`, { redirect: 'manual' })
    assert.equal(response.status, 301)
    assert.equal(response.headers.get('location'), '/rp/')
  })

  it('serves the app bundle with a javascript MIME type', async () => {
    const response = await request('/rp/app.js')
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /javascript/)
    const body = await response.text()
    assert.ok(body.length > 1000)
  })

  it('serves the shim itself', async () => {
    const response = await request('/rp/boot.js')
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.ok(body.includes('rp_'), 'storage prefix baked into the shim')
    assert.ok(body.includes('dsh-roleplay:exit'), 'exit message wired')
  })

  it('answers 404 for missing files instead of falling back to index', async () => {
    const response = await request('/rp/nope.js')
    assert.equal(response.status, 404)
  })

  it('refuses path traversal', async () => {
    // fetch() normalizes `..` in the path, so drive the raw request line.
    const status = await new Promise((resolve, reject) => {
      const socket = http.request(
        { host: '127.0.0.1', port: server.address().port, path: '/rp/../../lib/index.js', method: 'GET' },
        (res) => {
          res.resume()
          resolve(res.statusCode)
        },
      )
      socket.on('error', reject)
      socket.end()
    })
    assert.ok(status === 403 || status === 404, `expected refusal, got ${status}`)
  })

  it('rejects methods other than GET/HEAD', async () => {
    const response = await request('/rp/app.js', { method: 'POST' })
    assert.equal(response.status, 405)
  })

  it('revalidates with the ETag (304)', async () => {
    const first = await request('/rp/app.css')
    const etag = first.headers.get('etag')
    assert.ok(etag)
    const second = await request('/rp/app.css', { headers: { 'if-none-match': etag } })
    assert.equal(second.status, 304)
  })
})
