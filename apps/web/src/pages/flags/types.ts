// Local mirror of the canonical `filters` shape
// The tRPC `featureFlag.filters` column is typed as `Json` (JsonValue) on the
// wire, so callers cast it to `FlagFilters` at the edit boundary.

import { trpc } from '@/lib/trpc'

// Env now travels as an arbitrary per-project `Environment` slug —
// custom environments), not a fixed 3-value union. Kept as a named alias so
// call sites reads as intentional rather than a bare `string`.
export type FlagEnv = string

/** Wire shape of a project's `Environment` row (dates serialize as strings). */
export interface Environment {
  id: string
  projectId: string
  key: string
  name: string
  color: string | null
  isDefault: boolean
  createdAt: string
}

/** Fetch the current project's environments — shared by every env-aware
 * flags/keys UI (flag list/detail env tabs, new-flag/new-key env selects,
 * environments management). */
export function useEnvironments(projectId: string | null | undefined) {
  return trpc.environments.list.useQuery(
    { projectId: projectId as string },
    { enabled: !!projectId },
  )
}

/** The project's `isDefault` environment key, falling back to the first
 * (earliest-created) one — mirrors the API's `defaultEnvironment` fallback. */
export function defaultEnvKey(environments: Environment[] | undefined): string | undefined {
  if (!environments || environments.length === 0) return undefined
  return environments.find((e) => e.isDefault)?.key ?? environments[0].key
}

export const FLAG_OPERATORS = ['exact', 'is_not', 'icontains', 'gt', 'lt', 'is_set'] as const

export type FlagOperator = (typeof FLAG_OPERATORS)[number]

/** Operators that ignore their `value` (presence check only). */
export const VALUELESS_OPERATORS: ReadonlySet<FlagOperator> = new Set<FlagOperator>(['is_set'])

export const OPERATOR_LABELS: Record<FlagOperator, string> = {
  exact: 'equals',
  is_not: 'is not',
  icontains: 'contains',
  gt: 'greater than',
  lt: 'less than',
  is_set: 'is set',
}

export interface FlagProperty {
  key: string
  operator: FlagOperator
  value: unknown
}

export interface FlagGroup {
  properties: FlagProperty[]
  rollout_percentage: number
  /** Pin the group to a variant, or null for boolean/first-variant behaviour. */
  variant: string | null
  /** Boolean served to a matched, in-rollout user. Absent means `true`. */
  serve?: boolean
}

export interface FlagVariant {
  key: string
  rollout_percentage: number
}

export interface FlagMultivariate {
  variants: FlagVariant[]
}

/** Discriminates boolean flags from value-based (string/number) flags. */
export type FlagKind = 'boolean' | 'string' | 'number'

const FLAG_KINDS = new Set<FlagKind>(['boolean', 'string', 'number'])

export interface FlagFilters {
  groups: FlagGroup[]
  /** OMITTED for boolean flags. */
  multivariate?: FlagMultivariate
  /** variant key -> arbitrary payload JSON. */
  payloads?: Record<string, unknown>
  /** Flag value type. OMITTED on legacy rows created before this field existed. */
  kind?: FlagKind
}

const EMPTY_FILTERS: FlagFilters = { groups: [] }

/** Narrow an unknown JSON value into a `FlagFilters` with sane fallbacks. */
export function toFlagFilters(value: unknown): FlagFilters {
  if (!value || typeof value !== 'object') return { groups: [] }
  const v = value as Partial<FlagFilters>
  return {
    groups: Array.isArray(v.groups) ? (v.groups as FlagGroup[]) : [],
    multivariate:
      v.multivariate && Array.isArray(v.multivariate.variants) ? v.multivariate : undefined,
    payloads:
      v.payloads && typeof v.payloads === 'object'
        ? (v.payloads as Record<string, unknown>)
        : undefined,
    kind: typeof v.kind === 'string' && FLAG_KINDS.has(v.kind as FlagKind) ? v.kind : undefined,
  }
}

/**
 * Resolve the effective `FlagKind` for a flag, falling back to inference for
 * legacy rows saved before `kind` was stamped. Legacy rows can't distinguish
 * string vs number, so we guess `'string'` — the only pre-existing pattern
 * (e.g. signup-mode) used string variants.
 */
