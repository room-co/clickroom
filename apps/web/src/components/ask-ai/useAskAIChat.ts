// State container for one Ask AI conversation: wires the streaming transport,
// `useChat`, and the send handlers. Keeps `AskAIChat.tsx` a thin render.
// The server rebuilds prior history from persisted `AiMessage` rows (see
// `apps/api/src/ai/ask-ai.controller.ts`), so the client only ever sends the
// latest message — mirrors the reference implementation's
// `apps/web/src/app/components/ask-ai/useAskAIChat.ts`.

import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { useEffect, useMemo, useRef, useState } from 'react'
import { track } from '@/lib/analytics'
import { getToken } from '@/lib/auth'
import { getApiBase } from '@/lib/runtime-config'
import { logout, refreshSession } from '@/lib/session'
import type { ToolPart } from './tool-parts'
import { useToolConfirm } from './useToolConfirm'

// SSE can't ride the batched `/trpc` link (httpBatchLink buffers/batches the
// body), so this goes straight at apps/api on its own origin/port — same
// cross-port-in-dev situation `apps/web/src/hooks/useFlagsStream.ts` and
// `apps/web/src/pages/McpPage.tsx` are already in.
export const AI_API_ORIGIN = getApiBase()

/**
 * `fetch` that injects the current bearer token and, on a 401, refreshes the
 * access token once and retries — mirroring `trpc-provider.tsx`'s `authFetch`
 * for this raw-fetch caller (the chat stream + tool-confirm) that bypasses
 * the tRPC client. Without this an access token that expires mid-conversation
 * dead-ends the chat with "Authentication required." even though the
 * refresh-token cookie is still valid.
 */
export async function authedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const hadToken = !!getToken()
  const run = (token: string | null) => {
    const headers = new Headers(init.headers)
    if (token) headers.set('authorization', `Bearer ${token}`)
    else headers.delete('authorization')
    return fetch(input, { ...init, headers })
  }

  const res = await run(getToken())
  if (res.status !== 401 || !hadToken) return res

  const ok = await refreshSession()
  if (!ok) {
    logout()
    return res
  }
  return run(getToken())
}

export type ParsedChatError =
  | { kind: 'forbidden'; message: string }
  | { kind: 'not_configured' }
  | { kind: 'disabled' }
  | { kind: 'generic'; message: string }

interface ChatErrorBody {
  error?: string
  message?: string
  statusCode?: number
}

/**
 * The transport surfaces a non-2xx response as an `Error` whose `message` is
 * the raw response body (NestJS serializes 4xx/5xx payloads as JSON, and the
 * AI SDK's `DefaultChatTransport` just does `throw new Error(await
 * response.text())` — no status code is preserved on the Error itself, so
 * everything has to come from the parsed body's `error`/`statusCode`).
 */
export function parseChatError(error: Error | undefined): ParsedChatError | null {
  if (!error) return null
  try {
    const body = JSON.parse(error.message) as ChatErrorBody
    if (body.error === 'ai_not_configured') return { kind: 'not_configured' }
    if (body.error === 'ai_chat_disabled') return { kind: 'disabled' }
    if (body.statusCode === 401 || body.statusCode === 403 || body.error === 'Forbidden') {
      return { kind: 'forbidden', message: body.message ?? 'You cannot use Ask AI right now.' }
    }
    if (body.message) return { kind: 'generic', message: body.message }
  } catch {
    // not JSON — fall through to the raw message
  }
  return { kind: 'generic', message: error.message }
}

/**
 * Resume the stream only when the assistant turn ENDS on a resolved tool call
 * — i.e. the confirm-gated mutating tool whose result was just attached
 * client-side (`useToolConfirm` → `addToolResult`), with no model text after
 * it yet.
 *
 * Deliberately NOT the SDK's default
 * (`lastAssistantMessageIsCompleteWithToolCalls`): it returns true whenever
 * the last step's tools are all resolved, but Clickroom's read tools
 * (`analytics_*`, `flags_list`, …) execute inline and the model replies with
 * text in the SAME turn — so that predicate is perpetually true and re-POSTs
 * `/ai/chat` forever ("Thinking…" loop). Requiring the tool to be the LAST
 * content part discriminates the awaiting-continuation case from an
 * already-answered turn.
 */
