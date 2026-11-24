#!/usr/bin/env node
/**
 * Copy the built roleplay app into `static/`.
 *
 * The app lives in its own repository (zero framework, esbuild). This plugin
 * ships a self-contained copy of its build output so installing the plugin
 * never needs the app checkout:
 *
 *   node scripts/sync-static.mjs                 # copy from the sibling checkout
 *   node scripts/sync-static.mjs --app <dir>     # explicit app repository path
 *   node scripts/sync-static.mjs --build         # run the app's build first
 *   node scripts/sync-static.mjs --build --app D:\x\y
 *
 * boot.js is authored here and never overwritten: the app build knows nothing
 * about it, the host injects the script tag at serve time.
 */
import { promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(HERE, '..')
const STATIC_DIR = path.join(PKG_ROOT, 'static')

const DEFAULT_APP = path.resolve(PKG_ROOT, '..', 'AAAA实用小工具合集', '破甲deep聊天')
const REQUIRED = ['index.html', 'app.js', 'app.css', 'vendor/marked.global.js']

function parseArgs(argv) {
  const out = { app: DEFAULT_APP, build: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--build') out.build = true
    else if (arg === '--app') out.app = path.resolve(argv[++i] || '')
    else if (arg.startsWith('--app=')) out.app = path.resolve(arg.slice('--app='.length))
  }
  return out
}

async function exists(file) {
  try {
    await fsp.access(file)
    return true
  } catch {
    return false
  }
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))))
  })
}

async function main() {
  const { app, build } = parseArgs(process.argv.slice(2))
  const dist = path.join(app, 'dist')

  if (!(await exists(app))) {
    console.error(`应用仓库不存在：${app}`)
    console.error('用 --app <目录> 指定角色扮演应用的位置。')
    process.exit(1)
  }

  if (build) {
    console.log('构建应用…')
    await run('node', ['tools/build.js'], app)
  }

  for (const file of REQUIRED) {
    if (!(await exists(path.join(dist, file)))) {
      console.error(`缺少 dist/${file}：先在应用仓库跑 node tools/build.js（或给本脚本加 --build）`)
      process.exit(1)
    }
  }

  await fsp.mkdir(path.join(STATIC_DIR, 'vendor'), { recursive: true })

  const copied = []
  for (const file of REQUIRED) {
    const from = path.join(dist, file)
    const to = path.join(STATIC_DIR, file)
    const data = await fsp.readFile(from)
    await fsp.writeFile(to, data)
    copied.push({ file, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex').slice(0, 16) })
  }

  const buildJson = await fsp.readFile(path.join(dist, 'build.json'), 'utf8').catch(() => '{}')
  const appMeta = JSON.parse(buildJson)

  const meta = {
    name: 'dsh-roleplay static bundle',
    app: path.basename(app),
    appVersion: appMeta.version || null,
    appBuiltAt: appMeta.builtAt || null,
    syncedAt: new Date().toISOString(),
    files: copied,
    shim: 'boot.js (author-owned, injected at serve time)',
  }
  await fsp.writeFile(path.join(STATIC_DIR, 'build.json'), JSON.stringify(meta, null, 2))

  const total = copied.reduce((sum, entry) => sum + entry.bytes, 0)
  for (const entry of copied) {
    console.log(`  ${entry.file.padEnd(28)} ${(entry.bytes / 1024).toFixed(1)} KB`)
  }
  console.log(`✓ 同步完成：${copied.length} 个文件 / ${(total / 1024).toFixed(1)} KB → ${STATIC_DIR}`)
}

main().catch((error) => {
  console.error('同步失败：', error.message || error)
  process.exit(1)
})
