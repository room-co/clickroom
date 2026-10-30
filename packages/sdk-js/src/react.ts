// @clickroom/sdk-js/react — headless React API for surveys and support
//
// A tree-shakeable subpath export (`@clickroom/sdk-js/react`) that exposes the survey config as
// React state, for teams rendering their own survey UI instead of the built-in shadow-DOM popover.
// It is a thin binding over the survey client built by `init({ surveys: true })` — read
// off the same singleton via `getSurveyClient()`, NOT a second client. No logic is duplicated:
// eligibility/frequency come from the client, capture goes through `client.captureSent`.
//
// `react` is a PEER dependency — the SDK never bundles it (esbuild marks it external). SSR-safe:
// the hooks no-op to empty results when no client exists (survey delivery off, or init hasn't run).

import type * as React from 'react'
import { createElement, useEffect, useRef, useState } from 'react'
import { getSupportClient, getSurveyClient, onFeatureFlags } from './index.js'
import type { CreatedTicket, CreateTicketInput, StoredTicket, SupportForm } from './support'
import { defaultSupportRenderer } from './support'
import type { SupportRenderHandle } from './support-render'
import type { Survey, SurveyResponse } from './survey'

/** Eligible surveys still within their display-frequency budget. Eligibility rides the linked
 *  flag, so this recomputes whenever flags refresh (see the hooks below). Empty when no client. */
function activeSurveys(): Survey[] {
  const client = getSurveyClient()
  if (!client) return []
  return client.getEligibleSurveys().filter((s) => client.shouldShowSurvey(s))
}

function findSurvey(id: string): Survey | undefined {
  return getSurveyClient()
    ?.getSurveys()
    .find((s) => s.id === id)
}

/**
 * The currently eligible + triggered surveys (linked flag on, within their frequency budget).
 * Stays live across the SDK's own flag refreshes by re-syncing on `onFeatureFlags`, mirroring
 * `apps/web/src/lib/use-internal-flag.ts`. Momentary event/URL/selector triggers are matched by
 * the renderer via the client's `surveysForEvent`/`surveysForUrl`; this returns the flag-eligible,
 * frequency-allowed set for a team driving its own UI.
 */
export function useActiveSurveys(): Survey[] {
  const [surveys, setSurveys] = useState<Survey[]>(() => activeSurveys())

  useEffect(() => {
    // Re-sync in case the config fetch / flags resolved between first render and this effect.
    setSurveys(activeSurveys())
    onFeatureFlags(() => setSurveys(activeSurveys()))
  }, [])

  return surveys
}

/**
 * A single survey config by id, or `undefined` if it isn't in the fetched config. Re-syncs on flag
 * refreshes so a survey that becomes eligible (or whose config version changes) is picked up.
 */
export function useSurvey(id: string): Survey | undefined {
  const [survey, setSurvey] = useState<Survey | undefined>(() => findSurvey(id))

  useEffect(() => {
    setSurvey(findSurvey(id))
    onFeatureFlags(() => setSurvey(findSurvey(id)))
  }, [id])

  return survey
}

/**
 * Emit `$survey_sent` for a completed response, through the survey client — same path the built-in
 * popover uses (`client.captureSent` → `buildSentProps` fan-out + frequency persistence). No-op if
 * survey delivery is off or the id isn't in the fetched config.
 */
export function captureSurveyResponse(surveyId: string, response: SurveyResponse): void {
  const client = getSurveyClient()
  if (!client) return
  const survey = client.getSurveys().find((s) => s.id === surveyId)
  if (!survey) return
  client.captureSent(survey, response)
}

// ---- support --------------------------------------------------
//
// Same posture as the survey hooks above: a thin binding over the singleton support client built
// by `init({ support: true })`, read via `getSupportClient()`. No second client, no duplicated
// eligibility logic, SSR-safe (empty results when no client exists).

/** Eligible support forms — those whose linked flag is on. Empty when no client. */
function eligibleForms(): SupportForm[] {
  return getSupportClient()?.getEligibleForms() ?? []
}

/**
 * The support forms this user is eligible for (linked flag on). Stays live across the SDK's own
 * flag refreshes by re-syncing on `onFeatureFlags`, exactly like `useActiveSurveys`. For teams
 * rendering their own support UI instead of the built-in shadow-DOM widget.
 */
export function useSupportForms(): SupportForm[] {
  const [forms, setForms] = useState<SupportForm[]>(() => eligibleForms())

  useEffect(() => {
    // Re-sync in case the config fetch / flags resolved between first render and this effect.
    setForms(eligibleForms())
    onFeatureFlags(() => setForms(eligibleForms()))
  }, [])

  return forms
}

function findForm(id: string): SupportForm | undefined {
  return getSupportClient()
    ?.getForms()
    .find((f) => f.id === id)
}

/** A single support form config by id, or `undefined` if it isn't in the fetched config. Re-syncs
 *  on flag refreshes so a form that becomes eligible (or whose version changes) is picked up. */
export function useSupportForm(id: string): SupportForm | undefined {
  const [form, setForm] = useState<SupportForm | undefined>(() => findForm(id))

  useEffect(() => {
    setForm(findForm(id))
    onFeatureFlags(() => setForm(findForm(id)))
  }, [id])

  return form
}

/**
 * The tickets this browser has filed, newest first, read from the SDK's per-ticket token store.
 * Local by design: the widget's only credential for its own threads is the opaque token kept in
 * localStorage, so "my tickets" is a client-side list, not a server query.
 */
export function useSupportTickets(): StoredTicket[] {
  const [tickets, setTickets] = useState<StoredTicket[]>(
    () => getSupportClient()?.getStoredTickets() ?? [],
  )

  useEffect(() => {
    setTickets(getSupportClient()?.getStoredTickets() ?? [])
  }, [])

  return tickets
}