export function lastAssistantTurnAwaitsContinuation({
  messages,
}: {
  messages: UIMessage[]
}): boolean {
  const last = messages.at(-1)
  if (last?.role !== 'assistant') return false
  const parts = last.parts ?? []
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i] as { type?: string; state?: string }
    const type = part.type
    if (type === 'step-start' || type === 'step-finish') continue
    if (typeof type === 'string' && (type.startsWith('tool-') || type === 'dynamic-tool')) {
      return part.state === 'output-available' || part.state === 'output-error'
    }
    // A text/reasoning part is the last content → the model already responded.
    return false
  }
  return false
}

export interface UseAskAIChatResult {
  input: string
  setInput: (v: string) => void
  messages: UIMessage[]
  status: 'submitted' | 'streaming' | 'ready' | 'error'
  isBusy: boolean
  confirming: Record<string, boolean>
  resolveTool: (part: ToolPart, toolName: string, args: unknown, approved: boolean) => void
  send: (text: string) => void
  handleSend: () => void
  parsedError: ParsedChatError | null
}

// Explicit return type annotation is load-bearing, not stylistic: without it
// TS infers a return type that names the pnpm-namespaced `ai` package
// instance (TS2742 "inferred type cannot be named") because two `ai`
// versions are resolved in this monorepo (this package's own `ai` dep vs.
// the one `@clickroom/ai` pulls in transitively) — same class of issue
// `apps/web/src/lib/trpc.ts` already documents for `AppRouter`.
export function useAskAIChat(
  conversationId: string,
  initialMessages: UIMessage[],
): UseAskAIChatResult {
  const [input, setInput] = useState('')

  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: `${AI_API_ORIGIN}/ai/chat`,
        fetch: authedFetch as typeof fetch,
        body: { conversationId },
        // Send only the latest message + conversationId — the server
        // rebuilds full history from Postgres each turn.
        prepareSendMessagesRequest: ({ messages, body }) => ({
          body: { ...body, message: messages.at(-1) },
        }),
      }),
    [conversationId],
  )

  const { messages, sendMessage, addToolResult, status, error } = useChat<UIMessage>({
    id: conversationId,
    messages: initialMessages,
    transport,
    sendAutomaticallyWhen: lastAssistantTurnAwaitsContinuation,
    onError: (e) => {
      console.error('[ask-ai] chat stream error', e)
    },
  })

  const isBusy = status === 'submitted' || status === 'streaming'
  const { confirming, resolveTool } = useToolConfirm(conversationId, addToolResult)

  // Fires once per completed turn (busy -> ready), counting tool-call parts
  // on the last assistant message so `ask_ai_message_sent` reflects what the
  // turn actually did, not just that the user pressed send.
  const wasBusyRef = useRef(false)
  useEffect(() => {
    if (isBusy) {
      wasBusyRef.current = true
      return
    }
    if (!wasBusyRef.current) return
    wasBusyRef.current = false
    const last = messages.at(-1)
    const toolCalls =
      last?.parts?.filter((part) => {
        const type = (part as { type?: string }).type
        return typeof type === 'string' && (type.startsWith('tool-') || type === 'dynamic-tool')
      }).length ?? 0
    track('ask_ai_message_sent', { tool_calls: toolCalls })
  }, [isBusy, messages])

  const send = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || isBusy) return
    void sendMessage({ text: trimmed })
  }
  const handleSend = () => {
    if (!input.trim() || isBusy) return
    send(input)
    setInput('')
  }

  return {
    input,
    setInput,
    messages,
    status,
    isBusy,
    confirming,
    resolveTool,
    send,
    handleSend,
    parsedError: parseChatError(error),
  }
}
