const numberFmt = new Intl.NumberFormat('en-US')

export function formatVolume(n: number): string {
  return numberFmt.format(n)
}

export function formatLastSeen(iso: string | null): string {
  if (!iso) return 'Never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Never'
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}
