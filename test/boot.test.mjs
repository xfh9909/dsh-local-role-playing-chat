import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BOOT = path.resolve(HERE, '..', 'static', 'boot.js')
const source = await fsp.readFile(BOOT, 'utf8')

/**
 * Run boot.js against a minimal fake browser. `embed` decides whether the
 * script believes it is inside an iframe (window.top !== window.self).
 */
function run({ embed = false, raw = new Map(), fetchCalls = [] } = {}) {
  const storage = {
    getItem: (key) => (raw.has(key) ? raw.get(key) : null),
    setItem: (key, value) => raw.set(key, String(value)),
    removeItem: (key) => raw.delete(key),
    key: (index) => [...raw.keys()][index] ?? null,
    get length() {
      return raw.size
    },
  }

  const listeners = []
  const messages = []
  const document = {
    readyState: 'complete',
    head: { appendChild() {} },
    documentElement: { classList: { add() {} } },
    getElementById: () => null,
    createElement: () => ({ textContent: '' }),
    addEventListener: (type, handler, capture) => listeners.push({ type, handler, capture }),
  }

  const window = {
    localStorage: storage,
    indexedDB: { open: (...args) => ({ args }) },
    fetch: (input) => {
      fetchCalls.push(typeof input === 'string' ? input : input.url)
      return Promise.resolve({ ok: true })
    },
    parent: { postMessage: (payload) => messages.push(payload) },
    top: embed ? {} : null,
    document,
    console: { log() {}, warn() {}, error() {} },
    Request: class Request {
      constructor(url) {
        this.url = url
      }
    },
  }
  window.self = window
  if (!embed) window.top = window

  const context = vm.createContext({
    window,
    document,
    localStorage: storage,
    indexedDB: window.indexedDB,
    fetch: window.fetch,
    Request: window.Request,
    console: window.console,
    Object,
    Array,
    Error,
    String,
  })
  context.globalThis = context
  vm.runInContext(source, context, { filename: 'boot.js' })

  return { window, document, raw, listeners, messages, fetchCalls }
}

describe('boot shim — storage isolation', () => {
  it('prefixes every localStorage key with rp_', () => {
    const { window, raw } = run()
    window.localStorage.setItem('ds_mode', 'role')
    assert.equal(raw.get('rp_ds_mode'), 'role')
    assert.equal(window.localStorage.getItem('ds_mode'), 'role')
    assert.equal(raw.has('ds_mode'), false, 'no bare key written')
    assert.equal(window.localStorage.length, 1)
    assert.equal(window.localStorage.key(0), 'ds_mode')
  })

  it('keeps foreign keys out of length/key enumeration', () => {
    const raw = new Map([['unrelated', 'x']])
    const { window } = run({ raw })
    window.localStorage.setItem('ds_roles', '[]')
    assert.equal(window.localStorage.length, 1, 'only prefixed keys count')
    assert.equal(window.localStorage.key(0), 'ds_roles')
    assert.equal(raw.get('unrelated'), 'x')
  })

  it('clear only removes prefixed keys', () => {
    const raw = new Map([['unrelated', 'x']])
    const { window } = run({ raw })
    window.localStorage.setItem('a', '1')
    window.localStorage.setItem('b', '2')
    window.localStorage.clear()
    assert.equal(window.localStorage.length, 0)
    assert.equal(raw.get('unrelated'), 'x', 'host data survives clear()')
  })

  it('renames the app database and leaves other databases alone', () => {
    const { window } = run()
    assert.deepEqual(window.indexedDB.open('dsh_chat_db', 1).args, ['rp_chat_db', 1])
    assert.deepEqual(window.indexedDB.open('other_db', 2).args, ['other_db', 2])
  })
})

describe('boot shim — request rewrite', () => {
  it('routes /api/* through /rp/api/*', async () => {
    const { window, fetchCalls } = run()
    await window.fetch('/api/status')
    await window.fetch('/api/chat')
    assert.deepEqual(fetchCalls, ['/rp/api/status', '/rp/api/chat'])
  })

  it('leaves other URLs and absolute endpoints untouched', async () => {
    const { window, fetchCalls } = run()
    await window.fetch('/rp/app.js')
    await window.fetch('https://api.deepseek.com/chat/completions')
    await window.fetch('/apiary')
    assert.deepEqual(fetchCalls, ['/rp/app.js', 'https://api.deepseek.com/chat/completions', '/apiary'])
  })

  it('rewrites Request objects too', async () => {
    const { window, fetchCalls } = run()
    await window.fetch(new window.Request('/api/migrate'))
    assert.deepEqual(fetchCalls, ['/rp/api/migrate'])
  })
})

describe('boot shim — embed mode', () => {
  it('pre-selects roleplay mode inside the panel', () => {
    const { raw } = run({ embed: true })
    assert.equal(raw.get('rp_ds_mode'), 'role')
  })

  it('does nothing to the mode when opened standalone', () => {
    const { raw } = run({ embed: false })
    assert.equal(raw.has('rp_ds_mode'), false)
  })

  it('intercepts the back button and posts the exit message', () => {
    const { listeners, messages } = run({ embed: true })
    const click = listeners.find((l) => l.type === 'click' && l.capture)
    assert.ok(click, 'capture-phase click listener registered')

    let stopped = false
    let prevented = false
    const back = {
      closest: (selector) => (selector === '#role-back' ? back : null),
    }
    click.handler({
      target: back,
      preventDefault: () => {
        prevented = true
      },
      stopImmediatePropagation: () => {
        stopped = true
      },
    })
    assert.equal(prevented, true)
    assert.equal(stopped, true)
    // Cross-realm object: compare fields, not prototypes.
    assert.equal(messages.length, 1)
    assert.equal(messages[0].type, 'dsh-roleplay:exit')
  })

  it('ignores clicks elsewhere', () => {
    const { listeners, messages } = run({ embed: true })
    const click = listeners.find((l) => l.type === 'click' && l.capture)
    click.handler({ target: { closest: () => null }, preventDefault() {}, stopImmediatePropagation() {} })
    assert.deepEqual(messages, [])
  })
})
