#!/usr/bin/env node
/**
 * Release gate: every file the Host, the client loader and the Plugin Manager
 * will look for must exist and parse. Run by CI and by hand before publishing.
 *
 *   node scripts/check.mjs
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const problems = []
const notes = []

async function read(file) {
  return fsp.readFile(path.join(ROOT, file), 'utf8')
}

async function mustExist(file) {
  try {
    const stat = await fsp.stat(path.join(ROOT, file))
    return stat
  } catch {
    problems.push(`missing file: ${file}`)
    return null
  }
}

async function checkManifest() {
  const text = await read('package.json')
  const pkg = JSON.parse(text)
  if (pkg.type !== 'module') problems.push('package.json must set "type": "module"')
  if (!pkg.dsh?.bundle?.patch) problems.push('package.json is missing dsh.bundle.patch')
  if (pkg.dsh?.client?.platform !== 'web') problems.push('dsh.client.platform should be "web"')
  for (const entry of ['lib/index.js', 'client/index.js', 'cordis.patch.yml']) {
    if (!pkg.files?.some((f) => f === entry || entry.startsWith(f))) {
      problems.push(`package.json files[] does not ship ${entry}`)
    }
  }
  if (!pkg.exports?.['./client']) problems.push('package.json exports is missing ./client')
  if (!pkg.exports?.['./icon']) problems.push('package.json exports is missing ./icon')
  if (!pkg.exports?.['./locale/*.json']) problems.push('package.json exports is missing ./locale/*.json')
  notes.push(`version ${pkg.version}`)
  return pkg
}

async function checkPatch() {
  const text = await read('cordis.patch.yml')
  if (!/-\s*insert:/.test(text)) problems.push('cordis.patch.yml has no insert list')
  if (!/name:\s*'dsh-roleplay'/.test(text)) problems.push("cordis.patch.yml does not insert name 'dsh-roleplay'")
}

async function checkStatic() {
  for (const file of ['static/index.html', 'static/app.js', 'static/app.css', 'static/boot.js', 'static/vendor/marked.global.js']) {
    const stat = await mustExist(file)
    if (stat) notes.push(`${file} ${(stat.size / 1024).toFixed(1)} KB`)
  }
  const html = await read('static/index.html').catch(() => '')
  if (html && !html.includes('app.js')) problems.push('static/index.html does not reference app.js')
}

async function checkLocales() {
  for (const file of ['locale/en.json', 'locale/zh.json']) {
    const text = await read(file).catch(() => '')
    if (!text) {
      problems.push(`missing locale: ${file}`)
      continue
    }
    try {
      const json = JSON.parse(text)
      if (!json.meta?.title) problems.push(`${file} has no meta.title`)
      if (!json.meta?.description) problems.push(`${file} has no meta.description`)
      if (json.meta?.detail && !(await fsp.stat(path.join(ROOT, json.meta.detail)).catch(() => null))) {
        problems.push(`${file} points meta.detail at a missing file: ${json.meta.detail}`)
      }
    } catch (error) {
      problems.push(`${file} is not valid JSON: ${error.message}`)
    }
  }
}

async function checkSyntax(files) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  for (const file of files) {
    try {
      await run(process.execPath, ['--check', path.join(ROOT, file)])
    } catch (error) {
      problems.push(`syntax error in ${file}: ${(error.stderr || error.message).split('\n')[0]}`)
    }
  }
}

await mustExist('README.md')
await mustExist('LICENSE')
await mustExist('icon.svg')
await mustExist('docs/DETAIL.md')

const pkg = await checkManifest()
await checkPatch()
await checkStatic()
await checkLocales()
await checkSyntax(['lib/index.js', 'lib/api.js', 'lib/static.js', 'lib/store.js', 'lib/providers.js', 'client/index.js', 'static/boot.js'])

console.log(`dsh-roleplay check — ${pkg.version}`)
for (const note of notes) console.log(`  · ${note}`)
if (problems.length) {
  console.error('\nFAILED:')
  for (const problem of problems) console.error(`  ✗ ${problem}`)
  process.exit(1)
}
console.log('\n✓ all checks passed')
