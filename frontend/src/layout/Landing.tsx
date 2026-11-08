import { useState } from 'react'
import { useApp } from '../state/store.ts'
import { KeyForm, ReviewForm } from './NewReview.tsx'

/** The five model-based agents, in the order they appear in the pipeline picture. */
const AGENTS = [
  { title: 'Explain', note: 'what the code does' },
  { title: 'Improve', note: 'ranked suggestions' },
  { title: 'Document', note: 'docstrings and overview' },
  { title: 'Write tests', note: 'runs them with pytest', tool: 'pytest' },
  { title: 'Correct', note: 're-checked by the linters', tool: 'linters' },
]

const NODE_X = 404
const NODE_W = 176
const NODE_H = 50
const FAN_X = 334
const FAN_Y = 220
const centers = AGENTS.map((_, i) => 47 + i * 84)

/** Code lines drawn in the file card: [indent, width, finding] */
const CODE: [number, number, '' | 'warn' | 'error'][] = [
  [0, 70, ''],
  [0, 104, ''],
  [14, 90, 'warn'],
  [14, 58, ''],
  [28, 84, ''],
  [0, 0, ''],
  [0, 96, ''],
  [14, 76, 'error'],
  [14, 100, ''],
  [28, 48, ''],
  [0, 0, ''],
  [0, 62, 'warn'],
]

function squiggle(x: number, y: number, w: number): string {
  let d = `M${x} ${y}`
  for (let i = 0; i < w; i += 6) d += ` q1.5 -2.5 3 0 q1.5 2.5 3 0`
  return d
}

/** The review pipeline: a file, static analysis, then five agents working side by side. */
export function PipelineArt() {
  return (
    <svg className="pipeart" viewBox="0 0 680 440" role="img" aria-labelledby="pipeart-title">
      <title id="pipeart-title">
        A Python file goes through static analysis; the findings go to five agents that run at the
        same time. The test writer runs its tests with pytest and the corrector re-checks its fixes
        with the linters.
      </title>
      <defs>
        <marker
          id="pa-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0 0 L8 4 L0 8 z" className="pipeart__arrowhead" />
        </marker>
      </defs>

      {/* the file under review */}
      <g>
        <rect x="16" y="110" width="156" height="220" rx="8" className="pipeart__file" />
        <path d="M16 140 H172" className="pipeart__rule" />
        <circle cx="30" cy="125" r="3" className="pipeart__chrome" />
        <circle cx="41" cy="125" r="3" className="pipeart__chrome" />
        <text x="56" y="129" className="pipeart__mono">
          review.py
        </text>
        {CODE.map(([indent, width, finding], i) => {
          if (!width) return null
          const x = 30 + indent
          const y = 156 + i * 14
          return (
            <g key={i}>
              <rect x={x} y={y} width={width} height="5" rx="2.5" className="pipeart__line" />
              {finding && (
                <path
                  d={squiggle(x, y + 9, width)}
                  className={`pipeart__squiggle pipeart__squiggle--${finding}`}
                />
              )}
            </g>
          )
        })}
      </g>

      <path d="M172 220 H204" className="pipeart__link" markerEnd="url(#pa-arrow)" />

      {/* static analysis */}
      <g>
        <rect x="206" y="180" width="128" height="80" rx="8" className="pipeart__static" />
        <text x="222" y="208" className="pipeart__title">
          Static analysis
        </text>
        <text x="222" y="228" className="pipeart__note">
          pylint, flake8,
        </text>
        <text x="222" y="244" className="pipeart__note">
          bandit, radon
        </text>
      </g>

      {/* findings fan out to the agents, which run in parallel */}
      {centers.map((cy, i) => {
        const d = `M${FAN_X} ${FAN_Y} C ${FAN_X + 38} ${FAN_Y}, ${NODE_X - 40} ${cy}, ${NODE_X - 2} ${cy}`
        return (
          <g key={i}>
            <path d={d} className="pipeart__link" markerEnd="url(#pa-arrow)" />
            <path d={d} className="pipeart__pulse" pathLength={100} />
          </g>
        )
      })}

      {AGENTS.map((a, i) => {
        const cy = centers[i]
        const y = cy - NODE_H / 2
        return (
          <g key={a.title}>
            <rect
              x={NODE_X}
              y={y}
              width={NODE_W}
              height={NODE_H}
              rx="8"
              className="pipeart__agent"
            />
            <circle cx={NODE_X + 18} cy={cy} r="4.5" className="pipeart__dot" />
            <text x={NODE_X + 32} y={cy - 3} className="pipeart__title">
              {a.title}
            </text>
            <text x={NODE_X + 32} y={cy + 13} className="pipeart__note">
              {a.note}
            </text>
            {a.tool && (
              <g>
                <path
                  d={`M${NODE_X + NODE_W} ${cy - 5} H602`}
                  className="pipeart__loop"
                  markerEnd="url(#pa-arrow)"
                />
                <path
                  d={`M604 ${cy + 5} H${NODE_X + NODE_W + 2}`}
                  className="pipeart__loop"
                  markerEnd="url(#pa-arrow)"
                />
                <rect
                  x="604"
                  y={cy - 13}
                  width="64"
                  height="26"
                  rx="13"
                  className="pipeart__tool"
                />
                <text x="636" y={cy + 4} textAnchor="middle" className="pipeart__mono">
                  {a.tool}
                </text>
              </g>
            )}
          </g>
        )
      })}
    </svg>
  )
}

