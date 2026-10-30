// @vitest-environment jsdom
// Shadow-DOM support widget render layer.
//
// The DOM/copy assertions below are pinned to the design bundle's frames 1b–1e — see the header
// comment in `support-render.ts` for the frame → code map.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupportDefinition, SupportForm, SupportTicketThread } from '../support'
import { createSupportClient, defaultSupportRenderer } from '../support'
import {
  renderSupport,
  SUPPORT_STEPS,
  type SupportSubmission,
  type SupportTicketRow,
} from '../support-render'

const host = () => document.querySelector('[data-clickroom-support]') as HTMLElement | null
const shadow = () => host()?.shadowRoot ?? null
const q = (sel: string) => shadow()?.querySelector(sel) as HTMLElement | null
const qa = (sel: string) => Array.from(shadow()?.querySelectorAll(sel) ?? []) as HTMLElement[]
const panel = () => q('.ckrm-panel')
const launcher = () => q('.ckrm-launcher') as HTMLButtonElement | null
const text = () => shadow()?.textContent ?? ''
const css = () => shadow()?.querySelector('style')?.textContent ?? ''
const action = (name: string) => q(`[data-action="${name}"]`) as HTMLButtonElement | null

const definition = (over: Partial<SupportDefinition> = {}): SupportDefinition => ({
  version: 1,
  channel: 'contact',
  fields: [
    { id: 'email', type: 'email', label: 'Your email', required: true },
    {
      id: 'category',
      type: 'dropdown',
      label: 'Topic',
      required: false,
      choices: ['Billing', 'Bug'],
    },
  ],
  sources: [],
  appearance: { layout: 'launcher', position: 'bottom_right' },
  tracking: {
    identity: true,
    formAnalytics: true,
    recentEvents: true,
    sessionReplay: false,
    bugContext: false,
  },
  routing: { destinations: [], autoReply: false },
  triggers: { showLauncher: true, autoOpen: false },
  ...over,
})