export function flagKind(filters: FlagFilters): FlagKind {
  if (filters.kind) return filters.kind
  const hasVariantGroups = filters.groups.some(
    (g) => typeof g.variant === 'string' && g.variant !== null,
  )
  const hasPayloads = !!filters.payloads && Object.keys(filters.payloads).length > 0
  return hasVariantGroups || hasPayloads ? 'string' : 'boolean'
}

/** Flatten a flag's `payloads` map into an ordered key/value list. */
export function flagValueSet(filters: FlagFilters): Array<{ key: string; value: string | number }> {
  if (!filters.payloads) return []
  return Object.entries(filters.payloads)
    .filter((entry): entry is [string, string | number] => {
      const [, val] = entry
      return typeof val === 'string' || typeof val === 'number'
    })
    .map(([key, value]) => ({ key, value }))
}

/**
 * Build the `FlagFilters` shape for a value-based (string/number) flag:
 * `payloads` from `values`, targeting `rules` in order, then a catch-all
 * group pinned to `defaultKey`. Never emits `multivariate` — its presence
 * changes evaluator behaviour and value flags must not carry it.
 */
export function buildValueFlagFilters(
  kind: Extract<FlagKind, 'string' | 'number'>,
  values: Array<{ key: string; value: string | number }>,
  defaultKey: string,
  rules: Array<{ properties: FlagProperty[]; variant: string }>,
): FlagFilters {
  const payloads: Record<string, unknown> = {}
  for (const { key, value } of values) {
    payloads[key] = value
  }
  const groups: FlagGroup[] = [
    ...rules.map((r) => ({
      properties: r.properties,
      rollout_percentage: 100,
      variant: r.variant,
    })),
    { properties: [], rollout_percentage: 100, variant: defaultKey },
  ]
  return { groups, payloads, kind }
}

// ── Boolean flags: ordered rules + an explicit DEFAULT group ─────────────────

/** One boolean targeting rule: conditions AND-ed, served to `rollout`% of matches. */
export interface BooleanRule {
  properties: FlagProperty[]
  rollout: number
  serve: boolean
}

/**
 * Index of the trailing catch-all group that encodes the boolean DEFAULT (what a
 * user matching no rule is served), or -1 when the flag has none.
 *
 * A group is the DEFAULT iff it is last, has no conditions, AND carries an
 * explicit `serve`. That last requirement is what disambiguates it from a legacy
 * no-rules boolean flag, whose single group is also last and condition-less but
 * predates the field. Legacy rows therefore read as "every group is a rule,
 * default = false" — exactly what they mean today.
 */
function defaultGroupIndex(groups: FlagGroup[]): number {
  const i = groups.length - 1
  const last = groups[i]
  if (!last) return -1
  return last.properties.length === 0 && typeof last.serve === 'boolean' ? i : -1
}

/** Split a boolean flag's groups into its rules and its DEFAULT value. */
export function parseBooleanFlagFilters(filters: FlagFilters): {
  rules: BooleanRule[]
  defaultServe: boolean
} {
  const di = defaultGroupIndex(filters.groups)
  const ruleGroups = di === -1 ? filters.groups : filters.groups.slice(0, di)
  return {
    rules: ruleGroups.map((g) => ({
      properties: g.properties ?? [],
      rollout: g.rollout_percentage,
      // Absent `serve` means ON — every group written before the field existed.
      serve: g.serve ?? true,
    })),
    defaultServe: di === -1 ? false : (filters.groups[di].serve ?? false),
  }
}

/**
 * Build the `FlagFilters` for a boolean flag: targeting `rules` in order, then a
 * catch-all DEFAULT group. The DEFAULT group always carries an explicit `serve`
 * (even when `true`) — that is the marker `defaultGroupIndex` reads it back by.
 */
export function buildBooleanFlagFilters(rules: BooleanRule[], defaultServe: boolean): FlagFilters {
  return {
    groups: [
      ...rules.map((r) => ({
        properties: r.properties,
        rollout_percentage: r.rollout,
        variant: null,
        serve: r.serve,
      })),
      { properties: [], rollout_percentage: 100, variant: null, serve: defaultServe },
    ],
    kind: 'boolean',
  }
}

