// Browser half of the dsh-roleplay plugin.
//
// Registers two slots:
//   sidebar.panellist  -> the "角色扮演" row in the left navigation rail
//   main (keyed)       -> the full-area panel that hosts the roleplay app
//
// The panel is an iframe on /rp/ (same origin as the DSH window), so the app
// keeps its own storage, its own keys and its own theme. Exiting is the app's
// own job: its header carries a plain "回到对话" button (added by the injected
// boot shim) that posts a message back here, and the layout switches to the
// Conversation. No floating close chrome: the panel is the page.
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

    /**
     * Build the panel component around one exit callback.
     *
     * `layout.selectPanel(null)` is the documented way back to the
     * Conversation; the service is captured from the injection scope, because
     * reaching for an undeclared service on the plugin context throws.
     */
    function RoleplayPanelFactory(selectConversation) {
      return function RoleplayPanel() {
        var React = require('react')

        React.useEffect(function () {
          function onMessage(event) {
            var data = event && event.data
            if (!data || typeof data !== 'object') return
            if (data.type === EXIT_MESSAGE) selectConversation()
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
              // Clip the frame to the host panel's rounded top-left corner
              // (Windows desktop publishes --dsh-windows-content-radius).
              overflow: 'hidden',
              borderTopLeftRadius: 'var(--dsh-windows-content-radius, 0px)',
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
        )
      }
    }

    function apply(ctx) {
      if (typeof ctx.inject !== 'function') {
        console.warn('[roleplay] client bundle needs cordis optional inject; panel stays off')
        return
      }

      // `slots` + `layout` are the whole dependency set. Both live in the Web
      // composition; the closure simply never runs in a host that lacks them.
      ctx.inject(['slots', 'layout'], function (scope) {
        var slots = scope.slots
        var layout = scope.layout

        var Panel = RoleplayPanelFactory(function selectConversation() {
          try {
            layout.selectPanel(null)
          } catch (error) {
            console.error('[roleplay] cannot switch back to the conversation panel:', error)
          }
        })

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
