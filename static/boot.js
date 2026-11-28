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
 *   4. 面板固定深色：不管宿主是亮是暗，这里始终是应用的暗色主题；
 *      字体族仍跟随宿主正文。
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

  /* ---------------- 4. 面板一律深色 ---------------- */

  /* The panel is the app, not the host: it keeps its own dark palette even
     when DSH is in light mode. Re-applied on every body class change so the
     app's own theme switch cannot flip it back mid-session. */
  function forceDark() {
    if (!document.body) return;
    if (!document.body.classList.contains('dark')) document.body.classList.add('dark');
  }

  function watchBodyTheme() {
    if (typeof MutationObserver !== 'function' || !document.body) return;
    try {
      new MutationObserver(forceDark).observe(document.body, {
        attributes: true,
        attributeFilter: ['class']
      });
    } catch (e) {}
  }

  /* Typography still follows the host so the two halves do not fight over
     font stacks; only the color scheme is pinned. */
  function applyHostTypography() {
    try {
      var doc = window.parent && window.parent.document;
      if (!doc || !doc.body) return;
      var fontFamily = window.parent.getComputedStyle(doc.body).fontFamily;
      if (fontFamily) document.body.style.fontFamily = fontFamily;
    } catch (e) {
      /* cross-document reads can throw under stricter embedders; keep app defaults */
    }
  }

  /* ---------------- 5. 旧数据导入入口 ----------------
     The app's own bridge only polls once, on a fresh load of an empty library;
     miss that window and the staged backup just sits there. This is the
     explicit door: if the plugin still holds a staged backup, show a banner and
     let the click drive importAll directly. */
  var IMPORT_DISMISS_KEY = 'ds_import_dismissed';
  var importProbing = false;

  function readStaged() {
    return fetch('/rp/api/migrate', { cache: 'no-store' })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (body) {
        if (!body || !body.data || !body.items || !body.items.length) return null;
        return { data: body.data, item: body.items[0] };
      });
  }

  function summarise(data) {
    var out = { roles: 0, chats: 0 };
    try {
      var roles = JSON.parse((data.local && data.local.ds_roles) || '[]');
      out.roles = Array.isArray(roles) ? roles.length : 0;
      var rs = data.roleSessions || {};
      for (var id in rs) {
        var list = rs[id] && rs[id].list;
        out.chats += Array.isArray(list) ? list.length : 0;
      }
    } catch (e) {}
    return out;
  }

  function dropStaged() {
    fetch('/rp/api/migrate', { method: 'DELETE' }).catch(function () {});
  }

  function showImportBanner(staged) {
    if (document.getElementById('rp-import-banner')) return;
    var summary = summarise(staged.data);
    var size = (staged.item.bytes / 1048576).toFixed(1);

    var box = document.createElement('div');
    box.id = 'rp-import-banner';
    box.style.cssText = [
      'position:fixed',
      'left:50%',
      'bottom:22px',
      'transform:translateX(-50%)',
      'z-index:2147483000',
      'box-sizing:border-box',
      'max-width:min(620px, 92vw)',
      'display:flex',
      'gap:14px',
      'align-items:flex-start',
      'padding:14px 16px',
      'border:1px solid var(--border, #2c2f37)',
      'border-radius:12px',
      'background:var(--panel, #1f2127)',
      'color:var(--text, #e6e8ec)',
      'box-shadow:0 12px 34px rgba(0,0,0,.42)',
      'font:13px/1.7 "PingFang SC","Microsoft YaHei",system-ui,sans-serif',
    ].join(';');

    var text = document.createElement('div');
    text.style.cssText = 'flex:1 1 auto;min-width:0';
    var title = document.createElement('div');
    title.style.cssText = 'font-weight:600;margin-bottom:3px';
    title.textContent = '发现旧版本的数据';
    var detail = document.createElement('div');
    detail.style.cssText = 'color:var(--muted, #8a919e)';
    detail.textContent =
      summary.roles + ' 个角色 · ' + summary.chats + ' 个会话（' + size + ' MB，来自 ' + (staged.item.origin || '旧页面') +
      '）。导入会替换当前的角色与会话。';
    text.appendChild(title);
    text.appendChild(detail);

    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;align-items:center;flex:0 0 auto';

    var go = document.createElement('button');
    go.type = 'button';
    go.textContent = '导入';
    go.style.cssText = [
      'height:30px',
      'padding:0 14px',
      'border-radius:8px',
      'border:1px solid var(--primary, #4a6cf7)',
      'background:var(--primary, #4a6cf7)',
      'color:#fff',
      'font-size:13px',
      'cursor:pointer',
    ].join(';');

    var close = document.createElement('button');
    close.type = 'button';
    close.textContent = '关闭';
    close.style.cssText = [
      'height:30px',
      'padding:0 12px',
      'border-radius:8px',
      'border:1px solid var(--border, #2c2f37)',
      'background:transparent',
      'color:var(--muted, #8a919e)',
      'font-size:13px',
      'cursor:pointer',
    ].join(';');

    go.addEventListener('click', function () {
      go.disabled = true;
      go.textContent = '导入中…';
      detail.textContent = '正在写入本地数据库，数据大的话要等一会儿…';
      var started = false;
      try {
        started = App.roleSessions.importAll(staged.data, function (ok, message) {
          if (!ok) {
            detail.textContent = '导入失败：' + (message || '未知原因');
            go.disabled = false;
            go.textContent = '重试';
            return;
          }
          dropStaged();
          detail.textContent = '导入完成：' + (message || '') + '，正在刷新…';
          setTimeout(function () {
            location.reload();
          }, 700);
        });
      } catch (error) {
        started = false;
        detail.textContent = '导入失败：' + (error && error.message);
      }
      if (!started) {
        go.disabled = false;
        go.textContent = '重试';
        if (detail.textContent.indexOf('导入失败') === -1) {
          detail.textContent = '应用还没准备好，稍后再点一次。';
        }
      }
    });

    close.addEventListener('click', function () {
      try {
        localStorage.setItem(IMPORT_DISMISS_KEY, '1');
      } catch (e) {}
      box.remove();
    });

    actions.appendChild(go);
    actions.appendChild(close);
    box.appendChild(text);
    box.appendChild(actions);
    document.body.appendChild(box);
  }

  function offerStagedImport() {
    if (importProbing) return;
    importProbing = true;
    var tries = 0;
    function attempt() {
      tries += 1;
      readStaged()
        .then(function (staged) {
          if (!staged) {
            if (tries < 15) setTimeout(attempt, 1200);
            return;
          }
          var dismissed = false;
          try {
            dismissed = localStorage.getItem(IMPORT_DISMISS_KEY) === '1';
          } catch (e) {}
          if (dismissed) return;
          showImportBanner(staged);
        })
        .catch(function () {
          if (tries < 5) setTimeout(attempt, 1500);
        });
    }
    // Wait for the app to finish booting so importAll exists when clicked.
    setTimeout(attempt, 1200);
  }

  function boot() {
    paintEmbedChrome();
    forceDark();
    watchBodyTheme();
    applyHostTypography();
    // The header exists by DOMContentLoaded; the role view itself renders later,
    // so one deferred retry covers a slow first paint.
    if (!document.getElementById('rp-exit')) setTimeout(mountExitButton, 400);
    offerStagedImport();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
