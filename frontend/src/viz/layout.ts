// Pure layout algorithms for the graphs. No React, no DOM.

export interface Point {
  x: number
  y: number
}

export interface LayeredLayout {
  positions: Map<string, Point>
  layers: Map<string, number>
  width: number
  height: number
}

export interface LayeredOptions {
  nodeWidth: number
  nodeHeight: number
  columnGap: number
  rowGap: number
  /** Wrap layers into stacked bands after this many columns, so deep pipelines stay readable. */
  wrapAfter?: number
  bandGap?: number
}

/**
 * Layered left-to-right layout for a directed graph. Each node goes in the
 * column after its latest predecessor; rows are ordered by the average row of
 * their predecessors to keep edge crossings low.
 */
export function layeredLayout(
  ids: string[],
  edges: { from: string; to: string }[],
  opts: LayeredOptions,
): LayeredLayout {
  const layers = new Map<string, number>(ids.map((id) => [id, 0]))
  // Longest-path layering. The iteration cap guards against accidental cycles.
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false
    for (const e of edges) {
      const next = (layers.get(e.from) ?? 0) + 1
      if (e.from !== e.to && next > (layers.get(e.to) ?? 0) && next < ids.length) {
        layers.set(e.to, next)
        changed = true
      }
    }
    if (!changed) break
  }
  const columns: string[][] = []
  for (const id of ids) {
    const l = layers.get(id) ?? 0
    ;(columns[l] ??= []).push(id)
  }
  const row = new Map<string, number>()
  columns.forEach((col) => col?.forEach((id, i) => row.set(id, i)))
  for (let sweep = 0; sweep < 3; sweep++) {
    columns.forEach((col) => {
      if (!col) return
      const score = (id: string) => {
        const preds = edges
          .filter((e) => e.to === id && e.from !== id)
          .map((e) => row.get(e.from) ?? 0)
        return preds.length ? preds.reduce((a, b) => a + b, 0) / preds.length : (row.get(id) ?? 0)
      }
      col.sort((a, b) => score(a) - score(b) || ids.indexOf(a) - ids.indexOf(b))
      col.forEach((id, i) => row.set(id, i))
    })
  }
  const stepX = opts.nodeWidth + opts.columnGap
  const stepY = opts.nodeHeight + opts.rowGap
  const layerCount = Math.max(1, columns.length)
  const wrap = opts.wrapAfter && layerCount > opts.wrapAfter ? opts.wrapAfter : layerCount
  const bandCount = Math.ceil(layerCount / wrap)
  const bandGap = opts.bandGap ?? 0
  const bandHeights: number[] = []
  for (let b = 0; b < bandCount; b++) {
    let tallest = 1
    for (let l = b * wrap; l < Math.min(layerCount, (b + 1) * wrap); l++)
      tallest = Math.max(tallest, columns[l]?.length ?? 0)
    bandHeights.push(tallest * stepY - opts.rowGap)
  }
  const bandTops: number[] = []
  let cursor = 0
  for (const h of bandHeights) {
    bandTops.push(cursor)
    cursor += h + bandGap
  }
  const positions = new Map<string, Point>()
  columns.forEach((col, l) => {
    if (!col) return
    const band = Math.floor(l / wrap)
    const offset = (bandHeights[band]! - (col.length * stepY - opts.rowGap)) / 2
    col.forEach((id, i) =>
      positions.set(id, { x: (l % wrap) * stepX, y: bandTops[band]! + offset + i * stepY }),
    )
  })
  return {
    positions,
    layers,
    width: Math.min(layerCount, wrap) * stepX - opts.columnGap,
    height: cursor - bandGap,
  }
}

export interface ForceOptions {
  width: number
  height: number
  iterations?: number
}

/**
 * Small deterministic force-directed layout (same input gives the same picture).
 * Positions are clamped to the box while simulating so disconnected nodes cannot
 * fly away and compress the connected cluster, and a final pass separates overlaps.
 */
