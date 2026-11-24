// Headless probe for the roleplay page, driven over the Chrome DevTools
// Protocol. Uses the Edge/Chrome already installed on this machine, so no
// browser download is needed.
//
//   node scripts/probe-ui.mjs [url]            # boot state only
//   node scripts/probe-ui.mjs [url] --empty    # click 总结 against an empty library
//   node scripts/probe-ui.mjs                  # seeds one role + one session, then clicks it
//
// Dialogs are auto-dismissed so an alert() cannot hang the evaluate call.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const url = process.argv[2] || 'http://127.0.0.1:52210/rp/'
const PORT = 9334
const profile = mkdtempSync(path.join(os.tmpdir(), 'rp-summary-'))

const child = spawn(
  EDGE,
  ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForEndpoint() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (res.ok) return
    } catch {}
    await sleep(250)
  }
  throw new Error('devtools endpoint never came up')
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.dialogs = []
    this.consoleErrors = []
    this.exceptions = []
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
        return
      }
      if (msg.method === 'Page.javascriptDialogOpening') {
        this.dialogs.push(`${msg.params.type}: ${msg.params.message}`)
        this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {})
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) {
      return { __error: result.exceptionDetails.exception?.description || result.exceptionDetails.text }
    }
    return result.result.value
  }
}

const SEED = {
  __app: 'dsh-roleplay-backup',
  __version: 1,
  roleSessions: {
    r_probe: {
      list: [
        {
          id: 's_probe',
          title: '探针会话',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [
            { role: 'user', content: '你好', at: Date.now() },
            { role: 'assistant', content: '你好呀。', at: Date.now() },
          ],
          summary: '',
          timeline: [],
          keyMems: [],
        },
      ],
      activeId: 's_probe',
    },
  },
  local: {
    ds_roles: JSON.stringify([
      {
        id: 'r_probe',
        name: '探针君',
        avatar: '🧪',
        color: '#4a6cf7',
        desc: '测试用角色',
        personality: '安静',
        greeting: '你好',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]),
    ds_last_view: JSON.stringify({ roleId: 'r_probe', sid: 's_probe' }),
  },
}

async function main() {
  await waitForEndpoint()
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  const cdp = new Cdp(ws)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  async function waitReady() {
    for (let i = 0; i < 60; i++) {
      const ready = await cdp.eval('document.readyState === "complete" && !!window.App && !!App.ru')
      if (ready === true) return
      await sleep(200)
    }
    throw new Error('app never became ready')
  }
  await waitReady()

  // 1. Seed through the app's own restore path.
  if (!process.argv.includes('--empty')) {
    const seeded = await cdp.eval(`new Promise((resolve) => {
      App.roleSessions.importAll(${JSON.stringify(SEED)}, (ok, msg) => resolve({ ok, msg }));
    })`)
    console.log('SEED', JSON.stringify(seeded))

    // 2. Reload so the runtime reads the fresh storage the way a user would.
    await cdp.send('Page.reload', { ignoreCache: false })
    await sleep(1500)
    await waitReady()
  } else {
    console.log('SEED skipped (--empty)')
  }

  // 3. Enter role mode.
  const entered = await cdp.eval(`(() => {
    const st = App.ru.dom.state;
    App.ru.list.showRoleMode(true);
    return { role: st.role && st.role.name, session: st.session && st.session.id };
  })()`)
  await sleep(400)
  console.log('ENTER', JSON.stringify(entered))

  const before = await cdp.eval(`(() => {
    const m = document.getElementById('summary-modal');
    return { modalClass: m ? m.className : 'no-modal', display: m ? getComputedStyle(m).display : 'n/a' };
  })()`)
  console.log('BEFORE', JSON.stringify(before))

  const clicked = await cdp.eval(`(() => {
    const btn = document.getElementById('role-summary');
    if (!btn) return 'no-button';
    const r = btn.getBoundingClientRect();
    btn.click();
    return { clicked: true, rect: { w: Math.round(r.width), h: Math.round(r.height) } };
  })()`)
  await sleep(600)
  console.log('CLICK', JSON.stringify(clicked))

  const after = await cdp.eval(`(() => {
    const m = document.getElementById('summary-modal');
    const t = document.getElementById('summary-text');
    const info = document.getElementById('summary-info');
    const toast = document.querySelector('.toast');
    return {
      modalClass: m ? m.className : 'no-modal',
      display: m ? getComputedStyle(m).display : 'n/a',
      visible: m ? getComputedStyle(m).visibility : 'n/a',
      summaryText: t ? t.value : null,
      info: info ? info.textContent.trim().slice(0, 80) : null,
      toast: toast ? toast.textContent.trim() : null,
    };
  })()`)
  console.log('AFTER', JSON.stringify(after, null, 2))

  if (cdp.dialogs.length) console.log('DIALOGS\n' + cdp.dialogs.join('\n'))
  if (cdp.exceptions.length) console.log('EXCEPTIONS\n' + cdp.exceptions.slice(0, 5).join('\n'))
  if (cdp.consoleErrors.length) console.log('CONSOLE ERRORS\n' + cdp.consoleErrors.slice(0, 5).join('\n'))

  ws.close()
}

main()
  .catch((error) => {
    console.error('PROBE FAILED:', error.message)
    process.exitCode = 1
  })
  .finally(async () => {
    child.kill()
    await sleep(300)
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {}
  })
