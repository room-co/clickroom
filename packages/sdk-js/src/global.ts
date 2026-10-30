// @clickroom/sdk-js — CDN IIFE entry. Attaches the singleton to window.clickroom.
import clickroom, { __setInferredApiHost } from './index'

/**
 * `__loaded__` is the flag the async loader stub (`loader.js`) checks before it
 * injects `<script src="{api_host}/static/clickroom.js">`. Only the real bundle
 * sets it — the stub sets `__stub__` instead — so a page that pastes the snippet
 * twice (a common copy/paste accident, and unavoidable in some tag managers)
 * loads and evaluates the bundle exactly once.
 */
type ClickroomGlobal = typeof clickroom & { __loaded__: true }

declare global {
  interface Window {
    clickroom: ClickroomGlobal
  }
}

if (typeof window !== 'undefined') {
  // Served from `{api_host}/static/clickroom.js` (services/capture), so the script's own URL
  // tells us the host (including any proxy path prefix). Lets `init(key)` work with no options.
  try {
    const src = (document.currentScript as HTMLScriptElement | null)?.src
    if (src) __setInferredApiHost(src.replace(/\/static\/clickroom\.js(\?.*)?$/, ''))
  } catch {
    // ignore: an explicit api_host is still honoured
  }
  const instance = clickroom as ClickroomGlobal
  instance.__loaded__ = true
  window.clickroom = instance
}

export default clickroom