export function forceLayout(
  ids: string[],
  links: { from: string; to: string }[],
  opts: ForceOptions & { minSeparation?: number },
): Map<string, Point> {
  const n = ids.length
  const out = new Map<string, Point>()
  if (!n) return out
  const pad = 48
  const cx = opts.width / 2
  const cy = opts.height / 2
  const minX = pad
  const maxX = Math.max(pad + 1, opts.width - pad)
  const minY = pad
  const maxY = Math.max(pad + 1, opts.height - pad)
  const clampPt = (p: Point) => {
    p.x = Math.min(maxX, Math.max(minX, p.x))
    p.y = Math.min(maxY, Math.max(minY, p.y))
  }
  const radius = Math.min(opts.width, opts.height) * 0.38
  const pos = ids.map((_, i) => ({
    x: cx + radius * Math.cos((2 * Math.PI * i) / n),
    y: cy + radius * Math.sin((2 * Math.PI * i) / n),
  }))
  const index = new Map(ids.map((id, i) => [id, i]))
  // Each connected pair attracts once, however many typed links join it.
  const seen = new Set<string>()
  const pairs: (readonly [number, number])[] = []
  for (const l of links) {
    const a = index.get(l.from)
    const b = index.get(l.to)
    if (a === undefined || b === undefined || a === b) continue
    const key = a < b ? `${a}-${b}` : `${b}-${a}`
    if (seen.has(key)) continue
    seen.add(key)
    pairs.push([a, b] as const)
  }
  const k = Math.sqrt(((opts.width - 2 * pad) * (opts.height - 2 * pad)) / n) * 0.75
  const iterations = opts.iterations ?? 300
  for (let it = 0; it < iterations; it++) {
    const cool = 1 - it / iterations
    const disp = pos.map(() => ({ x: 0, y: 0 }))
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i]!.x - pos[j]!.x
        let dy = pos[i]!.y - pos[j]!.y
        let d = Math.hypot(dx, dy)
        if (d < 0.01) {
          dx = 0.01 * (i + 1)
          dy = 0.01 * (j + 1)
          d = Math.hypot(dx, dy)
        }
        const f = (k * k) / d
        disp[i]!.x += (dx / d) * f
        disp[i]!.y += (dy / d) * f
        disp[j]!.x -= (dx / d) * f
        disp[j]!.y -= (dy / d) * f
      }
    }
    for (const [a, b] of pairs) {
      const dx = pos[a]!.x - pos[b]!.x
      const dy = pos[a]!.y - pos[b]!.y
      const d = Math.max(0.01, Math.hypot(dx, dy))
      const f = (d * d) / k
      disp[a]!.x -= (dx / d) * f
      disp[a]!.y -= (dy / d) * f
      disp[b]!.x += (dx / d) * f
      disp[b]!.y += (dy / d) * f
    }
    for (let i = 0; i < n; i++) {
      // Gravity toward the centre keeps separate components in view.
      disp[i]!.x += (cx - pos[i]!.x) * 0.9
      disp[i]!.y += (cy - pos[i]!.y) * 0.9
      const d = Math.max(0.01, Math.hypot(disp[i]!.x, disp[i]!.y))
      const step = Math.min(d, 36 * cool + 1)
      pos[i]!.x += (disp[i]!.x / d) * step
      pos[i]!.y += (disp[i]!.y / d) * step
      clampPt(pos[i]!)
    }
  }
  // Separate any remaining overlaps so every node stays individually clickable.
  const sep = opts.minSeparation ?? 64
  for (let pass = 0; pass < 80; pass++) {
    let moved = false
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[j]!.x - pos[i]!.x
        let dy = pos[j]!.y - pos[i]!.y
        let d = Math.hypot(dx, dy)
        if (d >= sep) continue
        if (d < 0.01) {
          dx = Math.cos(i + 1)
          dy = Math.sin(j + 1)
          d = 1
        }
        const push = (sep - d) / 2 + 0.5
        pos[i]!.x -= (dx / d) * push
        pos[i]!.y -= (dy / d) * push
        pos[j]!.x += (dx / d) * push
        pos[j]!.y += (dy / d) * push
        clampPt(pos[i]!)
        clampPt(pos[j]!)
        moved = true
      }
    }
    if (!moved) break
  }
  ids.forEach((id, i) => out.set(id, { x: pos[i]!.x, y: pos[i]!.y }))
  return out
}

/** Cubic bezier midpoint (t = 0.5). */
export function bezierMid(p0: Point, p1: Point, p2: Point, p3: Point): Point {
  return {
    x: (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8,
    y: (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8,
  }
}