const type = (el: HTMLElement | null, value: string): void => {
  const input = el as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Drive the widget from `ask` through a fully-filled `ticket` step. */
const fillTicket = (): void => {
  launcher()?.click()
  type(q('#ckrm-ask'), 'The checkout page is broken')
  action('message')?.click()
  type(q('#ckrm-f-0'), 'user@example.com')
  type(q('#ckrm-body'), 'It fails when I press pay.')
}

const submit = () => qa('.ckrm-actions .ckrm-btn-primary')[0] as HTMLButtonElement

afterEach(() => {
  for (const h of Array.from(document.querySelectorAll('[data-clickroom-support]'))) h.remove()
  vi.restoreAllMocks()
})

describe('mount + launcher', () => {
  it('mounts a shadow host with the launcher and no panel until opened', () => {
    const onShown = vi.fn()
    renderSupport(definition(), { onSubmit: vi.fn(), onShown })

    expect(host()).not.toBeNull()
    expect(shadow()).not.toBeNull()
    expect(launcher()).not.toBeNull()
    expect(panel()).toBeNull()
    expect(onShown).toHaveBeenCalledTimes(1)
  })

  it('fires onOpen/onClose as the launcher toggles the panel', () => {
    const onOpen = vi.fn()
    const onClose = vi.fn()
    renderSupport(definition(), { onSubmit: vi.fn(), onOpen, onClose })

    launcher()?.click()
    expect(panel()).not.toBeNull()
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(launcher()?.getAttribute('aria-expanded')).toBe('true')

    launcher()?.click()
    expect(panel()).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('suppresses the launcher when triggers.showLauncher is false, and autoOpen opens on mount', () => {
    renderSupport(definition({ triggers: { showLauncher: false, autoOpen: true } }), {
      onSubmit: vi.fn(),
    })
    expect(launcher()).toBeNull()
    expect(panel()).not.toBeNull()
  })

  it('destroy() removes the host and is idempotent', () => {
    const handle = renderSupport(definition(), { onSubmit: vi.fn() })
    handle.open()
    handle.destroy()
    handle.destroy()
    expect(host()).toBeNull()
  })

  it('renders nothing and stays inert without a DOM-mounted container mismatch (layouts)', () => {
    for (const layout of ['launcher', 'slide_out', 'modal'] as const) {
      renderSupport(definition({ appearance: { layout, position: 'bottom_right' } }), {
        onSubmit: vi.fn(),
      }).open()
      const p = document.querySelectorAll('[data-clickroom-support]')
      const last = p[p.length - 1] as HTMLElement
      expect(last.shadowRoot?.querySelector(`.ckrm-layout-${layout}`)).not.toBeNull()
    }
  })
})

describe('design fidelity — 1b launcher + panel', () => {
  it('draws the 52px round launcher with the accent glow and an icon-only accessible name', () => {
    renderSupport(definition({ appearance: { layout: 'launcher', position: 'bottom_right' } }), {
      onSubmit: vi.fn(),
    })
    // Size now flows through --ckrm-launcher-size (seeded to the 52px default), so the launcher
    // rule references the var and the :host block seeds the concrete px.
    expect(css()).toContain(
      'width: var(--ckrm-launcher-size, 52px); height: var(--ckrm-launcher-size, 52px)',
    )
    expect(css()).toContain('--ckrm-launcher-size: 52px')
    expect(css()).toContain('box-shadow: 0 10px 30px rgba(79,70,229,.5)')
    expect(launcher()?.querySelector('svg')?.getAttribute('width')).toBe('23')
    expect(launcher()?.getAttribute('aria-label')).toContain('Help')
  })

  it('renders the 320px r16 panel header, search row, three actions and the footer copy', () => {
    renderSupport(definition(), { onSubmit: vi.fn() })
    launcher()?.click()

    // Panel width flows through --ckrm-panel-width (seeded to 320px default).
    expect(css()).toContain('width: var(--ckrm-panel-width, 320px)')
    expect(css()).toContain('--ckrm-panel-width: 320px')
    expect(css()).toContain('box-shadow: 0 16px 50px rgba(15,23,42,.25)')
    expect(text()).toContain('Help & Contact')
    expect(text()).toContain('Ask a question or send us a message')
    expect((q('#ckrm-ask') as HTMLInputElement).placeholder).toBe('Search help articles…')
    expect(qa('.ckrm-action').map((a) => a.textContent)).toEqual([
      'Ask the AI assistantComing soon',
      'Send a message',
      'Report a bug',
    ])
    expect(text()).toContain('Powered by Clickroom')
  })
})

describe('design fidelity — 1c slide-out', () => {
  it('renders the 300px panel, the labelled form, dashed attach zone and sticky footer submit', () => {
    renderSupport(
      definition({
        appearance: { layout: 'slide_out', position: 'bottom_right' },
        fields: [
          {
            id: 'category',
            type: 'dropdown',
            label: 'Category',
            required: false,
            choices: ['Bug'],
          },
          { id: 'shot', type: 'file', label: 'Attach a screenshot', required: false },
        ],
      }),
      { onSubmit: vi.fn(), initialStep: 'ticket', autoFocus: false },
    )

    expect(css()).toContain('width: 300px')
    expect(css()).toContain('box-shadow: -16px 0 50px rgba(15,23,42,.25)')
    expect(css()).toContain('background: rgba(15,23,42,.28)')
    // Category select comes first, then Subject, then Message, then the dropzone + notice.
    expect(qa('.ckrm-body .ckrm-label').map((l) => l.textContent)).toEqual([
      'Category',
      'Subject*',
      'Message*',
    ])
    expect(q('.ckrm-drop')?.textContent).toContain('Attach a screenshot')
    expect(text()).toContain('Your account, plan and last 20 actions are attached automatically.')
    expect(q('.ckrm-footer .ckrm-btn-primary')?.textContent).toBe('Submit ticket')
  })
})

describe('design fidelity — 1d centered modal', () => {
  it('renders the 396px card over the darker scrim with articles and the contact CTA', () => {
    renderSupport(definition({ appearance: { layout: 'modal', position: 'center' } }), {
      onSubmit: vi.fn(),
    })
    launcher()?.click()

    // width:100% inside a 22px gutter → 396px at the design's 440px viewport (not "400px").
    expect(css()).toContain('max-width: 396px')
    expect(css()).toContain('padding: 22px')
    expect(css()).toContain('background: rgba(15,23,42,.4)')
    expect(text()).toContain('How can we help?')
    expect(text()).toContain('Search our docs or reach the team')
    expect(text()).toContain('Popular articles')
    expect(qa('.ckrm-article').map((a) => a.firstChild?.textContent)).toEqual([
      'Setting up SSO',
      'Exporting your data',
      'Billing & invoices',
    ])
    expect(action('message')?.textContent).toBe('Contact support')
  })

  it('lists the form’s declared sources as the article rows when it has any', () => {
    renderSupport(
      definition({
        appearance: { layout: 'modal', position: 'center' },
        sources: [{ id: 's1', type: 'url', value: 'https://x/docs', label: 'Docs home' }],
      }),
      { onSubmit: vi.fn() },
    )
    launcher()?.click()
    expect(qa('.ckrm-article').map((a) => a.firstChild?.textContent)).toEqual(['Docs home'])
  })
})

describe('design fidelity — 1e four-state flow', () => {
  it('exports the four states in frame order', () => {
    expect(SUPPORT_STEPS).toEqual(['ask', 'answer', 'ticket', 'confirmed'])
  })

  it('walks ask → answer → ticket → confirmed, each rendering its frame', () => {
    const seen: string[] = []
    for (const step of SUPPORT_STEPS) {
      renderSupport(definition(), { onSubmit: vi.fn(), initialStep: step, autoFocus: false })
      seen.push(step)
      const marker =
        step === 'ask'
          ? 'Help & Contact'
          : step === 'answer'
            ? 'From Exporting your data'
            : step === 'ticket'
              ? 'Send us a message'
              : 'Ticket created'
      expect(text()).toContain(marker)
      for (const h of Array.from(document.querySelectorAll('[data-clickroom-support]'))) h.remove()
    }
    expect(seen).toEqual(['ask', 'answer', 'ticket', 'confirmed'])
  })

  it('gives only step 1 the indigo header bar (steps 2–4 are header-less)', () => {
    const headers: Record<string, number> = {}
    for (const step of SUPPORT_STEPS) {
      renderSupport(definition(), { onSubmit: vi.fn(), initialStep: step, autoFocus: false })
      headers[step] = qa('.ckrm-header-accent').length
      for (const h of Array.from(document.querySelectorAll('[data-clickroom-support]'))) h.remove()
    }
    expect(headers).toEqual({ ask: 1, answer: 0, ticket: 0, confirmed: 0 })
  })

  it('shows the 1e-1 “Suggested” block only once a query is typed', () => {
    renderSupport(definition(), { onSubmit: vi.fn() })
    launcher()?.click()
    expect((q('.ckrm-suggest-list') as HTMLElement).style.display).toBe('none')
    type(q('#ckrm-ask'), 'export')
    expect((q('.ckrm-suggest-list') as HTMLElement).style.display).toBe('')
    expect(text()).toContain('Suggested')
  })

  it('renders the 1e-4 confirmation with the ticket number and reply-time footnote', async () => {
    renderSupport(definition(), { onSubmit: vi.fn(async () => ({ number: 4821 })) })
    fillTicket()
    submit().click()
    await new Promise((r) => setTimeout(r, 0))

    expect(text()).toContain('Ticket #4821 created')
    expect(text()).toContain('Typical first reply: under 2 hours')
    expect(q('.ckrm-success')).not.toBeNull()
  })
})

describe('4-state flow behaviour', () => {
  it('ask → ticket → confirmed, submitting the assembled payload', async () => {
    const onSubmit = vi.fn(async () => ({ id: 'tkt_1', number: 4821 }))
    renderSupport(definition(), { onSubmit })

    fillTicket()
    expect(submit().disabled).toBe(false)
    submit().click()
    await new Promise((r) => setTimeout(r, 0))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const payload = (onSubmit.mock.calls as unknown as unknown[][])[0][0] as {
      subject: string
      body: string
      category?: string
      fields: Record<string, unknown>
    }
    // The ask-step query seeds the subject (1e-3 shows it prefilled).
    expect(payload.subject).toBe('The checkout page is broken')
    expect(payload.body).toBe('It fails when I press pay.')
    expect(payload.fields.email).toBe('user@example.com')
    expect(text()).toContain('#4821')
  })

  it('“Report a bug” preselects the Bug category', () => {
    renderSupport(definition(), { onSubmit: vi.fn() })
    launcher()?.click()
    action('bug')?.click()
    expect((q('#ckrm-f-1') as HTMLSelectElement).value).toBe('Bug')
  })

  it('keeps the submit button disabled until subject, message and required fields are filled', () => {
    renderSupport(definition(), { onSubmit: vi.fn() })
    launcher()?.click()
    type(q('#ckrm-ask'), 'hello')
    action('message')?.click()

    expect(submit().disabled).toBe(true) // required email + message still blank
    type(q('#ckrm-body'), 'details')
    expect(submit().disabled).toBe(true) // required email still blank
    type(q('#ckrm-f-0'), 'user@example.com')
    expect(submit().disabled).toBe(false)
  })

  it('renders the error state and preserves input when onSubmit resolves null', async () => {
    renderSupport(definition(), { onSubmit: vi.fn(async () => null) })
    fillTicket()
    submit().click()
    await new Promise((r) => setTimeout(r, 0))

    expect(q('.ckrm-error')).not.toBeNull()
    expect((q('#ckrm-body') as HTMLTextAreaElement).value).toBe('It fails when I press pay.')
  })

  it('emits the CSAT score once, no matter how many times it is clicked', async () => {
    const onCsat = vi.fn()
    renderSupport(definition(), { onSubmit: vi.fn(async () => ({ number: 1 })), onCsat })
    fillTicket()
    submit().click()
    await new Promise((r) => setTimeout(r, 0))

    const scores = qa('.ckrm-csat button')
    scores[3].click()
    scores[1].click()

    expect(onCsat).toHaveBeenCalledTimes(1)
    expect(onCsat).toHaveBeenCalledWith(4)
  })

  it('the answer step is inert and unreachable from ask', () => {
    renderSupport(definition({ channel: 'bot' }), { onSubmit: vi.fn() })
    launcher()?.click()

    // The AI action row is rendered but disabled + badged — `bot` behaves exactly like `contact`.
    const botBtn = action('bot') as HTMLButtonElement
    expect(botBtn.disabled).toBe(true)
    expect(text()).toContain('Coming soon')

    action('message')?.click()
    expect(q('#ckrm-subject')).not.toBeNull()
  })

  it('renders the answer frame with a disabled “Solved 👍” and a working escalation', () => {
    renderSupport(definition(), { onSubmit: vi.fn(), initialStep: 'answer', autoFocus: false })
    expect(q('.ckrm-avatar')).not.toBeNull()
    expect(text()).toContain('From Exporting your data')
    expect((q('.ckrm-btn-solved') as HTMLButtonElement).disabled).toBe(true)
    ;(q('.ckrm-btn-escalate') as HTMLButtonElement).click()
    expect(q('#ckrm-subject')).not.toBeNull()
  })

  it('initialStep mounts a single state directly (the builder preview path)', () => {
    renderSupport(definition(), { onSubmit: vi.fn(), initialStep: 'ticket', autoFocus: false })
    expect(q('#ckrm-subject')).not.toBeNull()
    expect(q('#ckrm-ask')).toBeNull()
  })
})

describe('close resets the confirmed flow (bug: stale confirmation on reopen)', () => {
  /** The ghost "Close" control on the header-less 1e-4 confirmation. */
  const confirmClose = () =>
    qa('.ckrm-btn-ghost').find((b) => b.textContent === 'Close') as HTMLButtonElement | undefined

  it('Close on the confirmed step returns the next open to home, clearing ticket + CSAT state', async () => {
    renderSupport(definition(), { onSubmit: vi.fn(async () => ({ number: 4821 })) })
    fillTicket()
    submit().click()
    await new Promise((r) => setTimeout(r, 0))

    // On the confirmed screen, with a CSAT score selected.
    expect(text()).toContain('Ticket #4821 created')
    qa('.ckrm-csat button')[4].click() // score 5
    expect(q('.ckrm-csat [aria-checked="true"]')).not.toBeNull()

    // Close tears the panel down…
    confirmClose()?.click()
    expect(panel()).toBeNull()

    // …and the NEXT open starts fresh on home, not the stale confirmation.
    launcher()?.click()
    expect(panel()?.getAttribute('data-view')).toBe('ask')
    expect(q('#ckrm-ask')).not.toBeNull()
    expect(text()).not.toContain('Ticket #4821 created')
    // No stale CSAT radiogroup, and no highlighted score would survive.
    expect(q('.ckrm-csat')).toBeNull()
    expect(q('[aria-checked="true"]')).toBeNull()
  })

  it('preserves an in-progress draft when closing MID-form (reset is scoped to confirmed only)', () => {
    renderSupport(definition(), { onSubmit: vi.fn() })
    fillTicket() // lands on the ticket step with subject/body/email typed

    expect(panel()?.getAttribute('data-view')).toBe('ticket')
    expect((q('#ckrm-subject') as HTMLInputElement).value).toBe('The checkout page is broken')

    // Close mid-form (launcher toggle) then reopen.
    launcher()?.click()
    expect(panel()).toBeNull()
    launcher()?.click()

    // Draft survives: still the ticket form, still the typed values.
    expect(panel()?.getAttribute('data-view')).toBe('ticket')
    expect(q('#ckrm-subject')).not.toBeNull()
    expect((q('#ckrm-subject') as HTMLInputElement).value).toBe('The checkout page is broken')
    expect((q('#ckrm-body') as HTMLTextAreaElement).value).toBe('It fails when I press pay.')
  })
})

describe('telemetry callbacks', () => {
  it('reports first-focus order and every edit', () => {
    const onFieldFocus = vi.fn()
    const onFieldEdit = vi.fn()
    renderSupport(definition(), { onSubmit: vi.fn(), onFieldFocus, onFieldEdit })

    launcher()?.click()
    q('#ckrm-ask')?.dispatchEvent(new Event('focus'))
    q('#ckrm-ask')?.dispatchEvent(new Event('focus'))
    type(q('#ckrm-ask'), 'hi')
    action('message')?.click()
    q('#ckrm-f-0')?.dispatchEvent(new Event('focus'))
    type(q('#ckrm-f-0'), 'a@b.co')
    type(q('#ckrm-f-0'), 'a@b.com')

    expect(onFieldFocus.mock.calls.map(([id]) => id)).toEqual(['$ask', 'email'])
    expect(onFieldEdit.mock.calls.filter(([id]) => id === 'email')).toHaveLength(2)
  })
})

describe('a11y', () => {
  it('labels the dialog, labels every control and closes on ESC', () => {
    const onClose = vi.fn()
    renderSupport(definition(), { onSubmit: vi.fn(), onClose })
    launcher()?.click()

    expect(panel()?.getAttribute('role')).toBe('dialog')
    expect(panel()?.getAttribute('aria-labelledby')).toBe('ckrm-support-title')
    expect(shadow()?.getElementById('ckrm-support-title')).not.toBeNull()
    expect(q('.ckrm-close')?.getAttribute('aria-label')).toBe('Close support')

    action('message')?.click()
    // Every rendered control carries a <label for> pointing at it.
    for (const label of qa('label.ckrm-label, label.ckrm-drop')) {
      const target = (label as HTMLLabelElement).htmlFor
      expect(shadow()?.getElementById(target)).not.toBeNull()
    }
    // The header-less 1e steps still name the dialog.
    expect(shadow()?.getElementById('ckrm-support-title')).not.toBeNull()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(panel()).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('traps Tab inside the panel', () => {
    renderSupport(definition(), { onSubmit: vi.fn() })
    launcher()?.click()

    const items = Array.from(
      panel()?.querySelectorAll<HTMLElement>('button, input, select, textarea') ?? [],
    ).filter((el) => !el.hasAttribute('disabled'))
    expect(items.length).toBeGreaterThan(1)

    items[items.length - 1].focus()
    const evt = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    document.dispatchEvent(evt)
    expect(evt.defaultPrevented).toBe(true)
  })

  it('does not steal focus when autoFocus is false (the builder preview)', () => {
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    outside.focus()

    renderSupport(definition(), { onSubmit: vi.fn(), autoFocus: false, initialStep: 'ticket' })

    expect(document.activeElement).toBe(outside)
    outside.remove()
  })
})

// ---- conversation surfaces (frames 2a/2b/2c + 1b row) — ----

const NOW = 1_700_000_000_000
const rows = (over: Partial<SupportTicketRow>[] = []): SupportTicketRow[] =>
  over.map((r, i) => ({
    id: `t${i}`,
    number: 4800 + i,
    formId: 'f1',
    createdAt: NOW - i * 60_000,
    ...r,
  }))

const thread = (over: Partial<SupportTicketThread> = {}): SupportTicketThread => ({
  id: 't0',
  number: 4821,
  formId: 'f1',
  status: 'open',
  priority: 'normal',
  category: 'Bug',
  subject: 'Export fails on large reports',
  createdAt: new Date(NOW).toISOString(),
  resolvedAt: null,
  messages: [],
  ...over,
})

const badge = () => q('.ckrm-launcher-badge')

describe('2b conversation: author types', () => {
  it('renders an AI message with the violet avatar path, distinct from a human agent', () => {
    renderSupport(definition(), {
      onSubmit: vi.fn(),
      autoFocus: false,
      initialView: 'thread',
      initialThread: thread({
        messages: [
          {
            authorType: 'user',
            body: 'Export spins forever.',
            createdAt: new Date(NOW).toISOString(),
          },
          {
            authorType: 'ai',
            body: 'Let me get a human on this.',
            createdAt: new Date(NOW).toISOString(),
          },
          { authorType: 'agent', body: 'Digging in now.', createdAt: new Date(NOW).toISOString() },
        ],
      }),
    })

    const avatars = qa('.ckrm-msg-avatar')
    // Two author rows (ai + agent); the user bubble never shows an author row.
    expect(avatars).toHaveLength(2)
    const ai = avatars[0]
    const agent = avatars[1]
    // AI is distinguished by the AVATAR ONLY: violet #A78BFA + "AI".
    expect(ai.style.background).toBe('rgb(167, 139, 250)') // #A78BFA
    expect(ai.textContent).toBe('AI')
    expect(text()).toContain('AI assistant')
    expect(text()).toContain('Automatic')
    // Human agent avatar is the accent, not violet.
    expect(agent.style.background).not.toBe('rgb(167, 139, 250)')
    // Both AI and agent bubbles share the left/white geometry (distinction is the avatar).
    expect(qa('.ckrm-bubble-agent')).toHaveLength(2)
    expect(qa('.ckrm-bubble-user')).toHaveLength(1)
  })

  it('drives the typing indicator off agentTyping (onTyping callback)', () => {
    let fire: ((typing: boolean) => void) | undefined
    renderSupport(definition(), {
      onSubmit: vi.fn(),
      autoFocus: false,
      initialView: 'thread',
      initialThread: thread(),
      onSubscribe: (_id, handlers) => {
        fire = handlers.onTyping
        return { unsubscribe: vi.fn() }
      },
    })
    expect(q('.ckrm-typing')).toBeNull()
    fire?.(true)
    expect(q('.ckrm-typing')).not.toBeNull()
    expect(qa('.ckrm-typing-dots span')).toHaveLength(3)
  })
})

describe('open-to rules pick the initial view', () => {
  it('identified + ≥1 ticket + unread>0 → opens straight to the most-recent unread thread', () => {
    const onLoadThread = vi.fn(async () => thread({ id: 't0', subject: 'Newest unread' }))
    renderSupport(definition(), {
      onSubmit: vi.fn(),
      autoFocus: false,
      identified: true,
      onLoadThread,
      tickets: rows([
        { id: 't0', subject: 'Newest unread', unreadForUser: 1, createdAt: NOW }, // newest
        { id: 't1', subject: 'Older unread', unreadForUser: 1, createdAt: NOW - 999_000 },
      ]),
    })
    // Auto-opened to the thread of the newest unread ticket.
    expect(panel()).not.toBeNull()
    expect(panel()?.getAttribute('data-view')).toBe('thread')
    expect(onLoadThread).toHaveBeenCalledWith('t0')
  })

  it('identified + tickets, no unread → home (closed), with the 1b row visible on open', () => {
    renderSupport(definition(), {
      onSubmit: vi.fn(),
      identified: true,
      tickets: rows([{ id: 't0', subject: 'All read', unreadForUser: 0 }]),
    })
    // Home = not auto-opened to a thread.
    expect(panel()).toBeNull()
    launcher()?.click()
    expect(panel()?.getAttribute('data-view')).toBe('ask')
    expect(action('conversations')).not.toBeNull()
    expect(text()).toContain('Your conversations')
  })

  it('anonymous + ≥1 localStorage ticket → 1b row visible (this-browser history)', () => {
    renderSupport(definition(), {
      onSubmit: vi.fn(),
      identified: false,
      tickets: rows([{ id: 't0', unreadForUser: 3 }]),
    })
    expect(panel()).toBeNull()
    launcher()?.click()
    expect(action('conversations')).not.toBeNull()
    expect(text()).toContain('Your conversations')
  })

  it('no tickets → home as today, no 1b row', () => {
    renderSupport(definition(), {
      onSubmit: vi.fn(),
      identified: false,
      tickets: [],
    })
    launcher()?.click()
    expect(action('conversations')).toBeNull()
  })
})

describe('anonymous realtime (per-ticket-token background sub)', () => {
  const toast = () => q('.ckrm-toast')

  it('wires the background sub for an anonymous user with a local ticket', () => {
    const onSubscribe = vi.fn(() => ({ unsubscribe: vi.fn() }))
    renderSupport(definition(), {
      onSubmit: vi.fn(),
      identified: false,
      tickets: rows([{ id: 't0', subject: 'Anon ticket' }]),
      onSubscribe,
    })
    expect(onSubscribe).toHaveBeenCalledWith('t0', expect.anything())
  })

  it('a reply-while-closed pushes the toast for an anonymous user', () => {
    let fire: ((thread: SupportTicketThread | null) => void) | undefined
    renderSupport(definition(), {
      onSubmit: vi.fn(),
      identified: false,
      tickets: rows([{ id: 't0', subject: 'Anon ticket' }]),
      onSubscribe: (_id, handlers) => {
        fire = handlers.onMessage
        return { unsubscribe: vi.fn() }
      },
    })
    expect(toast()).toBeNull()
    fire?.(null)
    expect(toast()).not.toBeNull()
  })
})

describe('unread accessor drives the pill + badge', () => {
  it('sums unread across tickets onto the launcher badge (19px ring element)', () => {
    renderSupport(definition(), {
      onSubmit: vi.fn(),
      identified: true,
      tickets: rows([{ unreadForUser: 2 }, { unreadForUser: 3 }]),
    })
    expect(badge()?.textContent).toBe('5')
    expect(badge()?.style.display).not.toBe('none')
    expect(css()).toContain('min-width: 19px; height: 19px')
  })

  it('hides the badge at zero unread', () => {
    renderSupport(definition(), {
      onSubmit: vi.fn(),
      identified: true,
      tickets: rows([{ unreadForUser: 0 }]),
    })
    expect(badge()?.style.display).toBe('none')
  })

  it('falls back to the unreadCount override when no tickets are supplied', () => {
    renderSupport(definition(), { onSubmit: vi.fn(), unreadCount: 7 })
    expect(badge()?.textContent).toBe('7')
  })

  it('shows the 18px 1b-row pill with the count, hidden at zero unread', () => {
    // Explicit initialStep pins `ask` so unread>0 does not auto-open to the thread.
    renderSupport(definition(), {
      onSubmit: vi.fn(),
      autoFocus: false,
      initialStep: 'ask',
      identified: true,
      tickets: rows([{ unreadForUser: 2 }]),
    })
    expect(q('.ckrm-convos-row .ckrm-pill')?.textContent).toBe('2')
    // 1b pill is 18×18 with NO ring — distinct from the 2c launcher badge.
    expect(css()).toContain('.ckrm-pill {')
    expect(css()).toContain('min-width: 18px; height: 18px')

    for (const h of Array.from(document.querySelectorAll('[data-clickroom-support]'))) h.remove()
    renderSupport(definition(), {
      onSubmit: vi.fn(),
      autoFocus: false,
      initialStep: 'ask',
      identified: true,
      tickets: rows([{ unreadForUser: 0 }]),
    })
    expect(q('.ckrm-convos-row')).not.toBeNull()
    expect(q('.ckrm-convos-row .ckrm-pill')).toBeNull()
  })
})

describe('2a list + 2b interactions', () => {
  it('renders the 2a rows with status chip, mono id and category square, then navigates to 2b', () => {
    renderSupport(definition(), {
      onSubmit: vi.fn(),
      autoFocus: false,
      initialView: 'tickets',
      onLoadThread: async () => thread(),
      tickets: rows([
        {
          id: 't0',
          number: 4821,
          category: 'Bug',
          subject: 'Export fails on large reports',
          snippet: 'Maya: Found it…',
          unreadForUser: 1,
          status: 'open',
        },
        {
          id: 't1',
          number: 4612,
          category: 'Question',
          subject: 'How do I add a teammate?',
          status: 'solved',
        },
      ]),
    })
    expect(css()).toContain('width: 360px')
    expect(text()).toContain('Your conversations')
    // End-user status wording, not internal state names.
    expect(qa('.ckrm-status-chip').map((c) => c.textContent)).toEqual(['Agent replied', 'Solved'])
    expect(qa('.ckrm-ticket-id').map((c) => c.textContent)).toEqual(['#4821', '#4612'])
    // Unread row gets the accent dot; solved/read one does not.
    expect(qa('.ckrm-ticket-dot')).toHaveLength(1)
    expect(q('.ckrm-new-convo')?.textContent).toContain('New conversation')

    // Row click → 2b thread.
    ;(qa('.ckrm-ticket-row')[0] as HTMLButtonElement).click()
    expect(panel()?.getAttribute('data-view')).toBe('thread')
  })

  it('chips a bug row in the ONE 2a list and leaves a conversation row untouched', () => {
    renderSupport(definition(), {
      onSubmit: vi.fn(),
      autoFocus: false,
      initialView: 'tickets',
      tickets: rows([
        { id: 't0', number: 1, subject: 'Export crashes', status: 'open', type: 'bug' },
        { id: 't1', number: 2, subject: 'How do I invite?', status: 'open' },
      ]),
    })

    // Still ONE list — the bug is a row in it, not a separate surface.
    expect(qa('.ckrm-ticket-row')).toHaveLength(2)
    // Exactly one Bug chip, on the bug row, beside its unchanged status chip.
    const bugChips = qa('.ckrm-bug-chip')
    expect(bugChips).toHaveLength(1)
    expect(bugChips[0]?.textContent).toBe('Bug')
    expect(qa('.ckrm-ticket-row')[0]?.contains(bugChips[0] as Node)).toBe(true)
    // The conversation row renders exactly as it does today: status chip only.
    expect(qa('.ckrm-ticket-row')[1]?.querySelector('.ckrm-bug-chip')).toBeNull()
    expect(
      qa('.ckrm-ticket-row').map((r) => r.querySelector('.ckrm-status-chip')?.textContent),
    ).toEqual(['Waiting on us', 'Waiting on us'])
  })

  it('composer append fires onAppendMessage and shows the reply optimistically', () => {
    const onAppendMessage = vi.fn(async () => true)
    renderSupport(definition(), {
      onSubmit: vi.fn(),
      autoFocus: false,
      initialView: 'thread',
      initialThread: thread({ id: 't0', messages: [] }),
      onAppendMessage,
    })
    type(q('#ckrm-reply'), 'Any workaround?')
    ;(q('.ckrm-composer-send') as HTMLButtonElement).click()

    expect(onAppendMessage).toHaveBeenCalledWith('t0', 'Any workaround?')
    // Optimistic user bubble is on screen.
    expect(text()).toContain('Any workaround?')
    expect(qa('.ckrm-bubble-user')).toHaveLength(1)
  })

  it('“Mark as solved” fires onMarkSolved and flips the footer state', () => {
    const onMarkSolved = vi.fn(async () => true)
    renderSupport(definition(), {
      onSubmit: vi.fn(),
      autoFocus: false,
      initialView: 'thread',
      initialThread: thread({ id: 't0', number: 4821, status: 'open' }),
      onMarkSolved,
    })
    expect(text()).toContain('Ticket #4821 · Open')
    ;(action('mark-solved') as HTMLButtonElement).click()
    expect(onMarkSolved).toHaveBeenCalledWith('t0')
    // Footer flips to solved; the action disappears.
    expect(text()).toContain('Ticket #4821 · Solved')
    expect(action('mark-solved')).toBeNull()
  })
})

describe('appearance', () => {
  it('applies the brand colours and copy into the shadow stylesheet', () => {
    renderSupport(
      definition({
        appearance: {
          layout: 'modal',
          position: 'center',
          primaryColor: '#ff0055',
          backgroundColor: '#101828',
          textColor: '#f8fafc',
          launcherLabel: 'Need a hand?',
          greeting: 'Hey!',
        },
      }),
      { onSubmit: vi.fn() },
    )

    expect(css()).toContain('#ff0055')
    expect(css()).toContain('#101828')
    expect(css()).toContain('#f8fafc')
    // The launcher glow follows the brand accent instead of the design's indigo.
    expect(css()).toContain('rgba(255,0,85,.5)')
    expect(launcher()?.getAttribute('aria-label')).toBe('Need a hand? — open support')

    launcher()?.click()
    expect(text()).toContain('Hey!')
  })

  it('seeds --ckrm-* custom properties and calc()s the panel/toast off the launcher vars', () => {
    renderSupport(definition({ appearance: { layout: 'launcher', position: 'bottom_right' } }), {
      onSubmit: vi.fn(),
    })
    const sheet = css()
    // Every CSS var the downstream consumer overrides is seeded on :host from the appearance.
    expect(sheet).toContain('--ckrm-launcher-bottom: 18px')
    expect(sheet).toContain('--ckrm-launcher-right: 18px')
    expect(sheet).toContain('--ckrm-launcher-left: 18px')
    expect(sheet).toContain('--ckrm-z: 2147483646')
    // The launcher anchors resolve from the vars (so a host can relocate the FAB)…
    expect(sheet).toContain(
      '.ckrm-pos-bottom_right { right: var(--ckrm-launcher-right, 18px); bottom: var(--ckrm-launcher-bottom, 18px); }',
    )
    // …and the panel bottom is a calc() OFF those launcher vars (78px = 18 + 52 + 8).
    expect(sheet).toContain(
      'bottom: calc(var(--ckrm-launcher-bottom, 18px) + var(--ckrm-launcher-size, 52px) + 8px)',
    )
    // The reply toast rides the same anchor, 12px above (82px = 18 + 52 + 12).
    expect(sheet).toContain(
      'bottom: calc(var(--ckrm-launcher-bottom, 18px) + var(--ckrm-launcher-size, 52px) + 12px)',
    )
  })

  it('honours launcherSize (bubble var + scaled glyph) and launcherIcon (mapped preset)', () => {
    renderSupport(
      definition({
        appearance: {
          layout: 'launcher',
          position: 'bottom_right',
          launcherSize: 64,
          launcherIcon: 'help',
        },
      }),
      { onSubmit: vi.fn() },
    )
    // Seeded px follows the config; glyph scales ~0.44× (round(64*0.44) = 28).
    expect(css()).toContain('--ckrm-launcher-size: 64px')
    expect(launcher()?.querySelector('svg')?.getAttribute('width')).toBe('28')
    // launcherIcon 'help' maps to the help-circle geometry (a <circle> with r=10), not the
    // default message-square (which has no <circle>).
    expect(launcher()?.querySelector('circle')?.getAttribute('r')).toBe('10')
  })

  it('maps each launcherIcon preset onto its built-in glyph without accepting raw markup', () => {
    // message → message-square (path only); chat → message-square-more (path only, extra lines);
    // help/question → help-circle (has a <circle>).
    for (const [preset, hasCircle] of [
      ['message', false],
      ['chat', false],
      ['help', true],
      ['question', true],
    ] as const) {
      renderSupport(
        definition({
          appearance: { layout: 'launcher', position: 'bottom_right', launcherIcon: preset },
        }),
        { onSubmit: vi.fn() },
      )
      const p = document.querySelectorAll('[data-clickroom-support]')
      const last = p[p.length - 1] as HTMLElement
      const svg = last.shadowRoot?.querySelector('.ckrm-launcher svg')
      expect(!!svg?.querySelector('circle')).toBe(hasCircle)
      last.remove()
    }
  })

  it('honours cornerRadius, panelWidth and fontFamily through their vars', () => {
    renderSupport(
      definition({
        appearance: {
          layout: 'launcher',
          position: 'bottom_right',
          cornerRadius: 4,
          panelWidth: 420,
          fontFamily: 'Comic Sans MS, cursive',
        },
      }),
      { onSubmit: vi.fn() },
    )
    const sheet = css()
    expect(sheet).toContain('--ckrm-radius: 4px')
    expect(sheet).toContain('--ckrm-panel-width: 420px')
    expect(sheet).toContain('--ckrm-font: Comic Sans MS, cursive')
    // The panel radius + width reference the vars, not literals.
    expect(sheet).toContain('border-radius: var(--ckrm-radius, 16px)')
    expect(sheet).toContain('width: var(--ckrm-panel-width, 320px)')
  })

  it('headerStyle:"plain" swaps the launcher accent header for the plain one', () => {
    renderSupport(
      definition({
        appearance: { layout: 'launcher', position: 'bottom_right', headerStyle: 'plain' },
      }),
      {
        onSubmit: vi.fn(),
        initialStep: 'ask',
        autoFocus: false,
      },
    )
    expect(qa('.ckrm-header-accent')).toHaveLength(0)
    expect(qa('.ckrm-header-plain')).toHaveLength(1)
    // Copy is unchanged — only the header chrome swaps.
    expect(text()).toContain('Help & Contact')
  })

  it('hideBranding:true omits the "Powered by Clickroom" footer', () => {
    renderSupport(
      definition({
        appearance: { layout: 'launcher', position: 'bottom_right', hideBranding: true },
      }),
      {
        onSubmit: vi.fn(),
      },
    )
    launcher()?.click()
    expect(q('.ckrm-powered')).toBeNull()
    expect(text()).not.toContain('Powered by Clickroom')
  })

  it('falls back to each frame’s own title when no greeting is configured', () => {
    for (const [layout, title] of [
      ['launcher', 'Help & Contact'],
      ['slide_out', 'Contact support'],
      ['modal', 'How can we help?'],
    ] as const) {
      renderSupport(definition({ appearance: { layout, position: 'bottom_right' } }), {
        onSubmit: vi.fn(),
        initialStep: 'ask',
        autoFocus: false,
      })
      expect(text()).toContain(title)
      for (const h of Array.from(document.querySelectorAll('[data-clickroom-support]'))) h.remove()
    }
  })
})

describe('inline home surface (frame 4a — search-first)', () => {
  const inlineDef = (over: Partial<SupportDefinition> = {}) =>
    definition({
      appearance: { layout: 'inline', position: 'bottom_right' },
      sources: [{ id: 's1', type: 'url', value: 'https://x/docs', label: 'Docs home' }],
      ...over,
    })

  it('defaults to the search hero + three channel cards + popular articles', () => {
    renderSupport(inlineDef(), { onSubmit: vi.fn() })
    expect(q('.ckrm-home-hero')).not.toBeNull()
    expect(q('.ckrm-home-search input')).not.toBeNull()
    expect(text()).toContain('How can we help?')
    expect(qa('.ckrm-home-card')).toHaveLength(3)
    expect(action('bot')).not.toBeNull()
    expect(action('message-square')).not.toBeNull()
    expect(action('bug')).not.toBeNull()
    // Popular articles come from the declared sources.
    expect(qa('.ckrm-home-article-title').map((a) => a.textContent)).toEqual(['Docs home'])
  })

  it('keeps the hero + articles when no docs source is connected, on the design sample rows', () => {
    renderSupport(inlineDef({ sources: [] }), { onSubmit: vi.fn() })
    // The no-source auto-fallback to the conversations posture is deliberately disabled.
    expect(q('.ckrm-home-hero')).not.toBeNull()
    expect(q('.ckrm-home-search')).not.toBeNull()
    expect(q('.ckrm-home-articles')).not.toBeNull()
    expect(qa('.ckrm-home-article-title').map((a) => a.textContent)).toEqual([
      'Exporting your data',
      'Setting up SSO with Okta',
      'Billing & invoices',
      'Inviting teammates and setting roles',
    ])
    // Literal design read-times — never a derived one.
    expect(qa('.ckrm-home-article-meta').map((a) => a.textContent)).toEqual([
      '3 min read',
      '5 min read',
      '2 min read',
      '4 min read',
    ])
    // No help-centre url declared ⇒ no dead "Browse all" link.
    expect(text()).not.toContain('Browse all')
    expect(qa('.ckrm-home-card')).toHaveLength(3)
  })

  it('renders no read-time meta for source-derived article rows', () => {
    renderSupport(inlineDef(), { onSubmit: vi.fn() })
    expect(qa('.ckrm-home-article-title').map((a) => a.textContent)).toEqual(['Docs home'])
    expect(qa('.ckrm-home-article-meta')).toHaveLength(0)
    expect(text()).toContain('Browse all')
  })

  it('draws the design channel-card copy, tints and icon strokes', () => {
    renderSupport(inlineDef(), { onSubmit: vi.fn() })
    expect(text()).toContain('Instant answers from our docs, with sources')
    expect(text()).toContain('Reach the team — typical reply under 2 hours')
    expect(text()).toContain('We attach your session and recent actions')
    const tint = (name: string) =>
      (action(name)?.querySelector('.ckrm-home-card-icon') as HTMLElement).style.background
    expect(tint('bot')).toBe('rgba(167, 139, 250, 0.12)')
    expect(tint('message-square')).toBe('rgba(79, 70, 229, 0.1)')
    expect(tint('bug')).toBe('rgba(239, 68, 68, 0.1)')
    const stroke = (name: string) => (action(name)?.querySelector('svg') as SVGElement).style.stroke
    expect(stroke('bot')).toBe('rgb(167, 139, 250)')
    expect(stroke('bug')).toBe('rgb(239, 68, 68)')
    // 16px glyphs, and the bug card uses the design's 4-path simple bug.
    expect(action('bug')?.querySelector('svg')?.getAttribute('width')).toBe('16')
    expect(action('bug')?.querySelectorAll('svg path')).toHaveLength(5)
  })

  it('has no branding footer on 4a, but keeps it on the 3a conversations surface', () => {
    const handle = renderSupport(inlineDef(), { onSubmit: vi.fn() })
    expect(q('.ckrm-inline-branding')).toBeNull()
    handle.destroy()
    renderSupport(inlineDef(), { onSubmit: vi.fn(), initialView: 'tickets' })
    expect(q('.ckrm-inline-branding')).not.toBeNull()
  })

  it('⌘K from the HOST page (not just the shadow tree) focuses the search input', () => {
    renderSupport(inlineDef(), { onSubmit: vi.fn(), home: 'conversations' })
    expect(q('.ckrm-home-search')).toBeNull()
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }),
    )
    expect(q('.ckrm-home-search input')).not.toBeNull()
  })

  it('home="conversations" drops the hero even when sources exist', () => {
    renderSupport(inlineDef(), { onSubmit: vi.fn(), home: 'conversations' })
    expect(q('.ckrm-home-hero')).toBeNull()
    expect(qa('.ckrm-home-card')).toHaveLength(3)
  })

  it('typing in the search filters the article list live', () => {
    renderSupport(
      inlineDef({
        sources: [
          { id: 's1', type: 'url', value: 'https://x/sso', label: 'Setting up SSO' },
          { id: 's2', type: 'url', value: 'https://x/bill', label: 'Billing basics' },
        ],
      }),
      { onSubmit: vi.fn() },
    )
    expect(qa('.ckrm-home-article-title')).toHaveLength(2)
    type(q('.ckrm-home-search input'), 'bill')
    expect(qa('.ckrm-home-article-title').map((a) => a.textContent)).toEqual(['Billing basics'])
    type(q('.ckrm-home-search input'), 'zzz')
    expect(q('.ckrm-home-empty')).not.toBeNull()
  })

  it('Report a bug card presets category=Bug and routes to the compose form', () => {
    renderSupport(inlineDef(), { onSubmit: vi.fn() })
    action('bug')?.click()
    // Now on the inline compose pane with the category dropdown preset to Bug.
    const select = q('.ckrm-inline-compose select') as HTMLSelectElement | null
    expect(select?.value).toBe('Bug')
  })

  it('the Ask-AI card opens the bot page with a cited-sources sidebar', () => {
    renderSupport(inlineDef(), { onSubmit: vi.fn() })
    action('bot')?.click()
    expect(q('.ckrm-bot')).not.toBeNull()
    expect(q('.ckrm-bot-sidebar')).not.toBeNull()
    expect(qa('.ckrm-bot-cite').length).toBeGreaterThan(0)
    // Deferred: the coming-soon badge stays and "Solved" is inert.
    expect(text()).toContain('Coming soon')
    expect((q('.ckrm-btn-solved') as HTMLButtonElement)?.disabled).toBe(true)
  })

  it('never renders home/bot surfaces in the FAB layouts', () => {
    renderSupport(definition({ appearance: { layout: 'launcher', position: 'bottom_right' } }), {
      onSubmit: vi.fn(),
      initialView: 'home',
      autoFocus: false,
    })
    launcher()?.click()
    // Launcher falls back to the ask home — no inline home markup leaks in.
    expect(q('.ckrm-home-hero')).toBeNull()
    expect(q('.ckrm-bot')).toBeNull()
  })
})

// ---- inline surface DOM guarantees (table /) ----------
//
// The inline surface is a PAGE, not a dialog. Four properties separate it from the three FAB
// layouts and none of them are visible from the copy/appearance assertions above:
//   * the shadow host lands in `opts.container`, never on `document.body` (a host that leaked onto
//     body would float over the customer's own layout and survive their route change);
//   * no launcher bubble and no scrim (the scrim is CSS keyed on `data-layout`, so a stray
//     `inline` entry in those selectors would black out the host page);
//   * no focus trap and no ESC-to-close — a page that eats Tab and ESC breaks the surrounding app;
//   * `destroy()` really removes the host, so a route leave + return leaves exactly one.

describe('inline surface DOM guarantees', () => {
  const inlineDef = () =>
    definition({
      appearance: { layout: 'inline', position: 'bottom_right' },
      sources: [{ id: 's1', type: 'url', value: 'https://x/docs', label: 'Docs home' }],
    })

  /** A container in the document (so layout/ResizeObserver code paths behave) that we own. */
  const makeContainer = (): HTMLElement => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    return el
  }

  const root = () => q('.ckrm-root')

  afterEach(() => {
    for (const el of Array.from(document.querySelectorAll('[data-test-container]'))) el.remove()
  })

  it('appends its shadow host to the container, never to document.body', () => {
    const el = makeContainer()
    el.setAttribute('data-test-container', '')
    const handle = renderSupport(inlineDef(), { onSubmit: vi.fn(), container: el })

    expect(el.querySelectorAll('[data-clickroom-support]')).toHaveLength(1)
    // Nothing of ours was parented on <body> itself.
    expect(
      Array.from(document.body.children).filter((c) => c.hasAttribute('data-clickroom-support')),
    ).toHaveLength(0)
    // …and it is told to fill that container rather than position itself.
    const el2 = el.querySelector('[data-clickroom-support]') as HTMLElement
    expect(el2.style.width).toBe('100%')
    expect(el2.style.height).toBe('100%')
    expect(root()?.getAttribute('data-embed')).toBe('true')

    handle.destroy()
  })

  it('renders no launcher and draws no scrim', () => {
    const el = makeContainer()
    el.setAttribute('data-test-container', '')
    const handle = renderSupport(inlineDef(), { onSubmit: vi.fn(), container: el })

    expect(launcher()).toBeNull()
    expect(qa('.ckrm-launcher')).toHaveLength(0)
    // The panel is up (inline is always open) but the root carries the inline layout, and the two
    // scrim rules are bound to `modal` / `slide_out` only — so nothing paints a backdrop.
    expect(panel()).not.toBeNull()
    expect(root()?.getAttribute('data-layout')).toBe('inline')
    expect(root()?.getAttribute('data-open')).toBe('true')
    expect(css()).toContain('.ckrm-root[data-open="true"][data-layout="modal"]')
    expect(css()).not.toContain('data-layout="inline"]')
    // The embed root explicitly un-does the fixed/scrim styling.
    expect(css()).toContain('position: static; inset: auto; pointer-events: auto; background: none')

    handle.destroy()
  })

  it('does not steal focus on mount (autoFocus defaults false for inline)', () => {
    const el = makeContainer()
    el.setAttribute('data-test-container', '')
    const outside = document.createElement('input')
    outside.setAttribute('data-test-container', '')
    document.body.appendChild(outside)
    outside.focus()

    const handle = renderSupport(inlineDef(), { onSubmit: vi.fn(), container: el })
    expect(document.activeElement).toBe(outside)

    handle.destroy()
  })

  /** Every `keydown` listener the mount installs on `document`. Asserted against the listener list
   *  rather than by dispatching a real event: other tests in this file mount FAB widgets and the
   *  shared `afterEach` yanks their hosts without calling `destroy()`, so their (still-`open`)
   *  focus-trap listeners survive on `document` and would swallow any ESC we dispatch. Reading the
   *  registration directly asks the only question that matters — did THIS mount wire a trap? */
  const keydownListenersFrom = (spy: { mock: { calls: unknown[][] } }): EventListener[] =>
    spy.mock.calls
      .filter((c) => c[0] === 'keydown')
      .map((c) => c[1])
      .filter((fn): fn is EventListener => typeof fn === 'function')

  it('installs no focus trap and no ESC handler — only the ⌘K page shortcut', () => {
    const el = makeContainer()
    el.setAttribute('data-test-container', '')
    const spy = vi.spyOn(document, 'addEventListener')
    const handle = renderSupport(inlineDef(), { onSubmit: vi.fn(), container: el })

    // The FAB layouts wire `onKeydown` (ESC-to-close + Tab wrap) on open; inline must wire only the
    // frame 4a ⌘K shortcut.
    const listeners = keydownListenersFrom(spy)
    expect(listeners).toHaveLength(1)

    handle.destroy()
  })

  it('ESC neither closes nor destroys the surface, and is not swallowed', () => {
    const el = makeContainer()
    el.setAttribute('data-test-container', '')
    const onClose = vi.fn()
    const spy = vi.spyOn(document, 'addEventListener')
    const handle = renderSupport(inlineDef(), { onSubmit: vi.fn(), container: el, onClose })
    const listeners = keydownListenersFrom(spy)

    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    for (const fn of listeners) fn(esc)

    expect(panel()).not.toBeNull()
    expect(el.querySelectorAll('[data-clickroom-support]')).toHaveLength(1)
    expect(onClose).not.toHaveBeenCalled()
    // Not merely "still open" — nothing of ours called preventDefault, so the host app's own ESC
    // handling (closing ITS modal around us) still runs.
    expect(esc.defaultPrevented).toBe(false)

    handle.destroy()
  })

  it('does not trap Tab — focus can leave the panel', () => {
    const el = makeContainer()
    el.setAttribute('data-test-container', '')
    const outside = document.createElement('input')
    outside.setAttribute('data-test-container', '')
    document.body.appendChild(outside)
    const spy = vi.spyOn(document, 'addEventListener')
    const handle = renderSupport(inlineDef(), { onSubmit: vi.fn(), container: el })
    const listeners = keydownListenersFrom(spy)

    const focusables = qa('button, input, select, textarea, a[href]')
    expect(focusables.length).toBeGreaterThan(0)
    const last = focusables[focusables.length - 1]
    last.focus()

    // Tab off the LAST focusable is exactly where a trap would wrap back to the first…
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    for (const fn of listeners) fn(tab)
    expect(tab.defaultPrevented).toBe(false)
    expect(shadow()?.activeElement).toBe(last)

    // …and Shift+Tab off the FIRST focusable is the other half of it.
    focusables[0].focus()
    const shiftTab = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    for (const fn of listeners) fn(shiftTab)
    expect(shiftTab.defaultPrevented).toBe(false)
    expect(shadow()?.activeElement).toBe(focusables[0])

    // Focus genuinely leaves for a host-page element — nothing yanks it back.
    outside.focus()
    expect(document.activeElement).toBe(outside)

    handle.destroy()
  })

  it('destroy() empties the container, and remounting leaves exactly one host', () => {
    const el = makeContainer()
    el.setAttribute('data-test-container', '')

    const first = renderSupport(inlineDef(), { onSubmit: vi.fn(), container: el })
    expect(el.querySelectorAll('[data-clickroom-support]')).toHaveLength(1)

    first.destroy()
    expect(el.querySelectorAll('[data-clickroom-support]')).toHaveLength(0)
    expect(el.childNodes).toHaveLength(0)

    const second = renderSupport(inlineDef(), { onSubmit: vi.fn(), container: el })
    expect(el.querySelectorAll('[data-clickroom-support]')).toHaveLength(1)
    // A destroyed handle must not resurrect or double-mount anything.
    first.destroy()
    expect(el.querySelectorAll('[data-clickroom-support]')).toHaveLength(1)

    second.destroy()
    expect(el.querySelectorAll('[data-clickroom-support]')).toHaveLength(0)
  })

  it('the ⌘K page listener is removed on destroy (no leak across route changes)', () => {
    const el = makeContainer()
    el.setAttribute('data-test-container', '')
    const handle = renderSupport(inlineDef(), { onSubmit: vi.fn(), container: el })
    handle.destroy()

    expect(() =>
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }),
      ),
    ).not.toThrow()
    expect(el.querySelectorAll('[data-clickroom-support]')).toHaveLength(0)
  })
})

