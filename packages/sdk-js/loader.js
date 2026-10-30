/**
 * @clickroom/sdk-js — async loader snippet (PostHog-style stub).
 *
 * Paste the minified <script> form (see README) into your page <head>. This file
 * is the readable source of that snippet. It:
 *   1. Installs a `window.clickroom` stub that queues method calls made before the
 *      real bundle loads.
 *   2. On the first `init()` call, async-injects <script src="{api_host}/static/clickroom.js">
 *      using that call's `api_host` (falling back to the placeholder below, which is
 *      substituted with the real capture host by the dashboard's copy-paste snippet).
 *   3. Replays the queued calls once the real bundle has overwritten the stub.
 */
// biome-ignore lint/complexity/useArrowFunction: intentional ES5 — pasted verbatim into customer HTML, no transpilation
;(function (window, document) {
  // Placeholder: there is no default host. Always pass `api_host` to init().
  var apiHost = 'https://YOUR_CAPTURE_HOST'
  var injected = false
  var scriptPath = '/static/clickroom.js'

  // Public methods the stub proxies until the real bundle loads.
  var methods = [
    'init',
    'capture',
    'identify',
    'reset',
    'isFeatureEnabled',
    'getFeatureFlag',
    'onFeatureFlags',
  ]

  // biome-ignore lint/complexity/useOptionalChain: intentional ES5 — no optional chaining in the loader stub
  if (window.clickroom && window.clickroom.__loaded__) return

  var stub = window.clickroom || {}
  stub._q = stub._q || []
  stub.__stub__ = true

  function queue(name) {
    return function () {
      // biome-ignore lint/complexity/noArguments: intentional ES5 — no rest params in the loader stub
      var args = Array.prototype.slice.call(arguments)
      stub._q.push([name, args])
      // init's api_host picks the bundle host; inject only now that it is known.
      if (name === 'init') {
        // biome-ignore lint/complexity/useOptionalChain: intentional ES5 — no optional chaining in the loader stub
        if (args[1] && args[1].api_host) apiHost = args[1].api_host
        inject()
      }
    }
  }

  var i
  for (i = 0; i < methods.length; i++) {
    stub[methods[i]] = queue(methods[i])
  }

  window.clickroom = stub

  function replay() {
    var real = window.clickroom
    var j, name, args
    if (!real || real.__stub__) return
    for (j = 0; j < stub._q.length; j++) {
      name = stub._q[j][0]
      args = stub._q[j][1]
      if (typeof real[name] === 'function') real[name].apply(real, args)
    }
  }

  function inject() {
    if (injected) return
    injected = true
    var el = document.createElement('script')
    el.type = 'text/javascript'
    el.async = true
    el.src = apiHost.replace(/\/$/, '') + scriptPath
    el.onload = replay

    var first = document.getElementsByTagName('script')[0]
    // biome-ignore lint/complexity/useOptionalChain: intentional ES5 — no optional chaining in the loader stub
    if (first && first.parentNode) first.parentNode.insertBefore(el, first)
    else document.head.appendChild(el)
  }
})(window, document)
