import type { AIProvider, ModelMessage } from '@clickroom/ai'
import { Injectable } from '@nestjs/common'
import {
  buildScopeClassifierPrompt,
  classifierMessages,
  extractLatestAssistantText,
  extractLatestUserText,
} from './scope-guard.js'

/**
 * Layer 2 of the Ask AI guard: a cheap pre-flight classifier that decides
 * whether the latest user turn is in scope. Injectable so the controller
 * test can mock it.
 *
 * FAIL-OPEN by design: any classifier error/timeout resolves to
 * `inScope: true` so a guard outage never blocks legitimate analytics work
 * — the hardened system prompt (Layer 1) still applies as the backstop, and
 * real safety comes from tool-level RBAC via the loopback client's real
 * authz (every tool call still re-enters `requirePermission`/
 * `scopedForProject`), not this classifier. Matches the reference implementation's stance.
 */
@Injectable()
export class ScopeGuardService {
  async check(provider: AIProvider, messages: ModelMessage[]): Promise<{ inScope: boolean }> {
    const text = extractLatestUserText(messages)
    // Nothing classifiable (e.g. a tool-only turn) -> let it through.
    if (!text) return { inScope: true }
    const priorAssistant = extractLatestAssistantText(messages)
    try {
      const inScope = await provider.classifyInScope(
        classifierMessages(text, priorAssistant),
        buildScopeClassifierPrompt(),
      )
      return { inScope }
    } catch {
      return { inScope: true }
    }
  }
}