// ---- clickroom.support.mount() / open() / close() -------
//
// The vanilla entry point is a THIN wrapper over `defaultSupportRenderer` — the same wiring the
// auto-mounted FAB and `<ClickroomSupport />` get. These drive the real `init()` so the delegation
// is pinned end to end: a forked copy of the callback block would drop `onTicketCreated` (it did),
// and an `open()` that only knows about explicit mounts is a silent no-op for `support: true`.

describe('clickroom.support namespace', () => {
  const sdkForm = (over: Record<string, unknown> = {}) => ({
    id: 'sup_1',
    version: 1,
    linkedFlagKey: null,
    definition: definition(),
    ...over,
  })

  /** Route `/v1/support`, the ticket create and `/v1/flags` off one mock. */
  const stubSdkFetch = (forms: unknown[]) => {
    const mock = vi.fn(async (url: unknown) => {
      const u = String(url)
      const body = u.includes('/v1/support/tickets')
        ? { id: 'tkt_1', number: 7, token: 'tok_1' }
        : u.includes('/v1/support')
          ? { forms }
          : { flags: {}, version: 1 }
      return { ok: true, status: 200, json: async () => body }
    })
    vi.stubGlobal('fetch', mock as unknown as typeof fetch)
    return mock
  }

  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  const loadSdk = async () => {
    vi.resetModules()
    localStorage.clear()
    return await import('../index')
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mount() resolves a CSS selector string into the host element', async () => {
    stubSdkFetch([sdkForm()])
    const sdk = await loadSdk()
    const el = document.createElement('div')
    el.id = 'support-page'
    document.body.appendChild(el)

    sdk.default.init('wk_test', {
      api_host: 'https://capture.clickroom.co',
      support: { enabled: true, mode: 'manual' },
    })
    await settle()

    const handle = sdk.default.support.mount({ el: '#support-page' })
    expect(handle).not.toBeNull()
    expect(el.querySelector('[data-clickroom-support]')).not.toBeNull()

    handle?.destroy()
    el.remove()
  })

  it('mount() returns null for a selector that matches nothing', async () => {
    stubSdkFetch([sdkForm()])
    const sdk = await loadSdk()
    sdk.default.init('wk_test', {
      api_host: 'https://capture.clickroom.co',
      support: { enabled: true, mode: 'manual' },
    })
    await settle()

    expect(sdk.default.support.mount({ el: '#nope' })).toBeNull()
  })

  it('mount() fires onTicketCreated after a ticket is filed', async () => {
    stubSdkFetch([sdkForm()])
    const sdk = await loadSdk()
    const el = document.createElement('div')
    document.body.appendChild(el)

    sdk.default.init('wk_test', {
      api_host: 'https://capture.clickroom.co',
      support: { enabled: true, mode: 'manual' },
    })
    await settle()

    const onTicketCreated = vi.fn()
    // Launcher mode so the assertion rides the stable FAB flow, not the inline surface;
    // `view: 'new'` opens straight on the compose step.
    const handle = sdk.default.support.mount({
      el,
      mode: 'launcher',
      view: 'new',
      onTicketCreated,
    })
    handle?.open()
    type(q('#ckrm-subject'), 'Broken checkout')
    type(q('#ckrm-f-0'), 'user@example.com')
    type(q('#ckrm-body'), 'It fails when I press pay.')
    submit().click()
    await settle()

    expect(onTicketCreated).toHaveBeenCalledTimes(1)
    expect(onTicketCreated.mock.calls[0][0]).toMatchObject({ id: 'tkt_1', number: 7 })

    handle?.destroy()
    el.remove()
  })

  it('open()/close() drive the FAB auto-mounted by init({ support: true })', async () => {
    stubSdkFetch([sdkForm()])
    const sdk = await loadSdk()

    sdk.default.init('wk_test', { api_host: 'https://capture.clickroom.co', support: true })
    await settle()

    expect(launcher()).not.toBeNull()
    expect(panel()).toBeNull()

    sdk.default.support.open()
    expect(panel()).not.toBeNull()

    sdk.default.support.close()
    expect(panel()).toBeNull()
  })

  it('open()/close() are no-ops when support is off or nothing is mounted', async () => {
    stubSdkFetch([])
    const sdk = await loadSdk()

    expect(() => sdk.default.support.open()).not.toThrow()
    sdk.default.init('wk_test', { api_host: 'https://capture.clickroom.co' })
    await settle()
    expect(() => sdk.default.support.open()).not.toThrow()
    expect(() => sdk.default.support.close()).not.toThrow()
    expect(sdk.default.support.mount({ el: document.createElement('div') })).toBeNull()
  })

  it('mount({ mode: "inline" }) keeps the page guarantees: own container, no launcher, no ESC', async () => {
    stubSdkFetch([sdkForm()])
    const sdk = await loadSdk()
    const el = document.createElement('div')
    document.body.appendChild(el)

    sdk.default.init('wk_test', {
      api_host: 'https://capture.clickroom.co',
      support: { enabled: true, mode: 'manual' },
    })
    await settle()

    const handle = sdk.default.support.mount({ el, mode: 'inline' })
    expect(handle).not.toBeNull()
    expect(el.querySelectorAll('[data-clickroom-support]')).toHaveLength(1)
    expect(
      Array.from(document.body.children).filter((c) => c.hasAttribute('data-clickroom-support')),
    ).toHaveLength(0)
    expect(qa('.ckrm-launcher')).toHaveLength(0)
    expect(panel()).not.toBeNull()

    // Route leave → return: destroy clears the container, the remount is not a second host.
    handle?.destroy()
    expect(el.childNodes).toHaveLength(0)
    const again = sdk.default.support.mount({ el, mode: 'inline' })
    expect(el.querySelectorAll('[data-clickroom-support]')).toHaveLength(1)

    again?.destroy()
    el.remove()
  })
})

