type TooltipPayloadEntry = {
  dataKey?: string | number
  value?: number
  name?: string
}

export function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: TooltipPayloadEntry[]
  label?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-popover border border-border rounded-lg px-3 py-2 shadow-2xl text-xs">
      <div className="text-muted-foreground mb-1.5">{label}</div>
      {payload.map((entry) => (
        <div key={String(entry.dataKey)} className="flex items-center gap-2">
          <span className="font-mono font-medium text-foreground">
            {entry.value?.toLocaleString()}
          </span>
          <span className="text-muted-foreground">{entry.name}</span>
        </div>
      ))}
    </div>
  )
}
