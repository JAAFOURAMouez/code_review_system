import { DemoTag } from '../design/ui.tsx'
import { AgentInspector } from '../inspectors/AgentInspector.tsx'
import { TaskInspector } from '../inspectors/TaskInspector.tsx'
import { deriveAgentState } from '../domain/rules.ts'
import { AGENT_STATE_LABEL, type AgentState } from '../domain/types.ts'
import { setParams, useRoute } from '../state/router.ts'
import { useWorkspace } from '../state/store.ts'
import { AgentGraph } from '../viz/AgentGraph.tsx'

export function Orchestration() {
  const ws = useWorkspace()
  const { params } = useRoute()
  const agentId = ws.agents.some((a) => a.id === params.agent) ? params.agent : undefined
  const taskId = params.task
  const counts: Record<AgentState, number> = {
    idle: 0,
    running: 0,
    completed: 0,
    blocked: 0,
    failed: 0,
  }
  for (const a of ws.agents) counts[deriveAgentState(a.id, ws.tasks)] += 1

  const noHandoffs = ws.tasks.length > 0 && ws.tasks.every((t) => t.dependsOn.length === 0)
  const open = !!(agentId || taskId)
  return (
    <div className={`split${open ? ' split--open' : ''}`}>
      <div className="split__main page page--fill">
        <div className="page__head">
          <div>
            <h1>Agent Orchestration</h1>
            <p>
              {noHandoffs
                ? 'Each node is derived from its tasks. Arrows show the order the orchestrator runs the agents in. No output is passed between them: every agent works on the same file.'
                : 'Each node is derived from its tasks. Lines show handoffs: an agent delivers an output that another agent’s task depends on.'}
            </p>
          </div>
          <div className="page__actions">
            <DemoTag />
          </div>
        </div>
        <ul className="statestrip" aria-label="Agents by state">
          {(['running', 'completed', 'blocked', 'failed', 'idle'] as AgentState[]).map((s) => (
            <li key={s}>
              <span className="statestrip__n">{counts[s]}</span> {AGENT_STATE_LABEL[s]}
            </li>
          ))}
        </ul>
        <div className="panel graphpanel">
          <AgentGraph
            agents={ws.agents}
            tasks={ws.tasks}
            selectedId={agentId}
            onSelect={(id) => setParams({ agent: id, task: undefined })}
          />
        </div>
      </div>
      {taskId ? (
        <TaskInspector
          taskId={taskId}
          onClose={() => setParams({ agent: undefined, task: undefined })}
          onSelectTask={(id) => setParams({ task: id })}
          onBack={agentId ? () => setParams({ task: undefined }) : undefined}
          backLabel="Agent"
        />
      ) : agentId ? (
        <AgentInspector
          agentId={agentId}
          onClose={() => setParams({ agent: undefined })}
          onSelectTask={(id) => setParams({ task: id })}
          onSelectAgent={(id) => setParams({ agent: id })}
        />
      ) : null}
    </div>
  )
}