/**
 * File a ticket through the singleton support client — the same path the built-in widget uses
 * (`createTicket` → `POST /v1/support/tickets`, persisting the returned per-ticket token). The
 * context bundle is assembled from the form's own `tracking` toggles. Resolves `null` when
 * support is off, the form id is unknown, or the request fails.
 */
export async function submitSupportTicket(input: CreateTicketInput): Promise<CreatedTicket | null> {
  const client = getSupportClient()
  if (!client) return null
  const form = client.getForms().find((f) => f.id === input.formId)
  if (!form) return null
  return client.createTicket(input, client.buildContext(form))
}

export interface ClickroomSupportProps {
  /** `'launcher'` (default) mounts the floating widget on `document.body` and renders `null`
   *  (today's behavior). `'inline'` renders a `div` in place and fills it with the widget. */
  mode?: 'launcher' | 'inline'
  /** Which form to mount. Omitted = the first eligible form. */
  formId?: string
  /** Initial surface for inline mode. Default `'home'` (frame 4a search-first landing). */
  view?: 'home' | 'search' | 'bot' | 'new' | 'tickets' | 'thread'
  /** Inline home posture (frame 4a). `'search'` (default) leads with the search hero; falls back to
   *  `'conversations'` automatically when the form has no docs source connected. */
  home?: 'search' | 'conversations'
  /** Deep-link a thread — pairs with a `/support/:ticketId` route. Inline mode only. */
  ticketId?: string
  /** Applied to the inline host `div` (ignored in launcher mode). */
  className?: string
  /** Applied to the inline host `div` (ignored in launcher mode). */
  style?: React.CSSProperties
  /** Fires when the user opens a thread, so the host can sync its own URL. */
  onTicketOpen?: (ticket: { id: string; number?: number }) => void
  /** Fires after a ticket is filed. */
  onTicketCreated?: (ticket: CreatedTicket) => void
}

/**
 * Declarative mount for the built-in shadow-DOM widget: `<ClickroomSupport />`.
 *
 * `mode: 'launcher'` (default) — optional sugar over `init({ support: true })`: renders nothing
 * itself, the widget lives in its own shadow host appended to `document.body`, so React never owns
 * its DOM. Ties the mount to a React subtree's lifetime (e.g. only inside the authenticated shell);
 * unmounting destroys the widget.
 *
 * `mode: 'inline'` — renders a `div` in place and mounts the widget into it (`layout: 'inline'`),
 * so support lives as a full-page/embedded surface instead of a floating launcher. `view` picks the
 * opening surface, `ticketId` deep-links a thread, and `onTicketOpen` / `onTicketCreated` let the
 * host mirror navigation into its own router. Re-mounts on `mode` / `formId` change and tears the
 * host down on unmount so route changes don't leak widgets.
 */
export function ClickroomSupport(props: ClickroomSupportProps): React.ReactElement | null {
  const handleRef = useRef<SupportRenderHandle | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const forms = useSupportForms()
  const mode = props.mode ?? 'launcher'
  const formId = props.formId
  const view = props.view
  const home = props.home
  const ticketId = props.ticketId

  // Read callbacks through a ref so a fresh closure on every render doesn't re-mount the widget —
  // only `mode` / `formId` / `forms` / `view` / `ticketId` do.
  const callbacksRef = useRef({
    onTicketOpen: props.onTicketOpen,
    onTicketCreated: props.onTicketCreated,
  })
  callbacksRef.current = {
    onTicketOpen: props.onTicketOpen,
    onTicketCreated: props.onTicketCreated,
  }

  useEffect(() => {
    const client = getSupportClient()
    if (!client || typeof document === 'undefined') return
    const form = formId ? forms.find((f) => f.id === formId) : forms[0]
    if (!form) return

    let handle: SupportRenderHandle | undefined
    if (mode === 'inline') {
      const container = containerRef.current
      if (!container) return
      // Default to the frame 4a search-first HOME surface (which itself falls back to a
      // conversations-first posture when the form has no docs source connected).
      const initialView = view ?? 'home'
      handle = defaultSupportRenderer(form, client, {
        container,
        appearance: { layout: 'inline' },
        view: initialView,
        home,
        ticketId,
        onTicketOpen: (ticket) => callbacksRef.current.onTicketOpen?.(ticket),
        onTicketCreated: (ticket) => callbacksRef.current.onTicketCreated?.(ticket),
      })
    } else {
      handle = defaultSupportRenderer(form, client)
    }
    handleRef.current = handle ?? null

    return () => {
      handleRef.current?.destroy()
      handleRef.current = null
    }
  }, [mode, formId, forms, view, home, ticketId])

  // Launcher mode owns no React DOM (shadow host on `document.body`). Inline mode renders the host
  // div both on the server (hydration match) and the client; the widget mounts into it in the
  // effect above, which no-ops without a `document`.
  if (mode === 'inline') {
    return createElement('div', {
      ref: containerRef,
      className: props.className,
      style: props.style,
    })
  }
  return null
}

/** `createElement` is imported so this module stays a plain `.ts` file (no JSX build step) while
 *  remaining usable as `<ClickroomSupport />`. Re-exported as the escape hatch for callers that
 *  want the element without JSX. */
export const createSupportElement = (props: ClickroomSupportProps = {}) =>
  createElement(ClickroomSupport, props)

export type {
  CreatedTicket,
  CreateTicketInput,
  StoredTicket,
  SupportForm,
  SupportTicketThread,
} from './support'
export type { Survey, SurveyResponse } from './survey'