// ---- /: `mode` gates the auto-mount, and ONLY the auto-mount ------
//
// `support-default-off.test.ts` pins the network half of this (which modes fetch `/v1/support`)
// but runs in the node environment, where `document` does not exist and "appends no launcher host
// to <body>" is vacuously true. This is the DOM half, driven through the real `init()`.

describe('support mode gates the FAB auto-mount', () => {
  const modeForm = () => ({
    id: 'sup_1',
    version: 1,
    linkedFlagKey: null,
    definition: definition(),
  })

  const stubModeFetch = () => {
    const mock = vi.fn(async (url: unknown) => {
      const u = String(url)
      const body = u.includes('/v1/support') ? { forms: [modeForm()] } : { flags: {}, version: 1 }
      return { ok: true, status: 200, json: async () => body }
    })
    vi.stubGlobal('fetch', mock as unknown as typeof fetch)
    return mock
  }

  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  const loadSdk = async () => {
    vi.resetModules()
    localStorage.clear()
    return await import('../index')
  }

  const bodyHosts = () =>
    Array.from(document.body.children).filter((c) => c.hasAttribute('data-clickroom-support'))

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mode: "manual" builds the client but appends NO host to <body>', async () => {
    stubModeFetch()
    const sdk = await loadSdk()

    sdk.default.init('wk_test', {
      api_host: 'https://capture.clickroom.co',
      support: { enabled: true, mode: 'manual' },
    })
    await settle()

    expect(sdk.getSupportClient()).not.toBeNull()
    expect(sdk.getSupportClient()?.getEligibleForms()).toHaveLength(1)
    expect(bodyHosts()).toHaveLength(0)
    expect(document.querySelectorAll('[data-clickroom-support]')).toHaveLength(0)
  })

  it('mode: "both" auto-mounts the FAB *and* still exposes the client for manual mounts', async () => {
    stubModeFetch()
    const sdk = await loadSdk()

    sdk.default.init('wk_test', {
      api_host: 'https://capture.clickroom.co',
      support: { enabled: true, mode: 'both' },
    })
    await settle()

    expect(sdk.getSupportClient()).not.toBeNull()
    expect(bodyHosts()).toHaveLength(1)
    expect(launcher()).not.toBeNull()

    // The whole point of `both`: a second, inline surface on the host's own route, alongside the FAB.
    const el = document.createElement('div')
    document.body.appendChild(el)
    const handle = sdk.default.support.mount({ el, mode: 'inline' })
    expect(el.querySelectorAll('[data-clickroom-support]')).toHaveLength(1)
    expect(bodyHosts()).toHaveLength(1)

    handle?.destroy()
    el.remove()
  })

  it('mode: "launcher" (and the bare `support: true` sugar) auto-mount identically', async () => {
    stubModeFetch()
    const sdk = await loadSdk()
    sdk.default.init('wk_test', {
      api_host: 'https://capture.clickroom.co',
      support: { enabled: true, mode: 'launcher' },
    })
    await settle()
    expect(bodyHosts()).toHaveLength(1)
    expect(launcher()).not.toBeNull()

    for (const h of Array.from(document.querySelectorAll('[data-clickroom-support]'))) h.remove()

    stubModeFetch()
    const sdk2 = await loadSdk()
    sdk2.default.init('wk_test', { api_host: 'https://capture.clickroom.co', support: true })
    await settle()
    expect(bodyHosts()).toHaveLength(1)
    expect(launcher()).not.toBeNull()
  })

  it('enabled: false mounts nothing whatever the mode says', async () => {
    stubModeFetch()
    const sdk = await loadSdk()

    sdk.default.init('wk_test', {
      api_host: 'https://capture.clickroom.co',
      support: { enabled: false, mode: 'both' },
    })
    await settle()

    expect(sdk.getSupportClient()).toBeNull()
    expect(document.querySelectorAll('[data-clickroom-support]')).toHaveLength(0)
  })
})

