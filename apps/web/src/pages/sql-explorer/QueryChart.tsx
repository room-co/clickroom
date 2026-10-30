import { Save } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from 'recharts'
import { Button } from '@/components/ui/button'
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// Reuses the funnel drop-off palette so charts across the app read as one system.
const CHART_COLORS = ['#2DD4BF', '#26b8a6', '#1fa08e', '#178878', '#107062', '#8b5cf6', '#f59e0b']

export type VizConfig = {
  version: 1
  type: 'line' | 'bar' | 'area' | 'number' | 'pie'
  xColumn: string
  yColumns: string[]
}

type Column = { name: string; type: string }

const NUMERIC_TYPE_PREFIXES = ['UInt', 'Int', 'Float', 'Decimal']

function isNumericType(type: string): boolean {
  return NUMERIC_TYPE_PREFIXES.some((prefix) => type.startsWith(prefix))
}

const MAX_TICK_LABEL_LENGTH = 14

function truncateLabel(value: string): string {
  const label = String(value)
  return label.length > MAX_TICK_LABEL_LENGTH
    ? `${label.slice(0, MAX_TICK_LABEL_LENGTH - 1)}…`
    : label
}

const compactNumberFormat = new Intl.NumberFormat('en-US', { notation: 'compact' })

function formatYAxisTick(value: number | string): string {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? compactNumberFormat.format(n) : String(value)
}

function computeDefaultConfig(columns: Column[]): VizConfig {
  const xColumn = columns[0]?.name ?? ''
  const numericColumn = columns.find((c) => isNumericType(c.type))
  const yColumn = numericColumn?.name ?? columns[1]?.name ?? columns[0]?.name ?? ''
  return {
    version: 1,
    type: 'line',
    xColumn,
    yColumns: yColumn ? [yColumn] : [],
  }
}

function rowsToChartData(columns: Column[], rows: unknown[][]): Record<string, unknown>[] {
  const colsByIndex = columns.map((c, i) => ({ ...c, index: i }))
  return rows.map((row) => {
    const record: Record<string, unknown> = {}
    for (const { name, type, index } of colsByIndex) {
      const cell = row[index]
      record[name] =
        isNumericType(type) && cell !== null && cell !== undefined ? Number(cell) : cell
    }
    return record
  })
}

function buildChartConfig(yColumns: string[]): ChartConfig {
  const config: ChartConfig = {}
  yColumns.forEach((col, i) => {
    config[col] = {
      label: col,
      color: CHART_COLORS[i % CHART_COLORS.length],
    }
  })
  return config
}

function EmptyState() {
  return (
    <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
      Query returned no rows.
    </div>
  )
}