/** Step 1 in upload deployments: the visitor's Hugging Face key. */
function KeyStep() {
  const { hasKey } = useApp()
  const [editing, setEditing] = useState(false)
  if (hasKey && !editing) {
    return (
      <div className="landing__saved">
        <span className="landing__check" aria-hidden="true" />
        <span>Key saved in this browser.</span>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(true)}>
          Change
        </button>
      </div>
    )
  }
  return <KeyForm compact />
}

/** Shown by a live backend before the first review exists. */
export function FirstRun() {
  const { repoLabel, submitMode, hasKey } = useApp()
  const upload = submitMode === 'upload'
  return (
    <div className="landing">
      <section className="landing__story" aria-labelledby="landing-title">
        <div className="landing__brand">
          <img src="favicon.svg" alt="" width="22" height="22" />
          <span>Horizon AI</span>
        </div>
        <div className="landing__intro">
          <h1 id="landing-title">Six agents review your Python code at the same time</h1>
          <p>
            The linters find the issues first. Five agents then explain the code, suggest
            improvements, write the documentation, write and run tests, and correct the file.
          </p>
        </div>
        <PipelineArt />
        <ul className="landing__facts">
          <li>A correction that doesn’t compile, or adds issues, is sent back to the agent.</li>
          <li>Nothing counts until you have read an agent’s output and approved it.</li>
          {upload ? (
            <li>Your key stays in this browser and is used only for your reviews.</li>
          ) : (
            <li>Connected to {repoLabel.replace('Live · ', '')}, using the key in your .env.</li>
          )}
        </ul>
      </section>

      <section className="landing__panel" aria-labelledby="landing-start">
        <div className="landing__panel-inner">
          <h2 id="landing-start">Start a review</h2>
          <p className="muted">
            {upload
              ? 'Add your key, then paste or upload a Python file.'
              : 'Pick a Python file from the project and start.'}
          </p>
          <ol className={`landing__steps${upload ? '' : ' landing__steps--single'}`}>
            {upload && (
              <li className={hasKey ? 'is-done' : undefined}>
                <h3>Add your Hugging Face key</h3>
                <KeyStep />
              </li>
            )}
            <li className={upload && !hasKey ? 'is-waiting' : undefined}>
              <h3>{upload ? 'Choose the code' : 'Choose a file'}</h3>
              <ReviewForm />
            </li>
          </ol>
        </div>
      </section>
    </div>
  )
}
