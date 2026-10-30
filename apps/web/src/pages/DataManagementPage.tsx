import {
  Activity,
  AlertTriangle,
  Cable,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  CircleX,
  Clock,
  Copy,
  Download,
  FileJson,
  FileSpreadsheet,
  HardDrive,
  Plug,
  Plus,
  RefreshCw,
  Table2,
  ToggleLeft,
  Trash2,
  Users,
  Workflow,
  X,
  Zap,
} from 'lucide-react'
import type React from 'react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { ClickHouseIcon } from '@/components/icons/ClickHouseIcon'
import { PageHeader } from '@/components/PageHeader'
import { planLabel, UsageSummaryPanel } from '@/components/UsageSummaryPanel'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getDeployment } from '@/lib/runtime-config'
import { trpc } from '@/lib/trpc'
import { useProjectId } from '@/lib/use-project'
import { cn } from '@/lib/utils'
import { SchemaTab } from './data-management/SchemaTab'
import { TableEmpty, TableError, TableLoading } from './data-management/states'

// ── Data Management Page ──────────────────────────────────────────────────────

type DataTab = 'sources' | 'exports' | 'pipelines' | 'schema' | 'retention'

// ·· Exports ··

type ExportFormat = 'csv' | 'json' | 'parquet' | 'ndjson'
type ExportStatus = 'ready' | 'running' | 'failed' | 'scheduled'

interface ExportJob {
  id: string
  name: string
  format: ExportFormat
  dataset: string
  range: string
  size: string | null
  rows: number | null
  status: ExportStatus
  created: string
  duration: string | null
}

const EXPORT_JOBS: ExportJob[] = [
  {
    id: 'ex1',
    name: 'Events Jul 2026',
    format: 'parquet',
    dataset: 'events',
    range: 'Jul 1–4, 2026',
    size: '18.4 MB',
    rows: 247832,
    status: 'ready',
    created: 'Jul 4, 2026 14:01',
    duration: '12s',
  },
  {
    id: 'ex2',
    name: 'Users snapshot',
    format: 'csv',
    dataset: 'users',
    range: 'All time',
    size: '2.1 MB',
    rows: 34219,
    status: 'ready',
    created: 'Jul 3, 2026 09:22',
    duration: '4s',
  },
  {
    id: 'ex3',
    name: 'Funnel events Jun',
    format: 'json',
    dataset: 'events',
    range: 'Jun 1–30, 2026',
    size: '44.7 MB',
    rows: 612400,
    status: 'ready',
    created: 'Jul 1, 2026 00:05',
    duration: '38s',
  },
  {
    id: 'ex4',
    name: 'Weekly digest',
    format: 'csv',
    dataset: 'events',
    range: 'Jun 27–Jul 3',
    size: null,
    rows: null,
    status: 'running',
    created: 'Jul 4, 2026 14:32',
    duration: null,
  },
  {
    id: 'ex5',
    name: 'Feature flag audit',
    format: 'ndjson',
    dataset: 'flags',
    range: 'All time',
    size: '0.3 MB',
    rows: 1840,
    status: 'ready',
    created: 'Jun 28, 2026 11:45',
    duration: '2s',
  },
  {
    id: 'ex6',
    name: 'Q1 full export',
    format: 'parquet',
    dataset: 'events',
    range: 'Jan–Mar 2026',
    size: null,
    rows: null,
    status: 'failed',
    created: 'Jun 15, 2026 03:00',
    duration: null,
  },
  {
    id: 'ex7',
    name: 'Monthly auto-export',
    format: 'parquet',
    dataset: 'events',
    range: 'Recurring · 1st of month',
    size: null,
    rows: null,
    status: 'scheduled',
    created: 'May 1, 2026 00:00',
    duration: null,
  },
]

const formatIcon: Record<ExportFormat, React.ElementType> = {
  csv: FileSpreadsheet,
  json: FileJson,
  parquet: HardDrive,
  ndjson: FileJson,
}

const formatColor: Record<ExportFormat, string> = {
  csv: 'text-emerald-400 bg-emerald-500/10',
  json: 'text-amber-400  bg-amber-500/10',
  parquet: 'text-violet-400 bg-violet-500/10',
  ndjson: 'text-blue-400   bg-blue-500/10',
}

function ExportStatusBadge({ status }: { status: ExportStatus }) {
  const map: Record<ExportStatus, { label: string; cls: string; icon: React.ElementType }> = {
    ready: { label: 'Ready', cls: 'text-teal-400 bg-teal-500/10', icon: CheckCircle2 },
    running: { label: 'Running', cls: 'text-blue-400 bg-blue-500/10', icon: CircleDashed },
    failed: { label: 'Failed', cls: 'text-red-400 bg-red-500/10', icon: CircleX },
    scheduled: { label: 'Scheduled', cls: 'text-amber-400 bg-amber-500/10', icon: Clock },
  }
  const { label, cls, icon: Icon } = map[status]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full',
        cls,
      )}
    >
      <Icon className="w-3 h-3" />
      {label}
    </span>
  )
}

