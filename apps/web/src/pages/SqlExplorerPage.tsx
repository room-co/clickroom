import { sql as sqlLang } from '@codemirror/lang-sql'
import { Prec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { keymap } from '@codemirror/view'
import CodeMirror from '@uiw/react-codemirror'
import { AlertTriangle, ChevronRight, Play, Plug, Save, Search, Table2, Trash2 } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ClickHouseIcon } from '@/components/icons/ClickHouseIcon'
import { PageHeader } from '@/components/PageHeader'
import { SkeletonList, SkeletonTable, SkeletonText } from '@/components/skeletons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { track } from '@/lib/analytics'
import { trpc } from '@/lib/trpc'
import { useProjectId } from '@/lib/use-project'
import { QueryChart, type VizConfig } from './sql-explorer/QueryChart'

const DEFAULT_SQL =
  'SELECT event, count() AS c\nFROM events\nGROUP BY event\nORDER BY c DESC\nLIMIT 20'

// The results grid is arbitrary-width — the real column count is only known once the
// query returns — so the skeleton stands in with a neutral 4-column grid.
const RESULT_SKELETON_COLS = 4

type SavedQuery = {
  id: string
  name: string
  sql: string
}

// tRPC infers `config: Json` on `DataSource` down to Prisma's recursive
// `JsonValue` union, which blows up `tsc`'s instantiation depth when chained
// through `.map()`/`.find()` here — same cast pattern used below for
// `SavedVisualization`.
type DataSourceRow = {
  id: string
  name: string
  type: string
  status: string
  isDefault: boolean
}

