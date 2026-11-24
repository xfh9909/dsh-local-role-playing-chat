// Browser half of the dsh-roleplay plugin.
//
// Registers two slots:
//   sidebar.panellist  -> the "角色扮演" row in the left navigation rail
//   main (keyed)       -> the full-area panel that hosts the roleplay app
//
// The panel is an iframe on /rp/ (same origin as the DSH window), so the app
// keeps its own storage, its own keys and its own theme. Exiting is a
// postMessage from the app's own back button, plus a small always-present ✕
// as a safety net for the case where the app itself fails to boot.
//
// Hand-written in the lazy-CJS bundle protocol (window.__ModuleLoader__.load
// with a factory returning cordis-plugin exports), the same stance as the
// other hand-authored client plugins: no build step, no imports from dsh
// client packages beyond React itself.
window.__ModuleLoader__.load({
  id: 'dsh-roleplay',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var PANEL_ID = 'roleplay'
    var APP_URL = '/rp/'
    var EXIT_MESSAGE = 'dsh-roleplay:exit'

    function h() {
      var args = Array.prototype.slice.call(arguments)
      var type = args.shift()
      var props = args.length && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args.shift() : null
      return require('react').createElement.apply(null, [type, props || null].concat(args))
    }

    /* Mask glyph: rounded shield with two eye holes — readable at 20px. */
    function RoleplayIcon(props) {
      var size = (props && props.size) || 20
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M4 5.6C6.6 4.5 9.2 4 12 4s5.4.5 8 1.6v5.1c0 4.3-3.6 7.4-8 9.3-4.4-1.9-8-5-8-9.3z' }),
        h('circle', { cx: 9, cy: 10.4, r: 1.25, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 15, cy: 10.4, r: 1.25, fill: 'currentColor', stroke: 'none' }),
      )
    }

    function closePanel(ctx) {
      try {
        if (ctx && ctx.layout && typeof ctx.layout.selectPanel === 'function') {
          ctx.layout.selectPanel(null)
          return
        }
      } catch (error) {
        console.error('[roleplay] layout.selectPanel failed:', error)
      }
      // Last resort: the row can always be toggled from the rail, but say why
      // the ✕ did nothing instead of failing silently.
      console.warn('[roleplay] layout service unavailable; pick another panel in the sidebar')
    }

    function RoleplayPanelFactory(ctx) {
      return function RoleplayPanel() {
        var React = require('react')

        React.useEffect(function () {
          function onMessage(event) {
            var data = event && event.data
            if (!data || typeof data !== 'object') return
            if (data.type === EXIT_MESSAGE) closePanel(ctx)
          }
          window.addEventListener('message', onMessage)
          return function () {
            window.removeEventListener('message', onMessage)
          }
        }, [])

        return h(
          'div',
          {
            style: {
              position: 'relative',
              width: '100%',
              height: '100%',
              minHeight: 0,
              background: 'var(--dsw-alias-bg-base, #ffffff)',
            },
          },
          h('iframe', {
            src: APP_URL,
            title: '角色扮演',
            allow: 'clipboard-read; clipboard-write; fullscreen',
            style: {
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              border: '0',
              display: 'block',
              background: 'var(--dsw-alias-bg-base, #ffffff)',
            },
          }),
          h(
            'button',
            {
              type: 'button',
              title: '退出角色扮演（回到对话）',
              'aria-label': '退出角色扮演',
              onClick: function () {
                closePanel(ctx)
              },
              style: {
                position: 'absolute',
                top: '8px',
                right: '10px',
                zIndex: 2,
                width: '26px',
                height: '26px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
                border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12))',
                borderRadius: '8px',
                background: 'var(--dsw-alias-bg-overlay, rgba(255,255,255,.86))',
                color: 'var(--dsw-alias-label-tertiary, #666)',
                fontSize: '14px',
                lineHeight: 1,
                cursor: 'pointer',
                opacity: '0.45',
                transition: 'opacity .15s ease',
              },
              onMouseEnter: function (event) {
                event.currentTarget.style.opacity = '1'
              },
              onMouseLeave: function (event) {
                event.currentTarget.style.opacity = '0.45'
              },
            },
            '✕',
          ),
        )
      }
    }

    function apply(ctx) {
      if (typeof ctx.inject !== 'function') {
        console.warn('[roleplay] client bundle needs cordis optional inject; panel stays off')
        return
      }

      // `slots` is the only hard requirement. `layout` is reached through the
      // plugin context at click time, inside a try/catch, because a disposed
      // generation can outlive one click during HMR.
      ctx.inject(['slots'], function (scope) {
        var slots = scope.slots
        var Panel = RoleplayPanelFactory(ctx)

        // `main` is a root-scoped keyed slot: the key is what the sidebar row
        // selects and what ctx.layout.selectPanel(id) validates against.
        slots.inject('main', function* () {
          yield slots.register({ name: 'main', key: PANEL_ID }, Panel)
        })

        // The rail row. Sidebar clicks resolve this id against `main`; the
        // label doubles as the visible text, the accessible name and the
        // collapsed-rail tooltip.
        slots.inject('sidebar.panellist', function* () {
          yield slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 40,
              label: function () {
                return '角色扮演'
              },
            },
            RoleplayIcon,
          )
        })
      })
    }

    exports.apply = apply
    // Optional dependencies are taken through ctx.inject above.
    exports.inject = []
    exports.PANEL_ID = PANEL_ID
    return module.exports
  },
})