// ---- bug vs conversation compose type -----------------
//
// `type` is the ticket discriminator now; `answers.category = 'Bug'` is deliberately KEPT as a
// legacy convention (category taxonomies / chip colours / `buildSupportVolumeByCategory` all still
// key off it) and is simply no longer what decides the ticket's kind.

describe('compose type on the submission', () => {
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  const severityDef = () =>
    definition({
      fields: [
        { id: 'email', type: 'email', label: 'Your email', required: true },
        {
          id: 'category',
          type: 'dropdown',
          label: 'Severity',
          required: false,
          choices: ['Blocker', 'Major', 'Minor'],
        },
      ],
    })

  const inlineDef = (over: Partial<SupportDefinition> = {}) =>
    definition({
      appearance: { layout: 'inline', position: 'bottom_right' },
      ...over,
    })

  const lastSubmission = (onSubmit: ReturnType<typeof vi.fn>): SupportSubmission =>
    onSubmit.mock.calls[0][0] as SupportSubmission

  /** Fill + send the compose form that the current step is already showing. */
  const finishCompose = async (): Promise<void> => {
    // The FAB layouts carry the subject over from the `ask` step; inline (4a) goes straight to the
    // compose pane, so its subject input starts empty.
    const subjectInput = q('#ckrm-subject') as HTMLInputElement | null
    if (subjectInput && subjectInput.value === '') type(subjectInput, 'Something broke')
    type(q('#ckrm-f-0'), 'user@example.com')
    type(q('#ckrm-body'), 'It fails when I press pay.')
    submit().click()
    await settle()
  }

  it('the 1b bug action row files a bug (and keeps the legacy category=Bug)', async () => {
    const onSubmit = vi.fn(async () => ({ id: 'tkt', number: 1 }))
    renderSupport(definition(), { onSubmit })
    launcher()?.click()
    type(q('#ckrm-ask'), 'The checkout page is broken')
    action('bug')?.click()
    await finishCompose()

    expect(lastSubmission(onSubmit).type).toBe('bug')
    expect(lastSubmission(onSubmit).category).toBe('Bug')
  })

  it('the 1b message action row files a conversation', async () => {
    const onSubmit = vi.fn(async () => ({ id: 'tkt', number: 1 }))
    renderSupport(definition(), { onSubmit })
    fillTicket()
    submit().click()
    await settle()

    expect(lastSubmission(onSubmit).type).toBe('conversation')
    expect(lastSubmission(onSubmit).severity).toBeUndefined()
  })

  it('the 4a bug home card files a bug, the 4a message card a conversation', async () => {
    const bugSubmit = vi.fn(async () => ({ id: 'tkt', number: 1 }))
    renderSupport(inlineDef(), { onSubmit: bugSubmit })
    action('bug')?.click()
    await finishCompose()
    expect(lastSubmission(bugSubmit).type).toBe('bug')

    for (const h of Array.from(document.querySelectorAll('[data-clickroom-support]'))) h.remove()

    const msgSubmit = vi.fn(async () => ({ id: 'tkt', number: 1 }))
    renderSupport(inlineDef(), { onSubmit: msgSubmit })
    // The 4a cards key off the icon name (`message-square`); the 1b action rows use `message`.
    action('message-square')?.click()
    await finishCompose()
    expect(lastSubmission(msgSubmit).type).toBe('conversation')
  })

  it('derives severity from a Blocker category answer (the bug template Severity dropdown)', async () => {
    const onSubmit = vi.fn(async () => ({ id: 'tkt', number: 1 }))
    renderSupport(severityDef(), { onSubmit })
    launcher()?.click()
    type(q('#ckrm-ask'), 'Everything is down')
    action('bug')?.click()
    type(q('.ckrm-inline-compose select, select'), 'Blocker')
    await finishCompose()

    const sub = lastSubmission(onSubmit)
    expect(sub.type).toBe('bug')
    expect(sub.category).toBe('Blocker')
    expect(sub.severity).toBe('blocker')
  })

  it('leaves severity undefined for a category answer that is not a severity word', async () => {
    const onSubmit = vi.fn(async () => ({ id: 'tkt', number: 1 }))
    renderSupport(definition(), { onSubmit })
    launcher()?.click()
    type(q('#ckrm-ask'), 'Charged twice')
    action('message')?.click()
    type(q('select'), 'Billing')
    await finishCompose()

    expect(lastSubmission(onSubmit).severity).toBeUndefined()
  })
})

