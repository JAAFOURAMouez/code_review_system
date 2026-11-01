const dateTime = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})
const dateOnly = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
const timeOnly = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

export const fmtDateTime = (at: number) => dateTime.format(at)
export const fmtDate = (at: number) => dateOnly.format(at)
export const fmtTime = (at: number) => timeOnly.format(at)

export function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

export function fmtPct(ratio: number | null, digits = 1): string {
  return ratio === null ? 'n/a' : `${(ratio * 100).toFixed(digits)}%`
}

export function fmtUsd(n: number): string {
  return n >= 100 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`
}

export function includesText(haystack: (string | undefined)[], query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const text = haystack.filter(Boolean).join(' \n ').toLowerCase()
  return terms.every((t) => text.includes(t))
}