function ChartControls({
  columns,
  config,
  onConfigChange,
  onSaveClick,
  canSave,
  saveDisabledReason,
}: {
  columns: Column[]
  config: VizConfig
  onConfigChange: (config: VizConfig) => void
  onSaveClick?: () => void
  canSave?: boolean
  saveDisabledReason?: string
}) {
  const isSingleValue = config.type === 'number'
  const showXColumn = config.type !== 'number'
  const showYMulti = config.type === 'line' || config.type === 'bar' || config.type === 'area'

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={config.type}
        onValueChange={(value) => onConfigChange({ ...config, type: value as VizConfig['type'] })}
      >
        <SelectTrigger size="sm" className="w-28">
          <SelectValue placeholder="Chart type" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="line">Line</SelectItem>
          <SelectItem value="bar">Bar</SelectItem>
          <SelectItem value="area">Area</SelectItem>
          <SelectItem value="number">Number</SelectItem>
          <SelectItem value="pie">Pie</SelectItem>
        </SelectContent>
      </Select>

      {showXColumn && (
        <Select
          value={config.xColumn}
          onValueChange={(value) => onConfigChange({ ...config, xColumn: value })}
        >
          <SelectTrigger size="sm" className="w-40">
            <SelectValue placeholder={config.type === 'pie' ? 'Label column' : 'X column'} />
          </SelectTrigger>
          <SelectContent>
            {columns.map((c) => (
              <SelectItem key={c.name} value={c.name}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {isSingleValue || config.type === 'pie' ? (
        <Select
          value={config.yColumns[0] ?? ''}
          onValueChange={(value) => onConfigChange({ ...config, yColumns: [value] })}
        >
          <SelectTrigger size="sm" className="w-40">
            <SelectValue placeholder="Value column" />
          </SelectTrigger>
          <SelectContent>
            {columns.map((c) => (
              <SelectItem key={c.name} value={c.name}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      {showYMulti && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-input px-2 py-1.5">
          {columns.map((c) => {
            const checked = config.yColumns.includes(c.name)
            return (
              // biome-ignore lint/a11y/noLabelWithoutControl: Checkbox is a Radix button, not a native input
              <label key={c.name} className="flex items-center gap-1.5 text-xs text-foreground">
                <Checkbox
                  checked={checked}
                  onCheckedChange={(next) => {
                    const yColumns = next
                      ? [...config.yColumns, c.name]
                      : config.yColumns.filter((y) => y !== c.name)
                    onConfigChange({ ...config, yColumns })
                  }}
                />
                {c.name}
              </label>
            )
          })}
        </div>
      )}

      {onSaveClick && (
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={onSaveClick}
          disabled={!canSave}
          title={saveDisabledReason}
        >
          <Save className="h-3.5 w-3.5" />
          Save visualization
        </Button>
      )}
    </div>
  )
}

export function QueryChart({
  columns,
  rows,
  config,
  onConfigChange,
  onSaveClick,
  canSave,
  saveDisabledReason,
}: {
  columns: Column[]
  rows: unknown[][]
  config: VizConfig | null
  onConfigChange: (config: VizConfig) => void
  onSaveClick?: () => void
  canSave?: boolean
  saveDisabledReason?: string
}) {
  const defaultConfig = useMemo(() => computeDefaultConfig(columns), [columns])

  // Seed the default config once when none is present. onConfigChange is intentionally
  // excluded from deps below (its identity may change per render in the parent) to avoid
  // re-seeding on every parent re-render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    if (!config) {
      onConfigChange(defaultConfig)
    }
  }, [config, defaultConfig])

  const effectiveConfig = config ?? defaultConfig

  const data = useMemo(() => rowsToChartData(columns, rows), [columns, rows])
  const chartConfig = useMemo(
    () => buildChartConfig(effectiveConfig.yColumns),
    [effectiveConfig.yColumns],
  )

  const controlsProps = {
    onSaveClick,
    canSave,
    saveDisabledReason,
  }

  const axisMargin = { top: 8, right: 16, bottom: 8, left: 8 }
  const xAxisProps = {
    dataKey: effectiveConfig.xColumn,
    tickLine: false,
    axisLine: false,
    interval: 'preserveStartEnd' as const,
    angle: -30,
    textAnchor: 'end' as const,
    height: 64,
    tickMargin: 10,
    fontSize: 11,
    tickFormatter: truncateLabel,
  }
  const yAxisProps = {
    tickLine: false,
    axisLine: false,
    fontSize: 11,
    tickFormatter: formatYAxisTick,
    allowDecimals: false,
  }
  const dotProps = data.length <= 30 ? { r: 3 } : false

  if (rows.length === 0) {
    return (
      <div className="flex min-h-full flex-col gap-3 p-3">
        <ChartControls
          columns={columns}
          config={effectiveConfig}
          onConfigChange={onConfigChange}
          {...controlsProps}
        />
        <EmptyState />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-x-visible overflow-y-auto p-3">
      <div className="shrink-0">
        <ChartControls
          columns={columns}
          config={effectiveConfig}
          onConfigChange={onConfigChange}
          {...controlsProps}
        />
      </div>

      <div className="min-h-[380px] flex-1">
        {effectiveConfig.type === 'number' ? (
          <div className="flex h-full items-center justify-center rounded-lg border border-border bg-card">
            <div className="text-center">
              <div className="font-mono text-4xl font-semibold text-foreground">
                {String(data[0]?.[effectiveConfig.yColumns[0]] ?? '—')}
              </div>
              <div className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                {effectiveConfig.yColumns[0]}
              </div>
            </div>
          </div>
        ) : effectiveConfig.type === 'pie' ? (
          <ChartContainer config={chartConfig} className="h-full w-full">
            <PieChart>
              <ChartTooltip content={<ChartTooltipContent nameKey={effectiveConfig.xColumn} />} />
              <Pie
                data={data}
                dataKey={effectiveConfig.yColumns[0]}
                nameKey={effectiveConfig.xColumn}
                outerRadius="70%"
              >
                {data.map((_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: pie slices have no stable id
                  <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                ))}
              </Pie>
            </PieChart>
          </ChartContainer>
        ) : effectiveConfig.type === 'bar' ? (
          <ChartContainer
            config={chartConfig}
            className="h-full w-full [&_.recharts-surface]:overflow-visible"
          >
            <BarChart data={data} margin={axisMargin}>
              <CartesianGrid vertical={false} />
              <XAxis {...xAxisProps} />
              <YAxis {...yAxisProps} domain={[0, 'auto']} />
              <ChartTooltip content={<ChartTooltipContent />} />
              {effectiveConfig.yColumns.map((y) => (
                <Bar key={y} dataKey={y} fill={`var(--color-${y})`} radius={4} />
              ))}
            </BarChart>
          </ChartContainer>
        ) : effectiveConfig.type === 'area' ? (
          <ChartContainer
            config={chartConfig}
            className="h-full w-full [&_.recharts-surface]:overflow-visible"
          >
            <AreaChart data={data} margin={axisMargin}>
              <CartesianGrid vertical={false} />
              <XAxis {...xAxisProps} />
              <YAxis {...yAxisProps} />
              <ChartTooltip content={<ChartTooltipContent />} />
              {effectiveConfig.yColumns.map((y) => (
                <Area
                  key={y}
                  dataKey={y}
                  type="monotone"
                  fill={`var(--color-${y})`}
                  stroke={`var(--color-${y})`}
                  fillOpacity={0.2}
                  dot={dotProps}
                />
              ))}
            </AreaChart>
          </ChartContainer>
        ) : (
          <ChartContainer
            config={chartConfig}
            className="h-full w-full [&_.recharts-surface]:overflow-visible"
          >
            <LineChart data={data} margin={axisMargin}>
              <CartesianGrid vertical={false} />
              <XAxis {...xAxisProps} />
              <YAxis {...yAxisProps} />
              <ChartTooltip content={<ChartTooltipContent />} />
              {effectiveConfig.yColumns.map((y) => (
                <Line
                  key={y}
                  dataKey={y}
                  type="monotone"
                  stroke={`var(--color-${y})`}
                  dot={dotProps}
                />
              ))}
            </LineChart>
          </ChartContainer>
        )}
      </div>
    </div>
  )
}
