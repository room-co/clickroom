import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import {
  generateText,
  type JSONValue,
  type LanguageModel,
  type ModelMessage,
  type StreamTextResult,
  stepCountIs,
  streamText,
  type ToolSet,
} from 'ai'
import { decryptApiKey } from './crypto.js'
import type {
  AIProvider,
  AIProviderName,
  GenerateTextOptions,
  OrgAISettings,
  StreamChatOptions,
} from './types.js'

export const DEFAULT_MODELS: Record<AIProviderName, string> = {
  anthropic: 'claude-opus-4-8',
  openai: 'gpt-4o',
  google: 'gemini-2.5-pro',
}

// Cheap, fast model per provider for lightweight classification (scope guard).
// Implicit to the customer — they configure only their main provider/model. When
// a provider has no known cheap variant the caller falls back to the customer's
// configured model (see `cheapModelId`).
export const CHEAP_MODELS: Partial<Record<AIProviderName, string>> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4o-mini',
  google: 'gemini-2.5-flash',
}

// A scope classification is a single tiny structured answer; bound it tightly so
// it never adds meaningful latency or holds a connection open.
export const CLASSIFY_TIMEOUT_MS = 12_000
export const CLASSIFY_MAX_OUTPUT_TOKENS = 16

// Bound a single generation so a hung connection cannot hold a request open
// indefinitely. The SDK retries transient errors internally.
export const REQUEST_TIMEOUT_MS = 90_000
export const MAX_RETRIES = 2

// Output budget. Reasoning models (e.g. gemini-2.5-pro) bill their thinking tokens
// against this same cap, so a small cap would starve the visible answer and
// truncate it mid-section. Give a full multi-section answer room to complete.
export const MAX_OUTPUT_TOKENS = 16_384
// Cap reasoning so it can never consume the whole output budget and starve the
// text. Comfortably below MAX_OUTPUT_TOKENS, leaving room for the answer.
export const THINKING_BUDGET_TOKENS = 6_144
// OpenAI reasoning models (o-series, gpt-5*) bound thinking via a coarse effort dial
// rather than a token budget; keep it low so the answer gets the budget. gpt-4o and
// other non-reasoning models ignore / reject this option, so we only set it for models
// whose id marks them as reasoning models.
export const OPENAI_REASONING_EFFORT = 'low'

// Matches OpenAI reasoning model ids: o1, o3, o4-mini, gpt-5, gpt-5-mini, etc.
function isOpenAIReasoningModel(modelId: string): boolean {
  return /^(o\d|gpt-5)/i.test(modelId)
}

// Build a LanguageModel handle for a given provider + model id.
function createModel(provider: AIProviderName, apiKey: string, modelId: string): LanguageModel {
  switch (provider) {
    case 'anthropic':
      return createAnthropic({ apiKey })(modelId)
    case 'openai':
      return createOpenAI({ apiKey })(modelId)
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(modelId)
  }
}

export class UnifiedAIProvider implements AIProvider {
  private readonly model: LanguageModel
  private readonly apiKey: string
  readonly providerName: AIProviderName
  readonly modelId: string

  constructor({
    provider,
    apiKey,
    model,
  }: {
    provider?: AIProviderName
    apiKey: string
    model?: string
  }) {
    // Treat null/empty (not just undefined) as "use anthropic".
    const resolvedProvider: AIProviderName = provider ?? 'anthropic'
    // Treat null/empty (not just undefined) as "use default model".
    const modelId = model?.trim() ? model : DEFAULT_MODELS[resolvedProvider]

    this.providerName = resolvedProvider
    this.modelId = modelId
    this.apiKey = apiKey
    this.model = createModel(resolvedProvider, apiKey, modelId)
  }

  // Cheap model id for this provider, falling back to the customer's configured
  // model when the provider has no known cheap variant.
  private cheapModelId(): string {
    return CHEAP_MODELS[this.providerName] ?? this.modelId
  }

  /**
   * Lightweight scope classification on a cheap, fast model. Returns true when the
   * conversation is in scope. Throws on error/timeout — callers decide fail-open.
   * Expects the system prompt to instruct a single-token answer: IN_SCOPE / OUT_OF_SCOPE.
   */
  async classifyInScope(messages: ModelMessage[], systemPrompt: string): Promise<boolean> {
    const { text } = await generateText({
      model: createModel(this.providerName, this.apiKey, this.cheapModelId()),
      system: systemPrompt,
      messages,
      maxOutputTokens: CLASSIFY_MAX_OUTPUT_TOKENS,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
      experimental_telemetry: { isEnabled: true, functionId: 'ai-scope-guard' },
    })
    // Bias toward in-scope: only an explicit OUT verdict blocks (fail-open intent).
    return !/\bOUT(_|\b)/i.test(text)
  }

  async generateText(
    prompt: string,
    systemPrompt?: string,
    options?: GenerateTextOptions,
  ): Promise<string> {
    const { text } = await generateText({
      model: this.model,
      system: systemPrompt,
      prompt,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      // Reasoning models share the output budget with their thinking tokens; bound
      // the thinking so the visible answer always has room to finish. Google reasons
      // by default (gemini-2.5-pro); OpenAI o-series / gpt-5 reason and are bounded via
      // reasoningEffort; gpt-4o and claude-opus-4-8 emit no reasoning unless enabled.
      providerOptions: this.buildProviderOptions(),
      maxRetries: MAX_RETRIES,
      abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      experimental_telemetry: {
        isEnabled: true,
        functionId: options?.traceName,
        metadata: options?.metadata as Record<string, string | number | boolean> | undefined,
      },
    })
    return text
  }

  streamChat(opts: StreamChatOptions): StreamTextResult<ToolSet, never> {
    return streamText({
      model: this.model,
      system: opts.system,
      messages: opts.messages,
      tools: opts.tools,
      stopWhen: opts.stopWhen ?? stepCountIs(8),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      providerOptions: this.buildProviderOptions(),
      maxRetries: MAX_RETRIES,
      abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      experimental_telemetry: {
        isEnabled: true,
        functionId: opts.traceName,
        metadata: opts.metadata as Record<string, string | number | boolean> | undefined,
      },
    })
  }

  /**
   * Per-provider knobs that keep reasoning from consuming the whole output budget.
   * Returns undefined for non-reasoning models (e.g. gpt-4o, claude-opus-4-8), which
   * emit no thinking tokens at our settings.
   */
  private buildProviderOptions(): Record<string, Record<string, JSONValue>> | undefined {
    if (this.providerName === 'google') {
      return {
        google: {
          thinkingConfig: { thinkingBudget: THINKING_BUDGET_TOKENS, includeThoughts: false },
        },
      }
    }
    if (this.providerName === 'openai' && isOpenAIReasoningModel(this.modelId)) {
      return { openai: { reasoningEffort: OPENAI_REASONING_EFFORT } }
    }
    // anthropic + non-reasoning openai (gpt-4o): extended thinking is off; no bounding.
    return undefined
  }
}

export function createAIProvider(settings: OrgAISettings): AIProvider {
  const apiKey = decryptApiKey(settings.api_key_encrypted)
  const provider = settings.provider ?? 'anthropic'
  return new UnifiedAIProvider({ provider, apiKey, model: settings.model })
}
