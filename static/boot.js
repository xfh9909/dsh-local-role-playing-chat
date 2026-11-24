/* ============================================================
 * boot.js —— 插件的浏览器适配层（由服务端注入到 /rp/index.html 的 <head>）
 *
 * 在应用自己的脚本之前执行，做四件事：
 *
 *   1. 存储隔离：localStorage 的所有键加 `rp_` 前缀，IndexedDB 的
 *      `dsh_chat_db` 改名为 `rp_chat_db`。DSH 的对话数据与角色扮演数据
 *      于是共用一个 origin 却互不相遇。
 *   2. 接口改道：应用里所有 `/api/*` 请求（status / chat / migrate）
 *      重写到 `/rp/api/*`，后端由插件提供，应用源码一行不用改。
 *   3. 嵌入模式：iframe 里直接进角色扮演界面（预置 ds_mode=role），
 *      收掉应用自带的「← 返回聊天模式」，在标题栏最右放一个同风格的
 *      「回到对话」——点了给父页面发 postMessage，由插件切回 DSH 对话。
 *   4. 风格统一：明暗跟随宿主主题，字体族跟随宿主正文。
 *
 * 独立打开（file:// 或自带服务）时 window.parent === window，第 3、4 条
 * 整个跳过，行为和改造前完全一样。
 * ============================================================ */