// ── Serving summary — "who gets what", shared by the detail tab and the list ──

/** One row of the ordered "who gets what" reading of a flag. */
export interface ServingRow {
  /** Who the row applies to, in plain English. */
  audience: string
  /** What they are served. */
  serves: string
  /** Share of the audience that gets `serves`; the rest get `false` and stop. */
  rollout: number
  /** True when an earlier row already matches everyone, so this row never runs. */
  unreachable: boolean
  isDefault: boolean
}

/** `org_id equals cmp7pex…` */
export function describeProperty(p: FlagProperty): string {
  const op = OPERATOR_LABELS[p.operator] ?? p.operator
  if (VALUELESS_OPERATORS.has(p.operator)) return `${p.key} ${op}`
  return `${p.key} ${op} ${String(p.value)}`
}

const describeAudience = (properties: FlagProperty[]): string =>
  properties.length === 0 ? 'Everyone' : properties.map(describeProperty).join(' and ')

/**
 * A group with no conditions matches *every* user, so no group after it is ever
 * reached — regardless of its rollout, because a matched-but-rolled-off user
 * stops rather than falling through. Returns the index of the first such group.
 */
const swallowIndex = (conditionCounts: number[]): number => conditionCounts.indexOf(0)

function booleanServingRows(filters: FlagFilters): ServingRow[] {
  const { rules, defaultServe } = parseBooleanFlagFilters(filters)
  const swallow = swallowIndex(rules.map((r) => r.properties.length))
  const ruleRows = rules.map<ServingRow>((r, i) => ({
    audience: describeAudience(r.properties),
    serves: String(r.serve),
    rollout: r.rollout,
    unreachable: swallow !== -1 && i > swallow,
    isDefault: false,
  }))
  return [
    ...ruleRows,
    {
      audience: 'Everyone else',
      serves: String(defaultServe),
      rollout: 100,
      unreachable: swallow !== -1,
      isDefault: true,
    },
  ]
}

function valueServingRows(filters: FlagFilters): ServingRow[] {
  const payloads = filters.payloads ?? {}
  const lastIndex = filters.groups.length - 1
  const swallow = swallowIndex(filters.groups.map((g) => g.properties.length))
  return filters.groups.map<ServingRow>((g, i) => {
    const key = g.variant ?? ''
    const isDefault = i === lastIndex && g.properties.length === 0
    return {
      audience: isDefault ? 'Everyone else' : describeAudience(g.properties),
      serves: String(payloads[key] ?? key),
      rollout: g.rollout_percentage,
      unreachable: swallow !== -1 && i > swallow,
      isDefault,
    }
  })
}

/** Ordered, plain-English reading of what each cohort is served. */
export function servingSummary(filters: FlagFilters): ServingRow[] {
  if (filters.groups.length === 0) return []
  return flagKind(filters) === 'boolean' ? booleanServingRows(filters) : valueServingRows(filters)
}

/** What a user matching no rule is served — the headline "value for all users". */
export function defaultServedValue(value: unknown): string | null {
  const filters = value ? toFlagFilters(value) : EMPTY_FILTERS
  return servingSummary(filters).find((r) => r.isDefault)?.serves ?? null
}

/** Compact human summary of a flag's targeting for the list table. */
export function rolloutSummary(value: unknown): string {
  const filters = value ? toFlagFilters(value) : EMPTY_FILTERS
  if (filters.groups.length === 0) return 'No conditions'

  const mv = filters.multivariate
  if (mv) return `${mv.variants.length} variants`

  const rows = servingSummary(filters)
  const rules = rows.filter((r) => !r.isDefault)
  const fallback = rows.find((r) => r.isDefault)

  let lead: string
  if (rules.length === 0) lead = 'No rules'
  else if (rules.length === 1 && rules[0].audience === 'Everyone') {
    const only = rules[0]
    lead = `Everyone → ${only.serves}${only.rollout < 100 ? ` (${only.rollout}%)` : ''}`
  } else lead = `${rules.length} rule${rules.length === 1 ? '' : 's'}`

  return fallback ? `${lead} · default ${fallback.serves}` : lead
}
