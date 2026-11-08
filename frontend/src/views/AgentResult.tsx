// How each agent's result is shown. The data is the agent's own JSON output (see types.ts);
// every number shown under "Checked with the tools" comes from the tools, not from a model.
import { useState } from 'react'
import { CodeBlock } from '../design/ui.tsx'
import { plural } from '../format.ts'
import { countByTool, isIssue, severityLevel, sortFindings } from '../pipeline.ts'
import type {
  AgentRun,
  CommonResult,
  CorrectionResult,
  DocumentationResult,
  ImprovementResult,
  StaticResult,
  TestsResult,
  UnderstandingResult,
} from '../types.ts'

type Result = Record<string, unknown>

const as = <T,>(r: Result) => r as unknown as T

function stem(file: string): string {
  return (file.split('/').pop() ?? 'code').replace(/\.py$/, '')
}

/** One line under an agent's name in the list. */
export function resultSummary(id: string, run: AgentRun): string | null {
  const r = run.result
  if (run.status !== 'ok' || !r) return null
  switch (id) {
    case 'static_analysis': {
      const issues = (as<StaticResult>(r).findings ?? []).filter(isIssue).length
      return issues ? plural(issues, 'issue') : 'No issues'
    }
    case 'code_understanding':
      return plural(as<UnderstandingResult>(r).complex_sections?.length ?? 0, 'complex section')
    case 'improvement_suggestion':
      return plural(as<ImprovementResult>(r).improvements?.length ?? 0, 'suggestion')
    case 'documentation_agent':
      return plural(as<DocumentationResult>(r).docstrings?.length ?? 0, 'docstring')
    case 'test_generator': {
      const v = as<TestsResult>(r).verification
      if (!v?.ran) return 'Tests not run'
      return v.passed
        ? v.tests === 1
          ? '1 test passes'
          : `${v.tests ?? 0} tests pass`
        : `${(v.failures ?? 0) + (v.errors ?? 0)} of ${v.tests ?? 0} fail`
    }
    case 'code_correction': {
      const v = as<CorrectionResult>(r).verification
      if (!v?.syntax_valid) return 'Does not compile'
      return `Findings ${v.total_before ?? '?'} → ${v.total_after ?? '?'}`
    }
  }
  return null
}

export function AgentResult({ id, run, file }: { id: string; run: AgentRun; file: string }) {
  const r = run.result
  if (!r) return null
  switch (id) {
    case 'static_analysis':
      return <StaticFindings result={as<StaticResult>(r)} />
    case 'code_understanding':
      return <Understanding result={as<UnderstandingResult>(r)} />
    case 'improvement_suggestion':
      return <Improvements result={as<ImprovementResult>(r)} />
    case 'documentation_agent':
      return <Documentation result={as<DocumentationResult>(r)} />
    case 'test_generator':
      return <Tests result={as<TestsResult>(r)} file={file} />
    case 'code_correction':
      return <Correction result={as<CorrectionResult>(r)} file={file} />
  }
  return <pre className="result__raw">{JSON.stringify(r, null, 2)}</pre>
}

// ------------------------------------------------------------------ static analysis

