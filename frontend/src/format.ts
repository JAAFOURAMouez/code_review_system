const dateTime = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})
const timeOnly = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

export const fmtDateTime = (at: number) => dateTime.format(at)
export const fmtTime = (at: number) => timeOnly.format(at)

/** 850 ms -> "0.9 s", 12 400 -> "12 s", 125 000 -> "2 min 05 s". */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '–'
  const s = ms / 1000
  if (s < 10) return `${s.toFixed(1)} s`
  if (s < 60) return `${Math.round(s)} s`
  const m = Math.floor(s / 60)
  const rest = Math.round(s - m * 60)
  return rest ? `${m} min ${String(rest).padStart(2, '0')} s` : `${m} min`
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

export function includesText(haystack: (string | null | undefined)[], query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const text = haystack.filter(Boolean).join(' \n ').toLowerCase()
  return terms.every((t) => text.includes(t))
}