function SavedQueryList({
  projectId,
  onLoad,
}: {
  projectId: string
  onLoad: (sql: string, id: string) => void
}) {
  const utils = trpc.useUtils()
  const list = trpc.sqlExplorer.list.useQuery({ projectId })
  const del = trpc.sqlExplorer.delete.useMutation()

  async function handleDelete(id: string) {
    try {
      await del.mutateAsync({ projectId, id })
      await utils.sqlExplorer.list.invalidate()
      toast.success('Saved query deleted')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete saved query')
    }
  }

  const queries = (list.data ?? []) as SavedQuery[]

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Saved queries
      </div>
      <div className="flex-1 overflow-auto px-2 pb-2">
        {list.isPending ? (
          <SkeletonText lines={4} className="px-1" />
        ) : queries.length === 0 ? (
          <div className="px-2 py-4 text-[11px] text-muted-foreground">No saved queries yet.</div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {queries.map((q) => (
              <div
                key={q.id}
                className="group flex items-center gap-1 rounded px-2 py-1.5 hover:bg-muted/30"
              >
                <button
                  type="button"
                  onClick={() => onLoad(q.sql, q.id)}
                  className="flex-1 truncate text-left text-xs text-foreground"
                  title={q.name}
                >
                  {q.name}
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(q.id)}
                  title="Delete saved query"
                  className="shrink-0 rounded p-1 text-muted-foreground/60 opacity-0 transition-colors hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

type SchemaTable = {
  table: string
  columns: { name: string; type: string }[]
}

function SchemaExplorer({
  projectId,
  onSelectTable,
  onInsertColumn,
}: {
  projectId: string
  onSelectTable: (table: string) => void
  onInsertColumn: (column: string) => void
}) {
  const [search, setSearch] = useState('')
  const schema = trpc.sqlExplorer.schema.useQuery({ projectId }, { staleTime: 5 * 60_000 })
  const tables = (schema.data ?? []) as SchemaTable[]

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return tables
    return tables
      .map((t) => ({
        ...t,
        columns: t.table.toLowerCase().includes(q)
          ? t.columns
          : t.columns.filter((c) => c.name.toLowerCase().includes(q)),
      }))
      .filter((t) => t.table.toLowerCase().includes(q) || t.columns.length > 0)
  }, [tables, search])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 px-2 pt-2 pb-1.5">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tables & columns"
            className="h-7 pl-6.5 text-xs"
          />
        </div>
      </div>
      <ScrollArea className="flex-1 overflow-hidden px-2 pb-2">
        {schema.isPending ? (
          <SkeletonList rows={4} className="px-1 py-1" />
        ) : schema.isError ? (
          <div className="px-2 py-4 text-[11px] text-red-400">Failed to load schema.</div>
        ) : filtered.length === 0 ? (
          <div className="px-2 py-4 text-[11px] text-muted-foreground">No matches.</div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {filtered.map((t) => (
              <Collapsible key={t.table} defaultOpen={!!search}>
                <CollapsibleTrigger asChild>
                  {/* biome-ignore lint/a11y/useSemanticElements: can't nest the inner insert <button> inside a <button> trigger */}
                  <div
                    role="button"
                    tabIndex={0}
                    className="group flex w-full items-center gap-1.5 rounded px-1.5 py-1.5 text-left hover:bg-muted/30 [&[data-state=open]>svg]:rotate-90"
                  >
                    <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground transition-transform" />
                    <Table2 className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        onSelectTable(t.table)
                      }}
                      className="flex-1 truncate text-left text-xs font-medium text-foreground hover:underline"
                      title={`Query "${t.table}"`}
                    >
                      {t.table}
                    </button>
                    <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">
                      {t.columns.length}
                    </Badge>
                  </div>
                </CollapsibleTrigger>
                <CollapsibleContent className="flex flex-col gap-0.5 py-0.5 pl-6">
                  {t.columns.map((c) => (
                    <button
                      key={c.name}
                      type="button"
                      onClick={() => onInsertColumn(c.name)}
                      title={`Insert "${c.name}"`}
                      className="flex items-center justify-between gap-2 truncate rounded px-1.5 py-1 text-left text-xs text-foreground hover:bg-muted/30"
                    >
                      <span className="truncate">{c.name}</span>
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        {c.type}
                      </span>
                    </button>
                  ))}
                </CollapsibleContent>
              </Collapsible>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}

function SaveQueryDialog({
  open,
  onOpenChange,
  onSave,
  pending,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (name: string) => void
  pending: boolean
}) {
  const [name, setName] = useState('')

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setName('')
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save query</DialogTitle>
        </DialogHeader>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Query name"
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={() => name.trim() && onSave(name.trim())}
            disabled={pending || !name.trim()}
          >
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type SavedVisualization = {
  id: string
  name: string
  config: VizConfig
}

function SavedVisualizationList({
  projectId,
  savedQueryId,
  onLoad,
}: {
  projectId: string
  savedQueryId: string
  onLoad: (config: VizConfig) => void
}) {
  const utils = trpc.useUtils()
  const list = trpc.sqlExplorer.viz.list.useQuery({ projectId, savedQueryId })
  const del = trpc.sqlExplorer.viz.delete.useMutation()

  async function handleDelete(id: string) {
    try {
      await del.mutateAsync({ projectId, id })
      await utils.sqlExplorer.viz.list.invalidate()
      toast.success('Visualization deleted')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete visualization')
    }
  }

  const visualizations = (list.data ?? []) as unknown as SavedVisualization[]

  return (
    <div className="flex flex-col gap-1 border-t border-border pt-2">
      <div className="px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Visualizations
      </div>
      {list.isPending ? (
        <Skeleton className="h-6 w-full" />
      ) : visualizations.length === 0 ? (
        <div className="px-1 py-1 text-[11px] text-muted-foreground">No saved visualizations.</div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {visualizations.map((v) => (
            <div
              key={v.id}
              className="group flex items-center gap-1 rounded px-1 py-1 hover:bg-muted/30"
            >
              <button
                type="button"
                onClick={() => onLoad(v.config)}
                className="flex-1 truncate text-left text-xs text-foreground"
                title={v.name}
              >
                {v.name}
              </button>
              <button
                type="button"
                onClick={() => handleDelete(v.id)}
                title="Delete visualization"
                className="shrink-0 rounded p-1 text-muted-foreground/60 opacity-0 transition-colors hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SaveVisualizationDialog({
  open,
  onOpenChange,
  onSave,
  pending,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (name: string) => void
  pending: boolean
}) {
  const [name, setName] = useState('')

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setName('')
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save visualization</DialogTitle>
        </DialogHeader>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Visualization name"
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={() => name.trim() && onSave(name.trim())}
            disabled={pending || !name.trim()}
          >
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ResultsTable({
  columns,
  rows,
}: {
  columns: { name: string; type: string }[]
  rows: unknown[][]
}) {
  if (rows.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
        Query returned no rows.
      </div>
    )
  }

  return (
    <div className="max-h-[min(1450px,100%)] overflow-auto">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-background">
          <tr className="border-b border-border">
            {columns.map((col) => (
              <th
                key={col.name}
                className="whitespace-nowrap px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
              >
                {col.name}
                <span className="ml-1 font-normal normal-case text-muted-foreground/50">
                  {col.type}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id
            <tr key={i} className="border-b border-border/50 hover:bg-muted/20">
              {row.map((cell, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: cells have no stable id
                <td key={j} className="whitespace-nowrap px-3 py-2 font-mono text-foreground">
                  {cell === null || cell === undefined ? (
                    <span className="text-muted-foreground/40">NULL</span>
                  ) : (
                    String(cell)
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function SqlExplorerPage() {
  const projectId = useProjectId()
  const utils = trpc.useUtils()
  const [sqlText, setSqlText] = useState(DEFAULT_SQL)
  const [saveOpen, setSaveOpen] = useState(false)
  const [currentSavedQueryId, setCurrentSavedQueryId] = useState<string | null>(null)
  const [vizConfig, setVizConfig] = useState<VizConfig | null>(null)
  const [resultsTab, setResultsTab] = useState('results')
  const [saveVizOpen, setSaveVizOpen] = useState(false)
  const [dataSourceId, setDataSourceId] = useState<string | undefined>(undefined)
  const [leftTab, setLeftTab] = useState('saved')
  const editorViewRef = useRef<EditorView | null>(null)

  function handleInsertAtCursor(text: string) {
    const view = editorViewRef.current
    if (!view) {
      setSqlText((prev) => `${prev}${text}`)
      return
    }
    const pos = view.state.selection.main.head
    view.dispatch({
      changes: { from: pos, to: pos, insert: text },
      selection: { anchor: pos + text.length },
    })
    view.focus()
  }

  function handleSelectTable(table: string) {
    setSqlText(`SELECT *\nFROM ${table}\nLIMIT 100`)
    setCurrentSavedQueryId(null)
    setVizConfig(null)
    editorViewRef.current?.focus()
  }

  const dataSourcesQuery = trpc.dataSources.list.useQuery(
    { projectId: projectId ?? '' },
    { enabled: !!projectId },
  )
  const dataSourceRows = dataSourcesQuery.data as unknown as DataSourceRow[] | undefined
  const resolvedDataSourceId =
    dataSourceId ?? dataSourceRows?.find((s) => s.isDefault)?.id ?? dataSourceRows?.[0]?.id

  const run = trpc.sqlExplorer.run.useMutation()
  const save = trpc.sqlExplorer.save.useMutation()
  const saveViz = trpc.sqlExplorer.viz.save.useMutation()

  function handleRun() {
    if (!projectId || !sqlText.trim() || !resolvedDataSourceId) return
    track('sql_query_run', { saved: currentSavedQueryId !== null })
    run.mutate({ projectId, sql: sqlText, sourceId: resolvedDataSourceId })
  }

  function handleLoadQuery(sql: string, id: string) {
    setSqlText(sql)
    setCurrentSavedQueryId(id)
    setVizConfig(null)
  }

  function handleLoadVisualization(config: VizConfig) {
    setVizConfig(config)
    setResultsTab('visualization')
  }

  async function handleSaveVisualization(name: string) {
    if (!projectId || !currentSavedQueryId || !vizConfig) return
    try {
      await saveViz.mutateAsync({
        projectId,
        savedQueryId: currentSavedQueryId,
        name,
        config: vizConfig,
      })
      await utils.sqlExplorer.viz.list.invalidate()
      toast.success('Visualization saved')
      setSaveVizOpen(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save visualization')
    }
  }

  // Keep a ref so the Mod-Enter keymap (built once via useMemo) always calls the
  // latest handleRun instead of a stale closure over an early projectId/sqlText.
  const handleRunRef = useRef(handleRun)
  handleRunRef.current = handleRun

  const runKeymap = useMemo(
    () =>
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              handleRunRef.current()
              return true
            },
          },
        ]),
      ),
    [],
  )

  async function handleSave(name: string) {
    if (!projectId) return
    try {
      const saved = await save.mutateAsync({ projectId, name, sql: sqlText })
      setCurrentSavedQueryId(saved.id)
      await utils.sqlExplorer.list.invalidate()
      toast.success('Query saved')
      setSaveOpen(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save query')
    }
  }

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        No project selected.
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader title="SQL Explorer" subtitle="Query your event data directly">
        <Select value={resolvedDataSourceId} onValueChange={setDataSourceId}>
          <SelectTrigger size="sm" className="w-auto max-w-[11rem] sm:max-w-none">
            <SelectValue>
              {(() => {
                const source = dataSourceRows?.find((s) => s.id === resolvedDataSourceId)
                if (!source) return null
                return (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <ClickHouseIcon className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{source.name}</span>
                    <span className="ml-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                  </span>
                )
              })()}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {dataSourceRows?.map((source) => (
              <SelectItem key={source.id} value={source.id}>
                <span className="flex items-center gap-1.5">
                  <ClickHouseIcon className="h-3.5 w-3.5 shrink-0" />
                  {source.name}
                </span>
              </SelectItem>
            ))}
            <SelectItem value="__external" disabled>
              <span className="flex items-center gap-1.5">
                <Plug className="h-3.5 w-3.5 shrink-0 opacity-50" />
                Connect external source — coming soon
              </span>
            </SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={() => setSaveOpen(true)}>
          <Save className="h-3.5 w-3.5" />
          Save
        </Button>
        <Button
          size="sm"
          onClick={handleRun}
          disabled={run.isPending || !sqlText.trim() || !resolvedDataSourceId}
          title="Run (⌘+Enter / Ctrl+Enter)"
        >
          <Play className="h-3.5 w-3.5" />
          {run.isPending ? 'Running…' : 'Run'}
        </Button>
      </PageHeader>

      <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
        <div className="flex h-40 shrink-0 flex-col overflow-hidden border-b border-border md:h-auto md:w-56 md:border-b-0 md:border-r">
          <Tabs
            value={leftTab}
            onValueChange={setLeftTab}
            className="flex h-full flex-col overflow-hidden"
          >
            <TabsList className="mx-2 mt-2 w-fit shrink-0">
              <TabsTrigger value="saved">Saved</TabsTrigger>
              <TabsTrigger value="schema">Schema</TabsTrigger>
            </TabsList>
            <TabsContent value="saved" className="flex-1 overflow-hidden">
              <div className="flex h-full flex-col overflow-hidden">
                <SavedQueryList projectId={projectId} onLoad={handleLoadQuery} />
                {currentSavedQueryId && (
                  <div className="px-2 pb-2">
                    <SavedVisualizationList
                      projectId={projectId}
                      savedQueryId={currentSavedQueryId}
                      onLoad={handleLoadVisualization}
                    />
                  </div>
                )}
              </div>
            </TabsContent>
            <TabsContent value="schema" className="flex-1 overflow-hidden">
              <SchemaExplorer
                projectId={projectId}
                onSelectTable={handleSelectTable}
                onInsertColumn={handleInsertAtCursor}
              />
            </TabsContent>
          </Tabs>
        </div>

        <div className="flex-1 overflow-hidden">
          <ResizablePanelGroup direction="vertical">
            <ResizablePanel defaultSize={35} minSize={15} className="overflow-hidden">
              <CodeMirror
                value={sqlText}
                onChange={setSqlText}
                onCreateEditor={(view) => {
                  editorViewRef.current = view
                }}
                extensions={[sqlLang(), runKeymap]}
                height="100%"
                theme="dark"
                className="h-full text-xs [&_.cm-editor]:h-full"
              />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={65} minSize={20} className="flex flex-col overflow-hidden">
              {run.isPending ? (
                <div className="flex h-full flex-col overflow-hidden">
                  {/* Mirrors the `{rowCount} rows · {elapsedMs}ms` stats line above the grid. */}
                  <Skeleton className="mx-3 my-2 h-3 w-40 shrink-0" />
                  <div className="flex-1 overflow-x-auto">
                    <SkeletonTable rows={8} cols={RESULT_SKELETON_COLS} className="px-3 pt-0" />
                  </div>
                </div>
              ) : run.isError ? (
                <div className="m-3 flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                  <div>
                    <div className="text-sm font-medium text-red-400">Query failed</div>
                    <div className="mt-1 whitespace-pre-wrap text-[11px] text-muted-foreground">
                      {run.error.message}
                    </div>
                  </div>
                </div>
              ) : run.data ? (
                <div className="flex h-full flex-col overflow-hidden">
                  <div className="shrink-0 px-3 py-2 text-[10px] text-muted-foreground font-mono">
                    {run.data.rowCount} rows · {run.data.elapsedMs}ms ·{' '}
                    {run.data.rowsRead.toLocaleString()} rows read
                  </div>
                  <Tabs
                    value={resultsTab}
                    onValueChange={setResultsTab}
                    className="flex flex-1 flex-col overflow-hidden"
                  >
                    <TabsList className="mx-3 w-fit shrink-0">
                      <TabsTrigger value="results">Results</TabsTrigger>
                      <TabsTrigger value="visualization">Visualization</TabsTrigger>
                    </TabsList>
                    <TabsContent value="results" className="flex-1 overflow-auto">
                      <ResultsTable columns={run.data.columns} rows={run.data.rows} />
                    </TabsContent>
                    <TabsContent
                      value="visualization"
                      className="flex flex-1 flex-col overflow-x-visible overflow-y-auto"
                    >
                      <QueryChart
                        columns={run.data.columns}
                        rows={run.data.rows}
                        config={vizConfig}
                        onConfigChange={setVizConfig}
                        onSaveClick={() => setSaveVizOpen(true)}
                        canSave={!!currentSavedQueryId && !!vizConfig}
                        saveDisabledReason={
                          currentSavedQueryId
                            ? 'Save this visualization'
                            : 'Save the query first to attach visualizations to it'
                        }
                      />
                    </TabsContent>
                  </Tabs>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  Run a query to see results.
                </div>
              )}
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </div>

      <SaveQueryDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        onSave={handleSave}
        pending={save.isPending}
      />
      <SaveVisualizationDialog
        open={saveVizOpen}
        onOpenChange={setSaveVizOpen}
        onSave={handleSaveVisualization}
        pending={saveViz.isPending}
      />
    </div>
  )
}