// Create export drawer
function CreateExportPanel({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (j: ExportJob) => void
}) {
  const [name, setName] = useState('')
  const [dataset, setDataset] = useState('events')
  const [format, setFormat] = useState<ExportFormat>('parquet')
  const [rangeFrom, setFrom] = useState('2026-07-01')
  const [rangeTo, setTo] = useState('2026-07-04')
  const [recurring, setRecurring] = useState(false)
  const [error, setError] = useState('')

  const submit = () => {
    if (!name.trim()) {
      setError('Name is required.')
      return
    }
    setError('')
    const job: ExportJob = {
      id: `ex${Date.now()}`,
      name: name.trim(),
      format,
      dataset,
      range: recurring ? 'Recurring · monthly' : `${rangeFrom} → ${rangeTo}`,
      size: null,
      rows: null,
      status: recurring ? 'scheduled' : 'running',
      created: 'Jul 4, 2026 (now)',
      duration: null,
    }
    onCreate(job)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-40 flex">
      <button
        type="button"
        aria-label="Close overlay"
        className="absolute inset-0 bg-black/50 border-0"
        onClick={onClose}
      />
      <div className="relative ml-auto w-full md:max-w-[400px] h-full bg-card border-l border-border flex flex-col shadow-2xl shadow-black/40">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-primary/15 flex items-center justify-center">
              <Download className="w-3.5 h-3.5 text-primary" />
            </div>
            <span className="text-sm font-semibold text-foreground">New export</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-5 space-y-5">
          <div>
            <label
              htmlFor="export-name"
              className="block text-[11px] font-medium text-muted-foreground mb-1.5"
            >
              Export name
            </label>
            <input
              id="export-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Events Jul 2026"
              className="w-full bg-muted/30 border border-border rounded-md text-xs px-3 py-2.5 text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/60 transition-colors"
            />
          </div>

          <div>
            <span className="block text-[11px] font-medium text-muted-foreground mb-2">
              Dataset
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {['events', 'users', 'flags'].map((d) => (
                <button
                  type="button"
                  key={d}
                  onClick={() => setDataset(d)}
                  className={cn(
                    'py-2 rounded-md text-[11px] font-medium border capitalize transition-colors',
                    dataset === d
                      ? 'bg-primary/10 text-primary border-primary/25'
                      : 'border-border text-muted-foreground hover:text-foreground hover:border-border/80',
                  )}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className="block text-[11px] font-medium text-muted-foreground mb-2">Format</span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {(['parquet', 'csv', 'json', 'ndjson'] as ExportFormat[]).map((f) => {
                const Icon = formatIcon[f]
                return (
                  <button
                    type="button"
                    key={f}
                    onClick={() => setFormat(f)}
                    className={cn(
                      'flex items-center gap-2 px-3 py-2.5 rounded-md border text-left transition-colors',
                      format === f
                        ? 'bg-primary/5 border-primary/25'
                        : 'border-border hover:border-border/80 hover:bg-muted/20',
                    )}
                  >
                    <Icon
                      className={cn(
                        'w-4 h-4 shrink-0',
                        format === f ? 'text-primary' : 'text-muted-foreground',
                      )}
                    />
                    <div>
                      <div
                        className={cn(
                          'text-[11px] font-medium uppercase',
                          format === f ? 'text-primary' : 'text-foreground',
                        )}
                      >
                        {f}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {f === 'parquet'
                          ? 'Best for analytics'
                          : f === 'csv'
                            ? 'Spreadsheet-ready'
                            : f === 'json'
                              ? 'Nested records'
                              : 'Streaming-friendly'}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          {!recurring && (
            <div>
              <span className="block text-[11px] font-medium text-muted-foreground mb-2">
                Date range
              </span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <div className="text-[10px] text-muted-foreground mb-1">From</div>
                  <input
                    type="date"
                    value={rangeFrom}
                    onChange={(e) => setFrom(e.target.value)}
                    className="w-full bg-muted/30 border border-border rounded-md text-xs px-3 py-2 text-foreground focus:outline-none focus:ring-1 focus:ring-primary/60 transition-colors"
                  />
                </div>
                <div>
                  <div className="text-[10px] text-muted-foreground mb-1">To</div>
                  <input
                    type="date"
                    value={rangeTo}
                    onChange={(e) => setTo(e.target.value)}
                    className="w-full bg-muted/30 border border-border rounded-md text-xs px-3 py-2 text-foreground focus:outline-none focus:ring-1 focus:ring-primary/60 transition-colors"
                  />
                </div>
              </div>
            </div>
          )}

          <div>
            <button
              type="button"
              onClick={() => setRecurring(!recurring)}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-3 rounded-md border text-left transition-colors',
                recurring
                  ? 'border-primary/25 bg-primary/5'
                  : 'border-border hover:border-border/80 hover:bg-muted/20',
              )}
            >
              <div
                className={cn(
                  'w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors',
                  recurring ? 'bg-primary border-primary' : 'border-border bg-muted/30',
                )}
              >
                {recurring && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
              </div>
              <div>
                <div className="text-[11px] font-medium text-foreground">
                  Schedule recurring export
                </div>
                <div className="text-[10px] text-muted-foreground">
                  Auto-export on the 1st of each month
                </div>
              </div>
            </button>
          </div>

          {error && <p className="text-[11px] text-red-400 font-medium">{error}</p>}
        </div>

        <div className="px-5 py-4 border-t border-border shrink-0 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-2 text-xs text-muted-foreground border border-border rounded-md hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            className="flex-1 py-2 text-xs font-semibold bg-primary text-primary-foreground rounded-md hover:opacity-90 transition-opacity"
          >
            Create export
          </button>
        </div>
      </div>
    </div>
  )
}

// ·· Pipelines ··

type PipelineStatus = 'connected' | 'error' | 'paused' | 'pending'

interface Pipeline {
  id: string
  name: string
  provider: string
  service: string
  destination: string
  eventsPerDay: number | null
  latency: string | null
  status: PipelineStatus
  connected: string
  lastSync: string | null
}

const AWS_SERVICES = [
  {
    id: 's3',
    name: 'Amazon S3',
    desc: 'Object storage — batch file drops',
    icon: '🪣',
    color: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  },
  {
    id: 'kinesis',
    name: 'Kinesis Data Streams',
    desc: 'Real-time event streaming',
    icon: '⚡',
    color: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
  },
  {
    id: 'redshift',
    name: 'Amazon Redshift',
    desc: 'Data warehouse — SQL queries',
    icon: '🔴',
    color: 'text-red-400 bg-red-500/10 border-red-500/20',
  },
  {
    id: 'firehose',
    name: 'Kinesis Firehose',
    desc: 'Managed delivery to S3 / Redshift',
    icon: '🔥',
    color: 'text-orange-400 bg-orange-500/10 border-orange-500/20',
  },
  {
    id: 'sqs',
    name: 'Amazon SQS',
    desc: 'Message queue for async processing',
    icon: '📨',
    color: 'text-violet-400 bg-violet-500/10 border-violet-500/20',
  },
  {
    id: 'glue',
    name: 'AWS Glue',
    desc: 'ETL jobs and data catalog',
    icon: '🔧',
    color: 'text-teal-400 bg-teal-500/10 border-teal-500/20',
  },
]

const OTHER_SERVICES = [
  {
    id: 'bq',
    name: 'BigQuery',
    desc: 'Google Cloud data warehouse',
    icon: '📊',
    color: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
  },
  {
    id: 'snowflake',
    name: 'Snowflake',
    desc: 'Cloud data platform',
    icon: '❄️',
    color: 'text-sky-400 bg-sky-500/10 border-sky-500/20',
  },
  {
    id: 'segment',
    name: 'Segment',
    desc: 'CDP — forward events downstream',
    icon: '◉',
    color: 'text-green-400 bg-green-500/10 border-green-500/20',
  },
  {
    id: 'webhook',
    name: 'Webhook',
    desc: 'POST events to any HTTP endpoint',
    icon: '↗',
    color: 'text-muted-foreground bg-muted/30 border-border',
  },
]

const INITIAL_PIPELINES: Pipeline[] = [
  {
    id: 'p1',
    name: 'Prod events → S3',
    provider: 'AWS',
    service: 's3',
    destination: 's3://cr-acme-prod/events/',
    eventsPerDay: 247832,
    latency: '~15 min',
    status: 'connected',
    connected: 'Feb 10, 2026',
    lastSync: 'Jul 4, 2026 14:28',
  },
  {
    id: 'p2',
    name: 'Kinesis real-time',
    provider: 'AWS',
    service: 'kinesis',
    destination: 'arn:aws:kinesis:us-east-1:…:cr-events',
    eventsPerDay: 247832,
    latency: '< 1s',
    status: 'connected',
    connected: 'Mar 5, 2026',
    lastSync: 'Jul 4, 2026 14:32',
  },
  {
    id: 'p3',
    name: 'Redshift warehouse',
    provider: 'AWS',
    service: 'redshift',
    destination: 'cr-dw.us-east-1.redshift.amazonaws.com',
    eventsPerDay: null,
    latency: 'Hourly batch',
    status: 'error',
    connected: 'Apr 12, 2026',
    lastSync: 'Jul 3, 2026 18:00',
  },
  {
    id: 'p4',
    name: 'BigQuery mirror',
    provider: 'GCP',
    service: 'bq',
    destination: 'acme-analytics.clickroom.events',
    eventsPerDay: 247832,
    latency: '~5 min',
    status: 'paused',
    connected: 'May 1, 2026',
    lastSync: 'Jun 28, 2026 00:00',
  },
]

function PipelineStatusBadge({ status }: { status: PipelineStatus }) {
  const map: Record<PipelineStatus, { label: string; cls: string }> = {
    connected: { label: 'Connected', cls: 'text-teal-400 bg-teal-500/10' },
    error: { label: 'Error', cls: 'text-red-400 bg-red-500/10' },
    paused: { label: 'Paused', cls: 'text-amber-400 bg-amber-500/10' },
    pending: { label: 'Pending', cls: 'text-blue-400 bg-blue-500/10' },
  }
  const { label, cls } = map[status]
  return (
    <span className={cn('text-[10px] font-medium px-2 py-0.5 rounded-full', cls)}>{label}</span>
  )
}

// tRPC infers `config: Json` on `DataSource` down to Prisma's recursive
// `JsonValue` union, which blows up `tsc`'s instantiation depth when chained
// through `.map()` here — mirrors the `SavedVisualization` cast pattern in
// SqlExplorerPage.tsx for the same reason.
type DataSourceRow = {
  id: string
  name: string
  type: string
  status: string
  isDefault: boolean
}

function SourceStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    connected: { label: 'Connected', cls: 'text-teal-400 bg-teal-500/10' },
    error: { label: 'Error', cls: 'text-red-400 bg-red-500/10' },
    disabled: { label: 'Disabled', cls: 'text-muted-foreground bg-muted/40' },
  }
  const { label, cls } = map[status] ?? { label: status, cls: 'text-muted-foreground bg-muted/40' }
  return (
    <span className={cn('text-[10px] font-medium px-2 py-0.5 rounded-full', cls)}>{label}</span>
  )
}

// ·· Retention ··

// `plan: null` means "current plan" — resolved to the real plan name at
// render time from `usage.summary`, rather than a hardcoded tier name.
const RETENTION_RULES = [
  { dataset: 'Raw events', current: '90 days', plan: null, icon: Zap },
  { dataset: 'Sessions', current: '90 days', plan: null, icon: Activity },
  { dataset: 'User profiles', current: 'Indefinite', plan: null, icon: Users },
  { dataset: 'Feature flag evaluations', current: '30 days', plan: null, icon: ToggleLeft },
  { dataset: 'Export files', current: '14 days', plan: 'All plans', icon: Download },
]

// ·· Main page ··

const DATA_TABS: DataTab[] = ['sources', 'exports', 'pipelines', 'schema', 'retention']

// Self-host: Sources/Exports/Pipelines/Retention render fixture data and the
// retention periods are not enforced, so only the working Schema tab is offered.
const SELF_HOST_DATA_TABS: DataTab[] = ['schema']

export function DataManagementPage() {
  const projectId = useProjectId()
  const [searchParams] = useSearchParams()
  // Cross-page deep link support (e.g. Events page's "Add Event" button links
  // to `/data-management?tab=schema&create=1`) — the initial tab is seeded
  // from the URL once; subsequent in-page tab clicks stay local state only.
  const selfHost = getDeployment() === 'self_host'
  const availableTabs = selfHost ? SELF_HOST_DATA_TABS : DATA_TABS
  const initialTabParam = searchParams.get('tab')
  const initialTab: DataTab =
    initialTabParam && (availableTabs as string[]).includes(initialTabParam)
      ? (initialTabParam as DataTab)
      : selfHost
        ? 'schema'
        : 'exports'
  const [tab, setTab] = useState<DataTab>(initialTab)
  const [exports, setExports] = useState<ExportJob[]>(EXPORT_JOBS)
  const [pipelines, setPipelines] = useState<Pipeline[]>(INITIAL_PIPELINES)
  const [showCreateExport, setShowCreateExport] = useState(false)
  const [showConnectModal, setShowConnectModal] = useState<string | null>(null)
  const [copiedDestination, setCopiedDestination] = useState<string | null>(null)

  const copyDest = (id: string, text: string) => {
    navigator.clipboard.writeText(text)
    setCopiedDestination(id)
    setTimeout(() => setCopiedDestination(null), 2000)
  }

  const tabs = (
    [
      { id: 'sources', label: 'Sources', icon: Cable },
      { id: 'exports', label: 'Exports', icon: Download },
      { id: 'pipelines', label: 'Pipelines', icon: Workflow },
      { id: 'schema', label: 'Schema', icon: Table2 },
      { id: 'retention', label: 'Retention', icon: HardDrive },
    ] satisfies { id: DataTab; label: string; icon: React.ElementType }[]
  ).filter((t) => availableTabs.includes(t.id))

  const usageQuery = trpc.usage.summary.useQuery(undefined, { enabled: !selfHost })
  const currentPlanLabel = planLabel(usageQuery.data?.planKey ?? null)

  const sourcesQuery = trpc.dataSources.list.useQuery(
    { projectId: projectId ?? '' },
    { enabled: !!projectId && !selfHost },
  )

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader
        title="Data"
        subtitle={selfHost ? 'Event schema' : 'Sources · Exports · Pipelines · Schema · Retention'}
      >
        {tab === 'sources' ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-disabled="true"
                onClick={(e) => e.preventDefault()}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded text-xs font-medium opacity-50 cursor-not-allowed"
              >
                <Plus className="w-3.5 h-3.5" />
                Add source
              </button>
            </TooltipTrigger>
            <TooltipContent>External sources coming soon</TooltipContent>
          </Tooltip>
        ) : tab === 'exports' ? (
          <button
            type="button"
            onClick={() => setShowCreateExport(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded text-xs font-medium hover:opacity-90 transition-opacity"
          >
            <Plus className="w-3.5 h-3.5" />
            New export
          </button>
        ) : tab === 'pipelines' ? (
          <button
            type="button"
            onClick={() => setShowConnectModal('new')}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded text-xs font-medium hover:opacity-90 transition-opacity"
          >
            <Plug className="w-3.5 h-3.5" />
            Connect pipeline
          </button>
        ) : null}
      </PageHeader>

      {/* Tab bar */}
      <div className="px-5 border-b border-border flex gap-0 shrink-0">
        {tabs.map((t) => (
          <button
            type="button"
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-3 text-xs font-medium border-b-2 -mb-px transition-colors',
              tab === t.id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Sources tab ── */}
      {tab === 'sources' && (
        <div className="flex-1 overflow-auto p-5 space-y-6">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-3">
              Connected sources
            </div>
            {sourcesQuery.isPending ? (
              <TableLoading rows={1} />
            ) : sourcesQuery.isError ? (
              <TableError message={sourcesQuery.error.message} />
            ) : sourcesQuery.data.length === 0 ? (
              <TableEmpty message="No data sources configured for this project yet." />
            ) : (
              <div className="space-y-2">
                {(sourcesQuery.data as unknown as DataSourceRow[]).map((source) => (
                  <div
                    key={source.id}
                    className="bg-card border border-border hover:border-border/80 rounded-lg px-4 py-3.5 flex flex-col gap-3 transition-colors sm:flex-row sm:items-center sm:gap-4"
                  >
                    <div
                      className="w-8 h-8 rounded-lg border flex items-center justify-center shrink-0 bg-muted/20"
                      style={{ borderColor: 'rgba(255,255,255,0.08)' }}
                    >
                      <ClickHouseIcon className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-medium text-foreground">{source.name}</span>
                        <span className="text-[10px] font-mono uppercase text-muted-foreground bg-muted/40 px-1.5 py-0.5 rounded">
                          {source.type}
                        </span>
                        <SourceStatusBadge status={source.status} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Exports tab ── */}
      {tab === 'exports' && (
        <div className="flex-1 overflow-auto">
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 bg-background z-10">
                <tr className="border-b border-border">
                  {[
                    'Name',
                    'Dataset',
                    'Format',
                    'Range',
                    'Rows',
                    'Size',
                    'Status',
                    'Created',
                    '',
                  ].map((h) => (
                    <th
                      key={h}
                      className="text-left px-4 py-2.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {exports.map((ex) => {
                  const FmtIcon = formatIcon[ex.format]
                  return (
                    <tr
                      key={ex.id}
                      className="border-b border-border/50 hover:bg-muted/20 transition-colors group"
                    >
                      <td className="px-4 py-3 font-medium text-foreground whitespace-nowrap">
                        {ex.name}
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-mono text-[10px] text-muted-foreground bg-muted/40 px-1.5 py-0.5 rounded">
                          {ex.dataset}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 text-[10px] font-mono font-medium px-1.5 py-0.5 rounded uppercase',
                            formatColor[ex.format],
                          )}
                        >
                          <FmtIcon className="w-3 h-3" />
                          {ex.format}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                        {ex.range}
                      </td>
                      <td className="px-4 py-3 font-mono text-foreground">
                        {ex.rows?.toLocaleString() ?? (
                          <span className="text-muted-foreground/40">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-muted-foreground">
                        {ex.size ?? <span className="text-muted-foreground/40">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        <ExportStatusBadge status={ex.status} />
                      </td>
                      <td className="px-4 py-3 text-muted-foreground whitespace-nowrap font-mono text-[10px]">
                        {ex.created}
                      </td>
                      <td className="px-4 py-3">
                        {ex.status === 'ready' && (
                          <button
                            type="button"
                            className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 text-[10px] text-primary hover:opacity-80 whitespace-nowrap"
                          >
                            <Download className="w-3 h-3" />
                            Download
                          </button>
                        )}
                        {ex.status === 'failed' && (
                          <button
                            type="button"
                            className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground whitespace-nowrap"
                          >
                            <RefreshCw className="w-3 h-3" />
                            Retry
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Pipelines tab ── */}
      {tab === 'pipelines' && (
        <div className="flex-1 overflow-auto p-5 space-y-6">
          {/* Active pipelines */}
          {pipelines.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-3">
                Active connections
              </div>
              <div className="space-y-2">
                {pipelines.map((p) => {
                  const svc = [...AWS_SERVICES, ...OTHER_SERVICES].find((s) => s.id === p.service)
                  return (
                    <div
                      key={p.id}
                      className={cn(
                        'bg-card border rounded-lg px-4 py-3.5 flex items-center gap-4 transition-colors',
                        p.status === 'error'
                          ? 'border-red-500/20'
                          : 'border-border hover:border-border/80',
                      )}
                    >
                      <div
                        className="w-8 h-8 rounded-lg border flex items-center justify-center text-base shrink-0 bg-muted/20"
                        style={{ borderColor: 'rgba(255,255,255,0.08)' }}
                      >
                        {svc?.icon}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-xs font-medium text-foreground">{p.name}</span>
                          <PipelineStatusBadge status={p.status} />
                          {p.status === 'error' && (
                            <span className="text-[10px] text-red-400">
                              · IAM permission denied on last sync
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-[10px] text-muted-foreground font-mono">
                          <span className="truncate max-w-[240px]">{p.destination}</span>
                          <button
                            type="button"
                            onClick={() => copyDest(p.id, p.destination)}
                            className="text-muted-foreground/50 hover:text-muted-foreground transition-colors shrink-0"
                          >
                            {copiedDestination === p.id ? (
                              <Check className="w-3 h-3 text-teal-400" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                          </button>
                        </div>
                      </div>
                      <div className="hidden md:flex items-center gap-5 shrink-0 text-[11px]">
                        {p.eventsPerDay && (
                          <div className="text-center">
                            <div className="font-mono font-semibold text-foreground">
                              {(p.eventsPerDay / 1000).toFixed(0)}k
                            </div>
                            <div className="text-muted-foreground">events/day</div>
                          </div>
                        )}
                        {p.latency && (
                          <div className="text-center">
                            <div className="font-mono font-semibold text-foreground">
                              {p.latency}
                            </div>
                            <div className="text-muted-foreground">latency</div>
                          </div>
                        )}
                        <div className="text-center">
                          <div className="font-mono text-[10px] text-muted-foreground whitespace-nowrap">
                            {p.lastSync ?? 'Never'}
                          </div>
                          <div className="text-muted-foreground text-[10px]">last sync</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {p.status === 'paused' ? (
                          <button
                            type="button"
                            onClick={() =>
                              setPipelines((prev) =>
                                prev.map((x) =>
                                  x.id === p.id ? { ...x, status: 'connected' } : x,
                                ),
                              )
                            }
                            className="text-[10px] px-2 py-1 border border-border rounded text-muted-foreground hover:text-foreground transition-colors"
                          >
                            Resume
                          </button>
                        ) : p.status === 'connected' ? (
                          <button
                            type="button"
                            onClick={() =>
                              setPipelines((prev) =>
                                prev.map((x) => (x.id === p.id ? { ...x, status: 'paused' } : x)),
                              )
                            }
                            className="text-[10px] px-2 py-1 border border-border rounded text-muted-foreground hover:text-foreground transition-colors"
                          >
                            Pause
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="text-[10px] px-2 py-1 border border-red-500/20 rounded text-red-400 hover:bg-red-500/10 transition-colors"
                          >
                            Fix
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setPipelines((prev) => prev.filter((x) => x.id !== p.id))}
                          className="p-1.5 text-muted-foreground/50 hover:text-red-400 transition-colors rounded hover:bg-red-500/10"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Service catalog */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-3">
              AWS destinations
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {AWS_SERVICES.map((s) => (
                <button
                  type="button"
                  key={s.id}
                  onClick={() => setShowConnectModal(s.id)}
                  className="bg-card border border-border hover:border-primary/30 rounded-lg p-3.5 text-left transition-colors group"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-lg">{s.icon}</span>
                    <span className="text-xs font-medium text-foreground leading-tight">
                      {s.name}
                    </span>
                  </div>
                  <div className="text-[10px] text-muted-foreground leading-relaxed">{s.desc}</div>
                  <div className="mt-2.5 text-[10px] text-primary opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
                    Connect <ChevronRight className="w-3 h-3" />
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-3">
              Other destinations
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
              {OTHER_SERVICES.map((s) => (
                <button
                  type="button"
                  key={s.id}
                  onClick={() => setShowConnectModal(s.id)}
                  className="bg-card border border-border hover:border-primary/30 rounded-lg p-3.5 text-left transition-colors group"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-lg">{s.icon}</span>
                    <span className="text-xs font-medium text-foreground">{s.name}</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground">{s.desc}</div>
                  <div className="mt-2.5 text-[10px] text-primary opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
                    Connect <ChevronRight className="w-3 h-3" />
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Schema tab ── */}
      {tab === 'schema' && (
        <div className="flex flex-1 flex-col overflow-hidden">
          {!projectId ? (
            <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
              No project selected.
            </div>
          ) : (
            <SchemaTab projectId={projectId} />
          )}
        </div>
      )}

      {/* ── Retention tab ── */}
      {tab === 'retention' && (
        <div className="flex-1 overflow-auto p-5 space-y-5">
          <div className="max-w-2xl space-y-5">
            <div className="bg-amber-500/5 border border-amber-500/15 rounded-lg px-4 py-3 flex items-start gap-2.5">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
              <p className="text-[11px] text-amber-300 leading-relaxed">
                Retention periods are enforced automatically. Data past the limit is permanently
                deleted and cannot be recovered.
              </p>
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-3">
                Retention by dataset
              </div>
              <div className="bg-card border border-border rounded-lg divide-y divide-border">
                {RETENTION_RULES.map((r) => (
                  <div key={r.dataset} className="flex items-center gap-4 px-4 py-4">
                    <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                      <r.icon className="w-3.5 h-3.5 text-primary" />
                    </div>
                    <div className="flex-1">
                      <div className="text-xs font-medium text-foreground">{r.dataset}</div>
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        Plan: {r.plan ?? currentPlanLabel}
                      </div>
                    </div>
                    <div className="font-mono text-xs font-semibold text-foreground">
                      {r.current}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-3">
              Plan & usage
            </div>
            <UsageSummaryPanel />
          </div>
        </div>
      )}

      {/* Overlays */}
      {showCreateExport && (
        <CreateExportPanel
          onClose={() => setShowCreateExport(false)}
          onCreate={(job) => setExports((prev) => [job, ...prev])}
        />
      )}

      {showConnectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close overlay"
            className="absolute inset-0 bg-black/60 border-0"
            onClick={() => setShowConnectModal(null)}
          />
          <div className="relative bg-card border border-border rounded-xl p-6 w-full max-w-md shadow-2xl shadow-black/50">
            {(() => {
              const svc = [...AWS_SERVICES, ...OTHER_SERVICES].find(
                (s) => s.id === showConnectModal,
              )
              return (
                <>
                  <div className="flex items-start justify-between mb-5">
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{svc?.icon}</span>
                      <div>
                        <div className="text-sm font-semibold text-foreground">
                          Connect {svc?.name}
                        </div>
                        <div className="text-[11px] text-muted-foreground mt-0.5">{svc?.desc}</div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowConnectModal(null)}
                      className="text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="space-y-3">
                    {showConnectModal === 's3' || showConnectModal === 'firehose' ? (
                      <>
                        <div>
                          <label
                            htmlFor="connect-bucket"
                            className="block text-[11px] font-medium text-muted-foreground mb-1.5"
                          >
                            S3 bucket URI
                          </label>
                          <input
                            id="connect-bucket"
                            placeholder="s3://my-bucket/clickroom-events/"
                            className="w-full bg-muted/30 border border-border rounded-md text-xs px-3 py-2.5 text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/60 font-mono transition-colors"
                          />
                        </div>
                        <div>
                          <label
                            htmlFor="connect-region"
                            className="block text-[11px] font-medium text-muted-foreground mb-1.5"
                          >
                            AWS region
                          </label>
                          <input
                            id="connect-region"
                            placeholder="us-east-1"
                            className="w-full bg-muted/30 border border-border rounded-md text-xs px-3 py-2.5 text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/60 font-mono transition-colors"
                          />
                        </div>
                      </>
                    ) : showConnectModal === 'kinesis' ? (
                      <div>
                        <label
                          htmlFor="connect-arn"
                          className="block text-[11px] font-medium text-muted-foreground mb-1.5"
                        >
                          Stream ARN
                        </label>
                        <input
                          id="connect-arn"
                          placeholder="arn:aws:kinesis:us-east-1:123456789012:stream/my-stream"
                          className="w-full bg-muted/30 border border-border rounded-md text-xs px-3 py-2.5 text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/60 font-mono transition-colors"
                        />
                      </div>
                    ) : showConnectModal === 'redshift' ? (
                      <>
                        <div>
                          <label
                            htmlFor="connect-host"
                            className="block text-[11px] font-medium text-muted-foreground mb-1.5"
                          >
                            Host
                          </label>
                          <input
                            id="connect-host"
                            placeholder="my-cluster.us-east-1.redshift.amazonaws.com"
                            className="w-full bg-muted/30 border border-border rounded-md text-xs px-3 py-2.5 text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/60 font-mono transition-colors"
                          />
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <div>
                            <label
                              htmlFor="connect-db"
                              className="block text-[11px] font-medium text-muted-foreground mb-1.5"
                            >
                              Database
                            </label>
                            <input
                              id="connect-db"
                              placeholder="analytics"
                              className="w-full bg-muted/30 border border-border rounded-md text-xs px-3 py-2.5 text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/60 transition-colors"
                            />
                          </div>
                          <div>
                            <label
                              htmlFor="connect-port"
                              className="block text-[11px] font-medium text-muted-foreground mb-1.5"
                            >
                              Port
                            </label>
                            <input
                              id="connect-port"
                              placeholder="5439"
                              className="w-full bg-muted/30 border border-border rounded-md text-xs px-3 py-2.5 text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/60 transition-colors"
                            />
                          </div>
                        </div>
                      </>
                    ) : (
                      <>
                        <div>
                          <label
                            htmlFor="connect-name"
                            className="block text-[11px] font-medium text-muted-foreground mb-1.5"
                          >
                            Connection name
                          </label>
                          <input
                            id="connect-name"
                            placeholder={`My ${svc?.name} connection`}
                            className="w-full bg-muted/30 border border-border rounded-md text-xs px-3 py-2.5 text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/60 transition-colors"
                          />
                        </div>
                        <div>
                          <label
                            htmlFor="connect-cred"
                            className="block text-[11px] font-medium text-muted-foreground mb-1.5"
                          >
                            API key / credentials
                          </label>
                          <input
                            id="connect-cred"
                            type="password"
                            placeholder="••••••••••••••••"
                            className="w-full bg-muted/30 border border-border rounded-md text-xs px-3 py-2.5 text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/60 transition-colors"
                          />
                        </div>
                      </>
                    )}

                    <div className="bg-muted/20 border border-border rounded-md px-3 py-2.5">
                      <div className="text-[10px] text-muted-foreground font-medium mb-1">
                        IAM policy (required)
                      </div>
                      <pre className="text-[10px] font-mono text-foreground leading-relaxed overflow-auto">{`{\n  "Effect": "Allow",\n  "Action": ["s3:PutObject","s3:GetObject"],\n  "Resource": "arn:aws:s3:::your-bucket/*"\n}`}</pre>
                    </div>
                  </div>

                  <div className="flex gap-2 mt-5">
                    <button
                      type="button"
                      onClick={() => setShowConnectModal(null)}
                      className="flex-1 py-2 text-xs text-muted-foreground border border-border rounded-md hover:text-foreground transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const svcDef = [...AWS_SERVICES, ...OTHER_SERVICES].find(
                          (s) => s.id === showConnectModal,
                        )
                        if (svcDef) {
                          const newPipeline: Pipeline = {
                            id: `p${Date.now()}`,
                            name: `${svcDef.name} connection`,
                            provider:
                              showConnectModal === 'bq' || showConnectModal === 'snowflake'
                                ? 'GCP'
                                : 'AWS',
                            service: showConnectModal,
                            destination: 'Configuring…',
                            eventsPerDay: null,
                            latency: null,
                            status: 'pending',
                            connected: 'Jul 4, 2026',
                            lastSync: null,
                          }
                          setPipelines((prev) => [newPipeline, ...prev])
                        }
                        setShowConnectModal(null)
                      }}
                      className="flex-1 py-2 text-xs font-semibold bg-primary text-primary-foreground rounded-md hover:opacity-90 transition-opacity"
                    >
                      Connect
                    </button>
                  </div>
                </>
              )
            })()}
          </div>
        </div>
      )}
    </div>
  )
}