(function () {
  'use strict';

  var EMBED = (function () {
    try { return window.top !== window.self; } catch (e) { return true; }
  })();

  /* ---------------- 1. localStorage 前缀隔离 ---------------- */
  var LS_PREFIX = 'rp_';
  try {
    var rawLS = window.localStorage;
    var prefixedKeys = function () {
      var out = [];
      try {
        for (var i = 0; i < rawLS.length; i++) {
          var k = rawLS.key(i);
          if (k && k.indexOf(LS_PREFIX) === 0) out.push(k.slice(LS_PREFIX.length));
        }
      } catch (e) {}
      return out;
    };
    var shimmed = {
      getItem: function (k) { try { return rawLS.getItem(LS_PREFIX + k); } catch (e) { return null; } },
      setItem: function (k, v) { try { rawLS.setItem(LS_PREFIX + k, String(v)); } catch (e) { throw e; } },
      removeItem: function (k) { try { rawLS.removeItem(LS_PREFIX + k); } catch (e) {} },
      clear: function () { prefixedKeys().forEach(function (k) { try { rawLS.removeItem(LS_PREFIX + k); } catch (e) {} }); },
      key: function (i) { var keys = prefixedKeys(); return i >= 0 && i < keys.length ? keys[i] : null; }
    };
    Object.defineProperty(shimmed, 'length', { get: function () { return prefixedKeys().length; } });
    Object.defineProperty(window, 'localStorage', { configurable: true, get: function () { return shimmed; } });
  } catch (e) {
    console.warn('[rp-boot] localStorage 隔离失败，沿用原存储：', e && e.message);
  }

  /* ---------------- 1b. IndexedDB 库名隔离 ---------------- */
  try {
    var rawOpen = window.indexedDB && window.indexedDB.open;
    if (rawOpen) {
      window.indexedDB.open = function (name) {
        var args = Array.prototype.slice.call(arguments);
        if (name === 'dsh_chat_db') args[0] = 'rp_chat_db';
        return rawOpen.apply(window.indexedDB, args);
      };
    }
  } catch (e) {
    console.warn('[rp-boot] IndexedDB 隔离失败：', e && e.message);
  }

  /* ---------------- 2. /api/* -> /rp/api/* ---------------- */
  try {
    var rawFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = null;
      if (typeof input === 'string') url = input;
      else if (input && typeof input.url === 'string') url = input.url;
      if (url && (url === '/api' || url.indexOf('/api/') === 0)) {
        var next = '/rp' + url;
        if (typeof input === 'string') input = next;
        else input = new Request(next, input);
      }
      return rawFetch(input, init);
    };
  } catch (e) {
    console.warn('[rp-boot] fetch 改道失败：', e && e.message);
  }

  if (!EMBED) return;

  /* ---------------- 3. 嵌入模式 ---------------- */

  /* 应用启动时若 ds_mode=role，会自动进入角色扮演界面并恢复上次角色/会话 */
  try { window.localStorage.setItem('ds_mode', 'role'); } catch (e) {}

  var EXIT_LABEL = '回到对话';
  var EXIT_TITLE = '退出角色扮演，回到 DSH 的对话';

  function postExit() {
    try { window.parent.postMessage({ type: 'dsh-roleplay:exit' }, '*'); } catch (e) {}
  }

  /* 标题栏最右的退出入口。用应用自己的 header button 规则（style.css 的
     `header select, header button`），不另造样式，所以看起来和旁边那些
     「📖 世界书」「🎨 聊天设置」是同一批控件。 */
  function mountExitButton() {
    if (document.getElementById('rp-exit')) return true;
    var header = document.querySelector('#role-main header');
    if (!header) return false;
    var button = document.createElement('button');
    button.id = 'rp-exit';
    button.type = 'button';
    button.title = EXIT_TITLE;
    button.textContent = EXIT_LABEL;
    button.addEventListener('click', function (event) {
      event.preventDefault();
      postExit();
    });
    header.appendChild(button);
    return true;
  }

  function paintEmbedChrome() {
    // 应用自带的「← 返回聊天模式」在面板里指向的是应用内部的另一个模式，
    // 不是 DSH 对话，容易误解成同一个东西。收掉，出口只留标题栏那一个。
    var back = document.getElementById('role-back');
    if (back) back.style.display = 'none';

    mountExitButton();

    var style = document.createElement('style');
    style.id = 'rp-embed-style';
    style.textContent = [
      'html.rp-embed, html.rp-embed body { height: 100%; overflow: hidden; }',
      '#role-app, #app { height: 100vh; }',
      '#role-main header { padding-right: 10px; }',
      '#role-back { display: none !important; }',
      /* DSH already spends 280px on its own rail; keep the app's character
         list from squeezing the conversation on narrow windows. */
      '@media (max-width: 780px) { html.rp-embed #role-sidebar { width: 180px; } }',
      /* 与应用自己的滚动条配色一致，嵌进面板时不抢眼 */
      '#role-list, #session-list, #role-chat-body, .rh-list { scrollbar-width: thin; }'
    ].join('\n');
    if (!document.getElementById('rp-embed-style')) document.head.appendChild(style);
    document.documentElement.classList.add('rp-embed');
  }

  /* ---------------- 4. 跟随宿主主题 ---------------- */

  function hostDocument() {
    try {
      var doc = window.parent && window.parent.document;
      return doc && doc.body ? doc : null;
    } catch (e) {
      return null;
    }
  }

  function applyHostTheme() {
    var doc = hostDocument();
    if (!doc) return;
    try {
      // The shell marks dark mode on <body> (data-ds-dark-theme) and paints
      // the palette as CSS variables; the app here only knows body.dark.
      var dark = doc.body.hasAttribute('data-ds-dark-theme') ||
        doc.documentElement.hasAttribute('data-ds-dark-theme');
      document.body.classList.toggle('dark', !!dark);

      var computed = window.parent.getComputedStyle(doc.body);
      var fontFamily = computed.fontFamily;
      if (fontFamily) document.body.style.fontFamily = fontFamily;
    } catch (e) {
      /* cross-document reads can throw under stricter embedders; keep app defaults */
    }
  }

  function watchHostTheme() {
    var doc = hostDocument();
    if (!doc || typeof MutationObserver !== 'function') return;
    try {
      new MutationObserver(applyHostTheme).observe(doc.body, {
        attributes: true,
        attributeFilter: ['data-ds-dark-theme', 'class', 'style']
      });
    } catch (e) {}
  }

  function boot() {
    paintEmbedChrome();
    applyHostTheme();
    watchHostTheme();
    // The header exists by DOMContentLoaded; the role view itself renders later,
    // so one deferred retry covers a slow first paint.
    if (!document.getElementById('rp-exit')) setTimeout(mountExitButton, 400);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
