import { useState } from 'react'
import { useApp } from '../state/store.ts'
import { KeyForm, ReviewForm } from './NewReview.tsx'

/** The five agents the planner chooses among, in the order they appear in the picture. */
const AGENTS = [
  { title: 'Explain', note: 'what the code does' },
  { title: 'Improve', note: 'ranked suggestions' },
  { title: 'Document', note: 'docstrings and overview' },
  { title: 'Write tests', note: 'runs them with pytest', tool: 'pytest' },
  { title: 'Correct', note: 're-checked by the linters', tool: 'linters' },
]

const NODE_X = 412
const NODE_W = 170
const NODE_H = 50
const FAN_X = 382
const FAN_Y = 220
const centers = AGENTS.map((_, i) => 47 + i * 84)
/** The corrector waits for the test writer and uses its tests to check the fix. */
const DEPENDENT = AGENTS.length - 1

/** Code lines drawn in the file card: [indent, width, finding] */
const CODE_SCALE = 0.7
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

/** The review pipeline: a file, static analysis, the planner, then the agents it picks. */
export function PipelineArt() {
  return (
    <svg className="pipeart" viewBox="0 0 680 440" role="img" aria-labelledby="pipeart-title">
      <title id="pipeart-title">
        A Python file goes through static analysis. A planner, which also reads the memory of
        earlier reviews, picks the agents worth running on it. They run at the same time; the test
        writer runs its tests with pytest and passes them to the corrector, which re-checks its
        fixes with the linters.
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
        <rect x="16" y="110" width="118" height="220" rx="8" className="pipeart__file" />
        <path d="M16 140 H134" className="pipeart__rule" />
        <circle cx="30" cy="125" r="3" className="pipeart__chrome" />
        <circle cx="41" cy="125" r="3" className="pipeart__chrome" />
        <text x="52" y="129" className="pipeart__mono">
          review.py
        </text>
        {CODE.map(([indent, width, finding], i) => {
          if (!width) return null
          const x = 28 + indent * CODE_SCALE
          const w = width * CODE_SCALE
          const y = 156 + i * 14
          return (
            <g key={i}>
              <rect x={x} y={y} width={w} height="5" rx="2.5" className="pipeart__line" />
              {finding && (
                <path
                  d={squiggle(x, y + 9, w)}
                  className={`pipeart__squiggle pipeart__squiggle--${finding}`}
                />
              )}
            </g>
          )
        })}
      </g>

      <path d="M134 220 H150" className="pipeart__link" markerEnd="url(#pa-arrow)" />

      {/* static analysis */}
      <g>
        <rect x="152" y="180" width="112" height="80" rx="8" className="pipeart__static" />
        <text x="164" y="208" className="pipeart__title">
          Static analysis
        </text>
        <text x="164" y="228" className="pipeart__note">
          pylint, flake8,
        </text>
        <text x="164" y="244" className="pipeart__note">
          bandit, radon
        </text>
      </g>

      <path d="M264 220 H280" className="pipeart__link" markerEnd="url(#pa-arrow)" />

      {/* the planner chooses which agents are worth running on this file */}
      <g>
        <rect x="282" y="180" width="100" height="80" rx="8" className="pipeart__planner" />
        <text x="294" y="208" className="pipeart__title">
          Planner
        </text>
        <text x="294" y="228" className="pipeart__note">
          picks the agents
        </text>
        <text x="294" y="244" className="pipeart__note">
          this file needs
        </text>
      </g>

      {/* the memory of earlier reviews feeds the planner and the agents */}
      <g>
        <rect x="16" y="362" width="366" height="34" rx="8" className="pipeart__memory" />
        <text x="199" y="384" textAnchor="middle" className="pipeart__note">
          Memory of earlier reviews
        </text>
        <path
          d="M332 362 V264"
          className="pipeart__link pipeart__link--dashed"
          markerEnd="url(#pa-arrow)"
        />
      </g>

      {/* findings fan out to the agents, which run in parallel */}
      {centers.map((cy, i) => {
        if (i === DEPENDENT) return null
        const d = `M${FAN_X} ${FAN_Y} C ${FAN_X + 38} ${FAN_Y}, ${NODE_X - 40} ${cy}, ${NODE_X - 2} ${cy}`
        return (
          <g key={i}>
            <path d={d} className="pipeart__link" markerEnd="url(#pa-arrow)" />
            <path d={d} className="pipeart__pulse" pathLength={100} />
          </g>
        )
      })}

      {/* the tests go to the corrector, which uses them to check its fix */}
      <path
        d={`M${NODE_X + NODE_W / 2} ${centers[DEPENDENT - 1] + NODE_H / 2} V${centers[DEPENDENT] - NODE_H / 2 - 2}`}
        className="pipeart__link"
        markerEnd="url(#pa-arrow)"
      />
      <text
        x={NODE_X + NODE_W / 2 + 10}
        y={(centers[DEPENDENT - 1] + centers[DEPENDENT]) / 2 + 4}
        className="pipeart__note"
      >
        passes its tests
      </text>

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
  const { address, submitMode, hasKey } = useApp()
  const upload = submitMode === 'upload'
  return (
    <div className="landing">
      <section className="landing__story" aria-labelledby="landing-title">
        <div className="landing__brand">
          <img src="favicon.svg" alt="" width="22" height="22" />
          <span>Horizon AI</span>
        </div>
        <div className="landing__intro">
          <h1 id="landing-title">Agents review your Python code, chosen for each file</h1>
          <p>
            The linters find the issues first. A planner then picks the agents worth running on
            this file: explain the code, suggest improvements, write the documentation, write and
            run tests, and correct the file. They run at the same time.
          </p>
        </div>
        <PipelineArt />
        <ul className="landing__facts">
          <li>
            The corrector uses the generated tests, and is sent back if its fix doesn’t compile,
            fails them, or adds issues.
          </li>
          <li>Memory of earlier reviews shows what is new, fixed or still open.</li>
          <li>Nothing counts until you have read an agent’s output and approved it.</li>
          {upload ? (
            <li>Your key stays in this browser and is used only for your reviews.</li>
          ) : (
            <li>Connected to {address}, using the key in your .env.</li>
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
