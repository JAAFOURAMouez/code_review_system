import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { Icon } from '../design/ui.tsx'

interface Transform {
  x: number
  y: number
  k: number
}

const MIN_K = 0.25
const MAX_K = 2.5
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export interface ViewportProps {
  /** Natural size of the content, used by "Fit". */
  contentWidth: number
  contentHeight: number
  label: string
  /** Never fit below this zoom; on small screens the content is then panned instead of shrunk. */
  minFitZoom?: number
  /** Changing this re-fits the view (for example when the node set changes). */
  fitKey?: string
  /** Overlay controls rendered next to the zoom buttons. */
  toolbar?: ReactNode
  /** Rendered over the canvas, bottom-left (legends). */
  overlay?: ReactNode
  children: (t: Transform) => ReactNode
  onBackgroundClick?: () => void
}

/**
 * Pan and zoom surface for SVG content. Mouse: drag to pan, wheel to zoom at the
 * cursor. Touch: drag and pinch. Keyboard: arrows pan, + and - zoom, 0 fits.
 */
export function Viewport({
  contentWidth,
  contentHeight,
  label,
  fitKey,
  minFitZoom = 0,
  toolbar,
  overlay,
  children,
  onBackgroundClick,
}: ViewportProps) {
  const host = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [t, setT] = useState<Transform>({ x: 0, y: 0, k: 1 })
  const tRef = useRef(t)
  tRef.current = t
  const fitted = useRef<string | null>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null)
  const pinch = useRef<{ dist: number; k: number } | null>(null)
  const suppressClick = useRef(false)
  /** Once the person pans or zooms, stop auto-fitting when the container resizes. */
  const userMoved = useRef(false)

  useLayoutEffect(() => {
    const el = host.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const fit = useCallback(() => {
    if (!size.w || !size.h || !contentWidth || !contentHeight) return
    const pad = 32
    const natural = Math.min(
      (size.w - pad * 2) / contentWidth,
      (size.h - pad * 2) / contentHeight,
      1.1,
    )
    const k = clamp(Math.max(natural, minFitZoom), MIN_K, MAX_K)
    if (k > natural + 0.001) {
      // Too big to show whole at a readable size: start at the top-left and let the person pan.
      setT({ k, x: pad / 2, y: pad })
    } else {
      setT({ k, x: (size.w - contentWidth * k) / 2, y: (size.h - contentHeight * k) / 2 })
    }
  }, [size.w, size.h, contentWidth, contentHeight, minFitZoom])

  // Fit once the size is known, when fitKey changes, and on resize until the user takes over.
  useEffect(() => {
    if (!size.w || !size.h) return
    const key = fitKey ?? 'default'
    if (fitted.current !== key) {
      fitted.current = key
      userMoved.current = false
      fit()
    } else if (!userMoved.current) {
      fit()
    }
  }, [size.w, size.h, fitKey, fit])

  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    userMoved.current = true
    const cur = tRef.current
    const k = clamp(cur.k * factor, MIN_K, MAX_K)
    const r = k / cur.k
    setT({ k, x: cx - (cx - cur.x) * r, y: cy - (cy - cur.y) * r })
  }, [])

  // Wheel needs a non-passive listener to prevent the page from scrolling.
  useEffect(() => {
    const el = host.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
        zoomAt(
          Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)),
          e.clientX - rect.left,
          e.clientY - rect.top,
        )
      } else {
        setT((cur) => ({ ...cur, x: cur.x - e.deltaX }))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const onPointerDown = (e: ReactPointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 1) {
      drag.current = {
        x: e.clientX,
        y: e.clientY,
        tx: tRef.current.x,
        ty: tRef.current.y,
        moved: false,
      }
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      pinch.current = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), k: tRef.current.k }
      drag.current = null
    }
  }
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const el = host.current
    if (pinch.current && pointers.current.size === 2 && el) {
      const [a, b] = [...pointers.current.values()]
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y)
      const rect = el.getBoundingClientRect()
      const target = clamp(pinch.current.k * (dist / pinch.current.dist), MIN_K, MAX_K)
      zoomAt(target / tRef.current.k, (a!.x + b!.x) / 2 - rect.left, (a!.y + b!.y) / 2 - rect.top)
      suppressClick.current = true
      return
    }
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.moved && Math.hypot(dx, dy) > 4) {
      d.moved = true
      el?.setPointerCapture(e.pointerId)
    }
    if (d.moved) {
      userMoved.current = true
      setT((cur) => ({ ...cur, x: d.tx + dx, y: d.ty + dy }))
    }
  }
  const onPointerUp = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (drag.current?.moved) suppressClick.current = true
    if (pointers.current.size < 2) pinch.current = null
    if (pointers.current.size === 0) drag.current = null
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.target !== host.current) return
    const step = 60
    userMoved.current = true
    if (e.key === 'ArrowLeft') setT((c) => ({ ...c, x: c.x + step }))
    else if (e.key === 'ArrowRight') setT((c) => ({ ...c, x: c.x - step }))
    else if (e.key === 'ArrowUp') setT((c) => ({ ...c, y: c.y + step }))
    else if (e.key === 'ArrowDown') setT((c) => ({ ...c, y: c.y - step }))
    else if (e.key === '+' || e.key === '=') zoomAt(1.2, size.w / 2, size.h / 2)
    else if (e.key === '-') zoomAt(1 / 1.2, size.w / 2, size.h / 2)
    else if (e.key === '0') {
      userMoved.current = false
      fit()
    } else return
    e.preventDefault()
  }

  return (
    <div
      className="viewport"
      ref={host}
      tabIndex={0}
      role="group"
      aria-label={`${label}. Drag to pan, scroll to zoom. Arrow keys pan, plus and minus zoom, zero fits to view.`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onClickCapture={(e: { stopPropagation: () => void }) => {
        if (suppressClick.current) {
          suppressClick.current = false
          e.stopPropagation()
        }
      }}
      onClick={(e: { target: unknown; currentTarget: unknown }) => {
        if (e.target === e.currentTarget || (e.target as Element).tagName === 'svg')
          onBackgroundClick?.()
      }}
    >
      <svg className="viewport__svg" width={size.w} height={size.h}>
        <g transform={`translate(${t.x} ${t.y}) scale(${t.k})`}>{children(t)}</g>
      </svg>
      <div className="viewport__tools">
        {toolbar}
        <div className="seg viewport__zoom" role="group" aria-label="Zoom">
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => zoomAt(1 / 1.25, size.w / 2, size.h / 2)}
          >
            <Icon name="minus" size={14} />
          </button>
          <button
            type="button"
            className="viewport__pct"
            aria-label="Fit to view"
            title="Fit to view"
            onClick={() => {
              userMoved.current = false
              fit()
            }}
          >
            {Math.round(t.k * 100)}%
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => zoomAt(1.25, size.w / 2, size.h / 2)}
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
      </div>
      {overlay && <div className="viewport__overlay">{overlay}</div>}
    </div>
  )
}
