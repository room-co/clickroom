import type { ModelMessage, StopCondition, StreamTextResult, ToolSet } from 'ai'

export type AIProviderName = 'anthropic' | 'openai' | 'google'

export interface GenerateTextOptions {
  /**
   * Logical name for this generation, surfaced as the tracing span name
   * (ai-sdk `experimental_telemetry.functionId`). Helps group related calls in
   * a tracing UI.
   */
  traceName?: string
  /**
   * Arbitrary key/value metadata attached to the trace
   * (ai-sdk `experimental_telemetry.metadata`), e.g. orgId or projectId.
   */
  metadata?: Record<string, unknown>
}

export interface StreamChatOptions {
  messages: ModelMessage[]
  system?: string
  tools?: ToolSet
  stopWhen?: StopCondition<ToolSet>
  /**
   * Logical name for this stream, surfaced as the tracing span name
   * (ai-sdk `experimental_telemetry.functionId`).
   */
  traceName?: string
  /**
   * Arbitrary key/value metadata attached to the trace
   * (ai-sdk `experimental_telemetry.metadata`).
   */
  metadata?: Record<string, unknown>
}

export interface AIProvider {
  readonly providerName: AIProviderName
  readonly modelId: string
  generateText(
    prompt: string,
    systemPrompt?: string,
    options?: GenerateTextOptions,
  ): Promise<string>
  streamChat(opts: StreamChatOptions): StreamTextResult<ToolSet, never>
  /**
   * Lightweight scope classification on a cheap, fast model. Resolves true when
   * the conversation is in scope. Throws on error/timeout (callers fail-open).
   */
  classifyInScope(messages: ModelMessage[], systemPrompt: string): Promise<boolean>
}

export type OrgAISettings = {
  api_key_encrypted: string
  provider?: AIProviderName
  model?: string
}

export interface EncryptedBlob {
  iv: string
  ciphertext: string
  tag: string
}