// ---- what the live submit path puts on the wire --------

describe('defaultSupportRenderer submit path', () => {
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  const form = (bugContext: boolean): SupportForm => ({
    id: 'sup_1',
    version: 1,
    linkedFlagKey: null,
    definition: definition({
      tracking: {
        identity: true,
        formAnalytics: false,
        recentEvents: false,
        sessionReplay: false,
        bugContext,
      },
    }),
  })

  const stubTicketFetch = () => {
    const mock = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ id: 'tkt_1', number: 7, token: 'secret' }),
    }))
    vi.stubGlobal('fetch', mock as unknown as typeof fetch)
    return mock
  }

  const createBody = (mock: ReturnType<typeof vi.fn>): Record<string, unknown> => {
    const call = mock.mock.calls.find(([u]) => String(u).endsWith('/v1/support/tickets')) as
      | [string, RequestInit]
      | undefined
    return JSON.parse(String(call?.[1].body)) as Record<string, unknown>
  }

  const client = () =>
    createSupportClient({
      getApiHost: () => 'https://capture.example.com',
      getWriteKey: () => 'wk_test',
      isFeatureEnabled: () => true,
      capture: () => {},
      getDistinctId: () => 'user-1',
      now: () => 1_000_000,
    })

  const fileVia = async (entry: 'bug' | 'message', f: SupportForm): Promise<void> => {
    defaultSupportRenderer(f, client())
    launcher()?.click()
    type(q('#ckrm-ask'), 'Something broke')
    action(entry)?.click()
    type(q('#ckrm-f-0'), 'user@example.com')
    type(q('#ckrm-body'), 'It fails when I press pay.')
    submit().click()
    await settle()
  }

  afterEach(() => {
    localStorage.clear()
    vi.unstubAllGlobals()
  })

  it('a conversation sends NONE of the bug-only keys (deny_unknown_fields blast radius)', async () => {
    const fetchMock = stubTicketFetch()
    await fileVia('message', form(true))

    const body = createBody(fetchMock)
    expect(body).not.toHaveProperty('type')
    expect(body).not.toHaveProperty('severity')
    expect(body).not.toHaveProperty('bugReport')
  })

  it('a bug sends type and, with bugContext on, the bugReport', async () => {
    const fetchMock = stubTicketFetch()
    await fileVia('bug', form(true))

    const body = createBody(fetchMock)
    expect(body.type).toBe('bug')
    expect(body.bugReport).toBeDefined()
    expect((body.bugReport as { capturedAt?: string }).capturedAt).toBeTruthy()
  })

  it('a bug sends NO bugReport when tracking.bugContext is false (the default)', async () => {
    const fetchMock = stubTicketFetch()
    await fileVia('bug', form(false))

    const body = createBody(fetchMock)
    expect(body.type).toBe('bug')
    expect(body).not.toHaveProperty('bugReport')
  })
})
