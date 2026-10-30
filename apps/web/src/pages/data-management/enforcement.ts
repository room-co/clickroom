import type { EnforcementMode } from './types'

/** Shared enforcement-mode option list — used by the per-row select in
 * `SchemaTab` and the initial-mode picker in `AddEventDialog`. */
export const ENFORCEMENT_OPTIONS: { value: EnforcementMode; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'warn', label: 'Warn' },
  { value: 'strict', label: 'Strict' },
]
