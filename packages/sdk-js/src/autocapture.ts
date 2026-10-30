// @clickroom/sdk-js — DOM autocapture + pageview / SPA navigation tracking.
//
// Attaches capture-phase listeners for click/submit/change, serializes the
// target's DOM path into `elements_chain`, and emits `$autocapture`. Also emits
// `$pageview` on load and on SPA navigation (history pushState/replaceState,
// popstate, hashchange). Every handler is wrapped so a listener error never
// breaks the host page. `initAutocapture` returns a teardown that removes all
// listeners and restores the patched history methods.

import { getEventTarget, serializeElementsChain } from './elements-chain'
import type { AutocaptureContext } from './types'

type HistoryMethod = History['pushState']

// Common URL/location properties attached to every autocapture + pageview event.
function locationProps(): Record<string, unknown> {
  return {
    $current_url: location.href,
    $host: location.host,
    $pathname: location.pathname,
  }
}

/**
 * Wire up autocapture + pageview tracking. Returns a teardown function that
 * removes every listener and restores `history.pushState`/`replaceState`.
 * A no-op teardown is returned in non-DOM (SSR) environments.
 */
export function initAutocapture(ctx: AutocaptureContext): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return () => {}
  }

  // ---- Autocapture (click / submit / change) -----------------------------

  const handleInteraction = (event: Event): void => {
    try {
      const raw = event.target
      if (!(raw instanceof Element)) {
        return
      }
      const target = getEventTarget(raw)
      if (!target) {
        return
      }
      const chain = serializeElementsChain(target)
      ctx.capture(
        '$autocapture',
        {
          $event_type: event.type,
          ...locationProps(),
        },
        chain,
      )
    } catch {
      // Never let a listener error surface to the host page.
    }
  }

  const interactionEvents: string[] = ['click', 'submit', 'change']

  if (ctx.config.autocapture) {
    for (const type of interactionEvents) {
      document.addEventListener(type, handleInteraction, true)
    }
  }

  // ---- Pageviews (initial + SPA navigation) ------------------------------

  let lastUrl = ''

  const emitPageview = (): void => {
    try {
      if (!ctx.config.capture_pageview) {
        return
      }
      if (location.href === lastUrl) {
        return
      }
      lastUrl = location.href
      ctx.capture('$pageview', {
        ...locationProps(),
        $referrer: document.referrer,
      })
    } catch {
      // Swallow: pageview tracking must never break navigation.
    }
  }

  const origPushState: HistoryMethod = history.pushState.bind(history)
  const origReplaceState: HistoryMethod = history.replaceState.bind(history)
  let patched = false

  if (ctx.config.capture_pageview) {
    history.pushState = (...args: Parameters<HistoryMethod>): void => {
      origPushState(...args)
      emitPageview()
    }
    history.replaceState = (...args: Parameters<HistoryMethod>): void => {
      origReplaceState(...args)
      emitPageview()
    }
    patched = true

    window.addEventListener('popstate', emitPageview)
    window.addEventListener('hashchange', emitPageview)

    // Initial pageview for the current document.
    emitPageview()
  }

  // ---- Teardown ----------------------------------------------------------

  return () => {
    if (ctx.config.autocapture) {
      for (const type of interactionEvents) {
        document.removeEventListener(type, handleInteraction, true)
      }
    }
    if (patched) {
      history.pushState = origPushState
      history.replaceState = origReplaceState
      window.removeEventListener('popstate', emitPageview)
      window.removeEventListener('hashchange', emitPageview)
    }
  }
}
