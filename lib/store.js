/**
 * Small JSON file store for plugin settings and migration staging.
 *
 * Everything lives under the package's own `data/` directory, which is
 * gitignored: settings carry optional API keys, and backups are user data.
 * Writes go through a temp file + rename so a crash never leaves a half
 * written settings.json behind.
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'

export const DEFAULT_SETTINGS = {
  /** Optional server-side keys. The app's own settings screen wins when filled. */
  keys: {},
  /** Turns the /rp/api/migrate staging endpoint on/off. */
  migrateEnabled: true,
  /** Body cap for /rp/api/chat (the app sends whole conversations). */
  maxBodyMb: 64,
  /** First-byte wait on the upstream provider. */
  upstreamTimeoutMs: 30 * 60 * 1000,
  /** Set once a migration through the bridge completed; informational only. */
  migratedAt: null,
}

async function readJson(file, fallback) {
  try {
    const text = await fsp.readFile(file, 'utf8')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      console.warn(`[roleplay] ${path.basename(file)} unreadable, using defaults: ${error.message}`)
    }
    return fallback
  }
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fsp.rename(tmp, file)
}

export function createStore(dataDir) {
  const settingsFile = path.join(dataDir, 'settings.json')
  const migrateDir = path.join(dataDir, 'migrate')
  const backupDir = path.join(dataDir, 'backups')
  let cache = null

  async function settings() {
    if (cache) return cache
    const stored = await readJson(settingsFile, {})
    cache = { ...DEFAULT_SETTINGS, ...stored }
    if (!cache.keys || typeof cache.keys !== 'object') cache.keys = {}
    return cache
  }

  async function patchSettings(patch) {
    const current = await settings()
    const next = { ...current }
    for (const key of Object.keys(patch || {})) {
      if (key === 'keys') {
        next.keys = { ...current.keys, ...(patch.keys || {}) }
        for (const name of Object.keys(next.keys)) {
          if (!String(next.keys[name] || '').trim()) delete next.keys[name]
        }
      } else if (key in DEFAULT_SETTINGS) {
        next[key] = patch[key]
      }
    }
    cache = next
    await writeJson(settingsFile, next)
    return next
  }

  /** Stage an exported app backup so the /rp/ page can pick it up. */
  async function stageMigration(payload, origin) {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    await fsp.mkdir(migrateDir, { recursive: true })
    await writeJson(path.join(migrateDir, `${id}.json`), {
      id,
      at: new Date().toISOString(),
      origin: String(origin || ''),
      payload,
    })
    await markMigrated()
    return id
  }

  async function listMigrations() {
    let names = []
    try {
      names = await fsp.readdir(migrateDir)
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw error
    }
    const out = []
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      const meta = await readJson(path.join(migrateDir, name), null)
      if (!meta) continue
      const stats = await fsp.stat(path.join(migrateDir, name)).catch(() => null)
      out.push({
        id: meta.id || name.replace(/\.json$/, ''),
        at: meta.at || null,
        origin: meta.origin || '',
        bytes: stats ? stats.size : 0,
      })
    }
    return out.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
  }

  async function readMigration(id) {
    if (!/^[a-z0-9-]{4,64}$/i.test(String(id || ''))) throw new Error('bad migration id')
    return readJson(path.join(migrateDir, `${id}.json`), null)
  }

  async function dropMigration(id) {
    if (!/^[a-z0-9-]{4,64}$/i.test(String(id || ''))) throw new Error('bad migration id')
    await fsp.rm(path.join(migrateDir, `${id}.json`), { force: true })
  }

  /** Keep a timestamped copy of whatever data is about to be replaced. */
  async function writeBackup(name, payload) {
    await fsp.mkdir(backupDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const safe = String(name || 'backup').replace(/[^\w.-]+/g, '_').slice(0, 40)
    const file = path.join(backupDir, `${stamp}-${safe}.json`)
    await writeJson(file, payload)
    return path.basename(file)
  }

  async function listBackups() {
    try {
      const names = await fsp.readdir(backupDir)
      return names.filter((n) => n.endsWith('.json')).sort().reverse()
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw error
    }
  }

  async function markMigrated() {
    const current = await settings()
    if (current.migratedAt) return
    await patchSettings({ migratedAt: new Date().toISOString() })
  }

  function paths() {
    return { dataDir, settingsFile, migrateDir, backupDir }
  }

  return {
    settings,
    patchSettings,
    stageMigration,
    listMigrations,
    readMigration,
    dropMigration,
    writeBackup,
    listBackups,
    markMigrated,
    paths,
  }
}
