export type { ModelMessage, ToolSet, UIMessage } from 'ai'
// Re-export the AI SDK primitives consumers (e.g. apps/api's Ask AI controller)
// need to build tool sets and convert UI messages. Routing these through this
// package guarantees every caller shares the SAME `ai` module instance the
// provider uses, so ToolSet / ModelMessage / UIMessage types never diverge
// across pnpm zod-variant boundaries.
export { convertToModelMessages, stepCountIs, tool } from 'ai'
export { decryptApiKey, encryptApiKey } from './crypto.js'
export { CHEAP_MODELS, createAIProvider, DEFAULT_MODELS, UnifiedAIProvider } from './provider.js'
export type {
  AIProvider,
  AIProviderName,
  GenerateTextOptions,
  OrgAISettings,
  StreamChatOptions,
} from './types.js'
