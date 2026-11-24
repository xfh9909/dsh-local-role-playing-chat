/**
 * dsh-roleplay — Host half.
 *
 * Registers two named routes on the DSH web server:
 *
 *   prefix /rp/api  -> JSON + SSE passthrough (see ./api.js)
 *   prefix /rp      -> the roleplay app itself (see ./static.js)
 *
 * Nothing is mounted when the host has no web server (headless runs never do):
 * the whole registration rides a scoped `ctx.inject`, so the plugin simply
 * stays inert there instead of failing activation.
 *
 * Data lives in `data/` beside this package (gitignored): settings.json with
 * optional API keys, migrate/ staging files, backups/ copies.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promises as fsp } from 'node:fs'

import { createApiHandler } from './api.js'
import { createStaticHandler } from './static.js'
import { createStore } from './store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PACKAGE_ROOT = path.resolve(HERE, '..')

/** Read the installed package version once, so /rp/api/status can report it. */
async function readVersion() {
  try {
    const text = await fsp.readFile(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')
    const pkg = JSON.parse(text)
    return String(pkg.version || '0.0.0')
  } catch {
    return '0.0.0'
  }
}

/**
 * Inject the embed shim into index.html at serve time.
 *
 * Keeping it out of the built file means the same static/ directory also works
 * when opened directly (npm run dev in the app repo) and the shim's storage
 * prefix can stay one line instead of a rebuild step.
 */
function injectShim(html) {
  if (html.includes('/rp/boot.js')) return html
  const tag = '<script src="/rp/boot.js"></script>'
  if (html.includes('<head>')) return html.replace('<head>', `<head>\n${tag}`)
  return `${tag}\n${html}`
}

export function apply(ctx, config = {}) {
  const dataDir = config.dataDir ? path.resolve(config.dataDir) : path.join(PACKAGE_ROOT, 'data')
  const staticDir = config.staticDir ? path.resolve(config.staticDir) : path.join(PACKAGE_ROOT, 'static')
  const store = createStore(dataDir)

  if (typeof ctx.inject !== 'function') {
    console.warn('[roleplay] this harness has no optional-inject support; the Web panel stays off')
    return
  }

  ctx.inject(['webServer'], (scope) => {
    const webServer = scope?.webServer
    if (!webServer || typeof webServer.register !== 'function') {
      console.warn('[roleplay] webServer service unavailable; no routes registered')
      return () => {}
    }

    let version = '0.0.0'
    readVersion().then((value) => {
      version = value
    })

    // The API handler reads `version` lazily through this holder.
    const apiHandler = createApiHandler({
      store,
      get version() {
        return version
      },
    })
    const staticHandler = createStaticHandler({
      root: staticDir,
      urlPrefix: '/rp',
      transformIndex: injectShim,
    })

    const disposers = []
    try {
      disposers.push(
        webServer.register({
          name: 'roleplay-api',
          kind: 'prefix',
          path: '/rp/api',
          handler: apiHandler,
        }),
      )
    } catch (error) {
      console.error(`[roleplay] /rp/api route skipped: ${error?.message ?? error}`)
    }
    try {
      disposers.push(
        webServer.register({
          name: 'roleplay-static',
          kind: 'prefix',
          path: '/rp',
          handler: staticHandler,
        }),
      )
    } catch (error) {
      console.error(`[roleplay] /rp static route skipped: ${error?.message ?? error}`)
    }

    console.info(`[roleplay] routes ready: /rp/ (static: ${staticDir})`)

    return () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch (error) {
          console.warn(`[roleplay] route dispose failed: ${error?.message ?? error}`)
        }
      }
    }
  })
}