function StaticFindings({ result }: { result: StaticResult }) {
  const [tool, setTool] = useState<string>('all')
  const issues = sortFindings((result.findings ?? []).filter(isIssue))
  const counts = countByTool(result.findings ?? [])
  const shown = tool === 'all' ? issues : issues.filter((f) => f.type === tool)
  const broken = Object.entries(result.tools ?? {}).filter(([, s]) => s !== 'ok')
  return (
    <div className="result">
      <div className="filters" role="group" aria-label="Filter by tool">
        <button
          type="button"
          className={`chip chip--btn${tool === 'all' ? ' chip--on' : ''}`}
          aria-pressed={tool === 'all'}
          onClick={() => setTool('all')}
        >
          All <span className="count">{issues.length}</span>
        </button>
        {counts.map((c) => (
          <button
            key={c.tool}
            type="button"
            className={`chip chip--btn${tool === c.tool ? ' chip--on' : ''}`}
            aria-pressed={tool === c.tool}
            onClick={() => setTool(c.tool)}
          >
            {c.tool} <span className="count">{c.count}</span>
          </button>
        ))}
      </div>
      {broken.length > 0 && (
        <p className="callout callout--blocked">
          {broken.map(([t, s]) => `${t}: ${s}`).join('. ')}.
        </p>
      )}
      {shown.length === 0 ? (
        <p className="muted">No issues{tool === 'all' ? '' : ` from ${tool}`}.</p>
      ) : (
        <div className="table-wrap">
          <table className="table findings">
            <thead>
              <tr>
                <th scope="col">Line</th>
                <th scope="col">Tool</th>
                <th scope="col">Severity</th>
                <th scope="col">Issue</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((f, i) => (
                <tr key={i}>
                  <td className="mono">{f.line ?? '–'}</td>
                  <td>{f.type}</td>
                  <td>
                    <span className={`sev sev--${severityLevel(f.severity)}`}>{f.severity}</span>
                  </td>
                  <td>
                    {f.code && <span className="mono findings__code">{f.code}</span>}
                    {f.code && f.message.startsWith(f.code)
                      ? f.message.slice(f.code.length).trim()
                      : f.message}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ understanding

function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/\n{2,}/)
        .filter((p) => p.trim())
        .map((p, i) => (
          <p key={i} className="prose">
            {p.trim()}
          </p>
        ))}
    </>
  )
}

function Understanding({ result }: { result: UnderstandingResult }) {
  const sections = result.complex_sections ?? []
  return (
    <div className="result">
      <Paragraphs text={result.explanation ?? ''} />
      <h3>Complex sections</h3>
      {sections.length === 0 ? (
        <p className="muted">None found.</p>
      ) : (
        <ul className="itemlist">
          {sections.map((s, i) => (
            <li key={i}>
              <span className="mono itemlist__where">
                {s.end_line && s.end_line !== s.line
                  ? `Lines ${s.line}–${s.end_line}`
                  : `Line ${s.line}`}
              </span>
              <span>{s.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ improvements

function Improvements({ result }: { result: ImprovementResult }) {
  const items = result.improvements ?? []
  if (!items.length) return <p className="muted">No suggestions.</p>
  return (
    <ol className="itemlist itemlist--numbered">
      {items.map((it, i) => (
        <li key={i}>
          <div className="itemlist__meta">
            {it.severity && (
              <span className={`sev sev--${severityLevel(it.severity)}`}>{it.severity}</span>
            )}
            {it.category && <span className="chip">{it.category}</span>}
            <span className="mono muted">{it.line ? `Line ${it.line}` : 'Whole file'}</span>
          </div>
          <p>{it.description}</p>
          {!!it.related_findings?.length && (
            <p className="muted itemlist__related">
              Addresses{' '}
              {it.related_findings.map((c) => (
                <span key={c} className="mono findings__code">
                  {c}
                </span>
              ))}
            </p>
          )}
        </li>
      ))}
    </ol>
  )
}

// ------------------------------------------------------------------ documentation

function Documentation({ result }: { result: DocumentationResult }) {
  if (!result.overview && !result.docstrings) {
    return <pre className="result__raw">{result.documentation}</pre>
  }
  return (
    <div className="result">
      {result.overview && <Paragraphs text={result.overview} />}
      {!!result.docstrings?.length && (
        <>
          <h3>Docstrings</h3>
          <dl className="docstrings">
            {result.docstrings.map((d, i) => (
              <div key={i}>
                <dt>
                  <span className="mono">{d.name}</span> <span className="muted">{d.kind}</span>
                </dt>
                <dd>
                  <pre>{d.docstring}</pre>
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {result.usage_example?.trim() && (
        <>
          <h3>Usage</h3>
          <CodeBlock code={result.usage_example} />
        </>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ tests

function Tests({ result, file }: { result: TestsResult; file: string }) {
  const v = result.verification
  const name = `test_${result.module?.split('.').pop() ?? stem(file)}.py`
  return (
    <div className="result">
      <section className="checks" aria-label="Checked with pytest">
        <h3>Checked with pytest</h3>
        {!v ? (
          <p className="muted">No verification was reported.</p>
        ) : v.syntax_valid === false ? (
          <p className="check check--bad">The test file does not compile.</p>
        ) : !v.ran ? (
          <p className="check check--neutral">Not run: {v.reason ?? 'unknown reason'}.</p>
        ) : (
          <>
            <p className={`check ${v.passed ? 'check--good' : 'check--bad'}`}>
              {v.passed
                ? v.tests === 1
                  ? 'The test passes.'
                  : `All ${v.tests ?? 0} tests pass.`
                : `${(v.failures ?? 0) + (v.errors ?? 0)} of ${plural(v.tests ?? 0, 'test')} fail (${v.failures ?? 0} failures, ${v.errors ?? 0} errors).`}
            </p>
            {v.output && (
              <details className="details">
                <summary>pytest output</summary>
                <pre className="result__raw">{v.output}</pre>
              </details>
            )}
          </>
        )}
      </section>
      {result.notes?.trim() && (
        <>
          <h3>Notes from the agent</h3>
          <Paragraphs text={result.notes} />
        </>
      )}
      <CodeBlock code={result.tests} filename={name} />
    </div>
  )
}

// ------------------------------------------------------------------ correction

function Correction({ result, file }: { result: CorrectionResult; file: string }) {
  const v = result.verification
  const before = v?.findings_before ?? {}
  const after = v?.findings_after ?? {}
  const tools = Object.keys({ ...before, ...after })
  return (
    <div className="result">
      <section className="checks" aria-label="Checked with the linters">
        <h3>Checked with the linters</h3>
        {!v ? (
          <p className="muted">No verification was reported.</p>
        ) : (
          <>
            <ul className="checklist">
              <li className={v.syntax_valid ? 'check--good' : 'check--bad'}>
                {v.syntax_valid ? 'Compiles' : 'Does not compile'}
              </li>
              {v.syntax_valid && (
                <li className={v.api_preserved ? 'check--good' : 'check--bad'}>
                  {v.api_preserved
                    ? 'Public functions and classes kept'
                    : `Removed or renamed: ${(v.missing_api ?? []).join(', ')}`}
                </li>
              )}
              {v.syntax_valid && (
                <li
                  className={
                    (v.total_after ?? 0) < (v.total_before ?? 0)
                      ? 'check--good'
                      : (v.total_after ?? 0) > (v.total_before ?? 0)
                        ? 'check--bad'
                        : 'check--neutral'
                  }
                >
                  Linter findings: {v.total_before} before, {v.total_after} after
                </li>
              )}
            </ul>
            {v.syntax_valid && tools.length > 0 && (
              <table className="table table--compact beforeafter">
                <thead>
                  <tr>
                    <th scope="col">Tool</th>
                    <th scope="col">Before</th>
                    <th scope="col">After</th>
                  </tr>
                </thead>
                <tbody>
                  {tools.map((t) => (
                    <tr key={t}>
                      <td>{t}</td>
                      <td className="mono">{before[t] ?? 0}</td>
                      <td className="mono">{after[t] ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {!v.accepted && !!v.problems?.length && (
              <p className="callout callout--blocked">
                Not accepted by the checks: {v.problems.join('; ')}. Review the code carefully
                before using it.
              </p>
            )}
          </>
        )}
      </section>
      {!!result.changes?.length && (
        <>
          <h3>Changes</h3>
          <ul className="itemlist">
            {result.changes.map((c, i) => (
              <li key={i}>
                <span className="mono itemlist__where">
                  {c.line ? `Line ${c.line}` : 'Whole file'}
                </span>
                <span>{c.description}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {!!result.remaining_issues?.length && (
        <>
          <h3>Left as they are</h3>
          <ul className="bullets">
            {result.remaining_issues.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </>
      )}
      {result.corrected_code ? (
        <CodeBlock code={result.corrected_code} filename={`${stem(file)}_corrected.py`} />
      ) : (
        result.rejected_code && (
          <details className="details">
            <summary>Code that was rejected</summary>
            <pre className="result__raw">{result.rejected_code}</pre>
          </details>
        )
      )}
    </div>
  )
}

// ------------------------------------------------------------------ how the agent worked

export function HowItWorked({ result, llm }: { result: CommonResult; llm: boolean }) {
  const calls = result.tool_calls ?? []
  const usage = result.usage
  const single = result.mode?.startsWith('single_call')
  if (!calls.length && !usage && !single && !result.lint_source) return null
  return (
    <details className="details howitworked">
      <summary>How the agent worked</summary>
      <div className="howitworked__body">
        {llm && result.lint_source && (
          <p className="muted">
            {result.lint_source === 'static_analysis'
              ? 'Received the static analysis findings.'
              : 'Ran the linters itself (static analysis had no result to share).'}
          </p>
        )}
        {single && (
          <p className="muted">
            The model could not use tools here, so it answered in one step; the result was still
            checked with the tools.
          </p>
        )}
        {calls.length > 0 && (
          <ol className="trace">
            {calls.map((c, i) => (
              <li key={i}>
                <span className="mono trace__tool">{c.tool}</span>
                <span className="muted">{c.summary}</span>
              </li>
            ))}
          </ol>
        )}
        {usage && (
          <p className="muted">
            {plural(usage.requests, 'model request')},{' '}
            {(usage.prompt_tokens + usage.completion_tokens).toLocaleString('en-US')} tokens (
            {usage.prompt_tokens.toLocaleString('en-US')} in,{' '}
            {usage.completion_tokens.toLocaleString('en-US')} out).
          </p>
        )}
      </div>
    </details>
  )
}
