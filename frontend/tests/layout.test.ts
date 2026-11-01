import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deriveHandoffs } from '../src/domain/rules.ts'
import { createSeedWorkspace } from '../src/domain/seed.ts'
import { bezierMid, forceLayout, layeredLayout } from '../src/viz/layout.ts'

const ws = createSeedWorkspace(Date.parse('2026-10-29T12:00:00Z'))
const opts = { nodeWidth: 200, nodeHeight: 90, columnGap: 80, rowGap: 30 }

test('layered layout puts every consumer to the right of its producer', () => {
  const edges = deriveHandoffs(ws.tasks)
  const layout = layeredLayout(
    ws.agents.map((a) => a.id),
    edges,
    opts,
  )
  for (const e of edges) {
    assert.ok(
      layout.positions.get(e.to)!.x > layout.positions.get(e.from)!.x,
      `${e.from} -> ${e.to}`,
    )
  }
  assert.equal(layout.positions.size, ws.agents.length)
})

test('wrapped layout keeps flow readable: consumers are to the right or in a lower band', () => {
  const edges = deriveHandoffs(ws.tasks)
  const wrapOpts = { ...opts, wrapAfter: 4, bandGap: 90 }
  const layout = layeredLayout(
    ws.agents.map((a) => a.id),
    edges,
    wrapOpts,
  )
  const maxLayer = Math.max(...layout.layers.values())
  assert.ok(maxLayer >= 5, 'sample pipeline is deep enough to need wrapping')
  assert.ok(layout.width <= 4 * (opts.nodeWidth + opts.columnGap), 'at most 4 columns wide')
  for (const e of edges) {
    const a = layout.positions.get(e.from)!
    const b = layout.positions.get(e.to)!
    assert.ok(b.x > a.x || b.y >= a.y + opts.nodeHeight, `${e.from} -> ${e.to}`)
  }
  const pts = [...layout.positions.values()]
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++)
      assert.ok(
        Math.abs(pts[i]!.x - pts[j]!.x) >= opts.nodeWidth ||
          Math.abs(pts[i]!.y - pts[j]!.y) >= opts.nodeHeight,
        'overlap',
      )
})

test('layered layout never overlaps nodes', () => {
  const edges = deriveHandoffs(ws.tasks)
  const layout = layeredLayout(
    ws.agents.map((a) => a.id),
    edges,
    opts,
  )
  const pts = [...layout.positions.values()]
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = Math.abs(pts[i]!.x - pts[j]!.x)
      const dy = Math.abs(pts[i]!.y - pts[j]!.y)
      assert.ok(dx >= opts.nodeWidth || dy >= opts.nodeHeight, 'nodes overlap')
    }
  }
})

test('layered layout survives a cycle without hanging', () => {
  const layout = layeredLayout(
    ['a', 'b', 'c'],
    [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'a' },
    ],
    opts,
  )
  assert.equal(layout.positions.size, 3)
})

test('force layout is deterministic, in bounds, spread out and free of overlaps', () => {
  const ids = ws.memories.map((m) => m.id)
  const links = ws.memories.flatMap((m) => m.links.map((l) => ({ from: m.id, to: l.to })))
  const a = forceLayout(ids, links, { width: 920, height: 560 })
  const b = forceLayout(ids, links, { width: 920, height: 560 })
  assert.deepEqual([...a.entries()], [...b.entries()])
  const pts = [...a.values()]
  for (const p of pts) assert.ok(p.x >= 0 && p.x <= 920 && p.y >= 0 && p.y <= 560)
  let minDist = Infinity
  const nearest: number[] = []
  for (let i = 0; i < pts.length; i++) {
    let nn = Infinity
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue
      const d = Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.y - pts[j]!.y)
      nn = Math.min(nn, d)
      minDist = Math.min(minDist, d)
    }
    nearest.push(nn)
  }
  assert.ok(minDist >= 60, `nodes too close: ${minDist.toFixed(1)}`)
  // Spread: the graph should use most of the box, not collapse into a blob.
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  assert.ok(Math.max(...xs) - Math.min(...xs) > 920 * 0.6, 'uses most of the width')
  assert.ok(Math.max(...ys) - Math.min(...ys) > 560 * 0.6, 'uses most of the height')
  const avgNearest = nearest.reduce((s, v) => s + v, 0) / nearest.length
  assert.ok(
    avgNearest > 70,
    `average nearest-neighbour distance ${avgNearest.toFixed(0)} suggests clumping`,
  )
  // Linked memories should sit closer together than unrelated ones, on average.
  const linked = ws.memories.flatMap((m) => m.links.map((l) => [m.id, l.to] as const))
  const dist = (x: string, y: string) =>
    Math.hypot(a.get(x)!.x - a.get(y)!.x, a.get(x)!.y - a.get(y)!.y)
  const linkedAvg = linked.reduce((s, [x, y]) => s + dist(x, y), 0) / linked.length
  let all = 0
  let cnt = 0
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) ((all += dist(ids[i]!, ids[j]!)), cnt++)
  assert.ok(
    linkedAvg < all / cnt,
    `linked ${linkedAvg.toFixed(0)} should be closer than average ${(all / cnt).toFixed(0)}`,
  )
})

test('bezier midpoint is the average for a symmetric curve', () => {
  const m = bezierMid({ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 })
  assert.deepEqual(m, { x: 5, y: 7.5 })
})
