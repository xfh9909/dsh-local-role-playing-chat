import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BOOT = path.resolve(HERE, '..', 'static', 'boot.js')
const source = await fsp.readFile(BOOT, 'utf8')

function createElement(tag) {
  const element = {
    tag,
    id: '',
    type: '',
    title: '',
    textContent: '',
    style: {},
    children: [],
    listeners: {},
    attrs: {},
    classList: {
      set: new Set(),
      add(name) {
        this.set.add(name)
      },
      remove(name) {
        this.set.delete(name)
      },
      toggle(name, on) {
        if (on === undefined) {
          this.set.has(name) ? this.set.delete(name) : this.set.add(name)
        } else if (on) {
          this.set.add(name)
        } else {
          this.set.delete(name)
        }
        return this.set.has(name)
      },
      contains(name) {
        return this.set.has(name)
      },
    },
    appendChild(child) {
      this.children.push(child)
      return child
    },
    addEventListener(type, handler) {
      ;(this.listeners[type] = this.listeners[type] || []).push(handler)
    },
    setAttribute(name, value) {
      this.attrs[name] = value
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name)
    },
    closest() {
      return null
    },
  }
  return element
}

/**
 * Run boot.js against a minimal fake browser. `embed` decides whether the
 * script believes it is inside an iframe (window.top !== window.self).
 */
function run({ embed = false, raw = new Map(), hostDark = false } = {}) {
  const storage = {
    getItem: (key) => (raw.has(key) ? raw.get(key) : null),
    setItem: (key, value) => raw.set(key, String(value)),
    removeItem: (key) => raw.delete(key),
    key: (index) => [...raw.keys()][index] ?? null,
    get length() {
      return raw.size
    },
  }

  const header = createElement('header')
  const back = createElement('button')
  const head = createElement('head')
  const html = createElement('html')
  const body = createElement('body')
  if (hostDark) body.setAttribute('data-ds-dark-theme', '')

  const fetchCalls = []
  const messages = []

  const document = {
    readyState: 'complete',
    head,
    documentElement: html,
    body,
    getElementById: (id) => {
      if (id === 'role-back') return back
      if (id === 'rp-exit') return header.children.find((child) => child.id === 'rp-exit') || null
      if (id === 'rp-embed-style') return head.children.find((child) => child.id === 'rp-embed-style') || null
      return null
    },
    querySelector: (selector) => (selector === '#role-main header' ? header : null),
    createElement: (tag) => createElement(tag),
    addEventListener() {},
  }

  const window = {
    localStorage: storage,
    indexedDB: { open: (...args) => ({ args }) },
    fetch: (input) => {
      fetchCalls.push(typeof input === 'string' ? input : input.url)
      return Promise.resolve({ ok: true })
    },
    parent: {
      document,
      getComputedStyle: () => ({ fontFamily: 'Host Sans' }),
      postMessage: (payload) => messages.push(payload),
    },
    top: embed ? { marker: true } : null,
    document,
    console: { log() {}, warn() {}, error() {} },
    getComputedStyle: () => ({ fontFamily: 'Host Sans' }),
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
    setTimeout,
    // No MutationObserver in the sandbox: watchHostTheme() exits early.
  })
  context.globalThis = context
  vm.runInContext(source, context, { filename: 'boot.js' })

  return { window, document, raw, header, back, head, body, html, messages, fetchCalls }
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

  it('hides the app’s own back button and mounts one exit button in the header', () => {
    const { back, header, head } = run({ embed: true })
    assert.equal(back.style.display, 'none', 'left-hand ← removed from the panel')
    const exit = header.children.find((child) => child.id === 'rp-exit')
    assert.ok(exit, 'exit button appended to the role header')
    assert.equal(exit.textContent, '回到对话')
    assert.equal(exit.title, '退出角色扮演，回到 DSH 的对话')
    assert.ok(head.children.some((child) => child.id === 'rp-embed-style'), 'embed stylesheet injected')
  })

  it('posts the exit message when the header button is clicked', () => {
    const { header, messages } = run({ embed: true })
    const exit = header.children.find((child) => child.id === 'rp-exit')
    let prevented = false
    exit.listeners.click[0]({
      preventDefault() {
        prevented = true
      },
    })
    assert.equal(prevented, true)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].type, 'dsh-roleplay:exit')
  })

  it('follows the host color scheme', () => {
    const light = run({ embed: true, hostDark: false })
    assert.equal(light.body.classList.contains('dark'), false)
    assert.equal(light.body.style.fontFamily, 'Host Sans')

    const dark = run({ embed: true, hostDark: true })
    assert.equal(dark.body.classList.contains('dark'), true)
  })

  it('leaves the host document alone when standalone', () => {
    const { header, head, body } = run({ embed: false })
    assert.equal(header.children.length, 0, 'no exit button outside the panel')
    assert.equal(head.children.length, 0, 'no embed stylesheet outside the panel')
    assert.equal(body.style.fontFamily, undefined, 'host theme not applied')
  })
})
