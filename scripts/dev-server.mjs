#!/usr/bin/env node
/**
 * Standalone harness for the Host half: an ordinary node:http server that
 * mounts the same two handlers the DSH web server would, so routes can be
 * exercised (and the page opened in a browser) without restarting DSH.
 *
 *   node scripts/dev-server.mjs [--port 5199]
 *
 * Mirrors only what the plugin registers — no DSH session, no connection
 * auth. /rp/api/* still enforces the same loopback/origin checks.
 */
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createApiHandler } from '../lib/api.js'
import { createStaticHandler } from '../lib/static.js'
import { createStore } from '../lib/store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(HERE, '..')

const portArg = process.argv.indexOf('--port')
const PORT = portArg !== -1 ? Number(process.argv[portArg + 1]) : 5199

const store = createStore(path.join(PKG_ROOT, 'data'))
const version = 'dev'
const api = createApiHandler({ store, get version() { return version } })

function injectShim(html) {
  if (html.includes('/rp/boot.js')) return html
  const tag = '<script src="/rp/boot.js"></script>'
  return html.includes('<head>') ? html.replace('<head>', `<head>\n${tag}`) : `${tag}\n${html}`
}

const staticHandler = createStaticHandler({
  root: path.join(PKG_ROOT, 'static'),
  urlPrefix: '/rp',
  transformIndex: injectShim,
})

const server = http.createServer((req, res) => {
  const url = String(req.url || '/')
  if (url === '/rp/api' || url.startsWith('/rp/api/') || url.startsWith('/rp/api?')) {
    api(req, res).catch((error) => {
      console.error('[dev] api error:', error)
      if (!res.headersSent) res.writeHead(500)
      res.end('internal error')
    })
    return
  }
  if (url === '/rp' || url.startsWith('/rp/') || url.startsWith('/rp?')) {
    staticHandler(req, res).catch((error) => {
      console.error('[dev] static error:', error)
      if (!res.headersSent) res.writeHead(500)
      res.end('internal error')
    })
    return
  }
  res.writeHead(302, { location: '/rp/' })
  res.end()
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dev] roleplay host harness on http://127.0.0.1:${PORT}/rp/`)
  console.log(`[dev] data dir: ${path.join(PKG_ROOT, 'data')}`)
})
