/* ============================================================
 * boot.js —— 插件的浏览器适配层（由服务端注入到 /rp/index.html 的 <head>）
 *
 * 它做四件事，全部在应用自己的脚本之前执行：
 *
 *   1. 存储隔离：localStorage 的所有键加 `rp_` 前缀，IndexedDB 的
 *      `dsh_chat_db` 改名为 `rp_chat_db`。DSH 的对话数据与角色扮演数据
 *      于是共用一个 origin 却互不相遇。
 *   2. 接口改道：应用里所有 `/api/*` 请求（status / chat / migrate）
 *      重写到 `/rp/api/*`，后端由插件提供，应用源码一行不用改。
 *   3. 嵌入模式：在 iframe 里直接进角色扮演界面（预置 ds_mode=role），
 *      并把左上角「← 返回聊天模式」改成「退出角色扮演」——点它给父页面
 *      发 postMessage，由插件面板切回 DSH 对话。
 *   4. 独立的 file:// 页面行为完全不变：没有 window.parent 就什么都不做。
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
      var patchedOpen = function (name) {
        var args = Array.prototype.slice.call(arguments);
        if (name === 'dsh_chat_db') args[0] = 'rp_chat_db';
        return rawOpen.apply(window.indexedDB, args);
      };
      window.indexedDB.open = patchedOpen;
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

  /* ---------------- 3. 嵌入模式 ---------------- */
  if (!EMBED) return;

  /* 应用启动时若 ds_mode=role，会自动进入角色扮演界面并恢复上次角色/会话 */
  try { window.localStorage.setItem('ds_mode', 'role'); } catch (e) {}

  function paintEmbedChrome() {
    // 嵌入在 DSH 面板里时不需要应用自己的「返回聊天模式」，改成退出面板。
    var back = document.getElementById('role-back');
    if (back) {
      back.setAttribute('title', '退出角色扮演，回到对话');
      back.setAttribute('aria-label', '退出角色扮演');
      back.textContent = '✕';
    }
    // 应用为独立窗口设计的内边距在面板里会显得空，收一点。
    var style = document.createElement('style');
    style.textContent = [
      'html.rp-embed body { overflow: hidden; }',
      '#role-app, #app { height: 100vh; }',
      '#role-back { font-size: 15px; }'
    ].join('\n');
    document.head.appendChild(style);
    document.documentElement.classList.add('rp-embed');
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var back = target.closest('#role-back');
    if (!back) return;
    // 捕获阶段先到，拦下应用自己绑的「回聊天模式」。
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      window.parent.postMessage({ type: 'dsh-roleplay:exit' }, '*');
    } catch (e) {}
  }, true);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', paintEmbedChrome);
  } else {
    paintEmbedChrome();
  }
})();
