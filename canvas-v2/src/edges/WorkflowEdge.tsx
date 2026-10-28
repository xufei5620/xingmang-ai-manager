import { createContext, memo, useContext, useId, useState, type CSSProperties } from 'react'
import { BaseEdge, EdgeToolbar, getBezierPath, type Edge, type EdgeProps, type EdgeTypes } from '@xyflow/react'
import { Plus, Unlink } from 'lucide-react'
import {
  canvasEdgeCurvature,
  canvasEdgeIsFlowing,
  canvasEdgeInsertPoint,
  canvasEdgeTone,
  canvasEdgeToneLabel,
  canvasEdgeToneVariable,
} from './workflow-edge-model'
import '../theme/editor-edges.css'

export interface CanvasEdgeHandlers {
  onDisconnect(edgeId: string): void
  onInsertNode(edgeId: string, client: { x: number; y: number }): void
}

const noopHandlers: CanvasEdgeHandlers = {
  onDisconnect: () => undefined,
  onInsertNode: () => undefined,
}

const EdgeHandlersContext = createContext<CanvasEdgeHandlers>(noopHandlers)

export function CanvasEdgeHandlersProvider({ handlers, children }: {
  handlers: CanvasEdgeHandlers
  children: React.ReactNode
}) {
  return <EdgeHandlersContext.Provider value={handlers}>{children}</EdgeHandlersContext.Provider>
}

function WorkflowEdgeRenderer({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, sourceHandleId, selected, markerEnd, data,
}: EdgeProps) {
  const handlers = useContext(EdgeHandlersContext)
  const [hovered, setHovered] = useState(false)
  const arrowId = useId().replace(/:/g, '')
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: canvasEdgeCurvature,
  })
  const tone = canvasEdgeTone(sourceHandleId)
  const toneLabel = canvasEdgeToneLabel(tone)
  const toneStyle = { '--wf-edge-tone': canvasEdgeToneVariable(tone) } as CSSProperties
  const flowing = canvasEdgeIsFlowing(data)
  const active = selected || hovered
  return (
    <>
      {/* BaseEdge owns the wide hit path. A second transparent path underneath
          it never receives pointer events, so observe their shared group. */}
      <g
        className={`wf-edge-group${active ? ' is-active' : ''}`}
        style={toneStyle}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        <title>{`${toneLabel}连线 · 从输出连接到输入`}</title>
        {!markerEnd && <defs>
          <marker id={arrowId} viewBox="0 0 10 10" refX={16} refY={5} markerWidth={9} markerHeight={9} orient="auto" markerUnits="userSpaceOnUse">
            <path className="wf-edge-arrow" d="M 2 1 L 8 5 L 2 9" fill="none" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
          </marker>
        </defs>}
        <BaseEdge
          id={id}
          path={path}
          interactionWidth={24}
          markerEnd={markerEnd || `url(#${arrowId})`}
          className={`wf-edge wf-edge-${tone}${active ? ' is-active' : ''}${flowing ? ' is-flowing' : ''}`}
        />
        {flowing && (
          <path
            className={`wf-edge-flow wf-edge-flow-${tone}`}
            d={path}
            fill="none"
            strokeWidth={1.6}
            strokeLinecap="round"
          />
        )}
      </g>
      {/* Selected edges rise above nodes; their hit paths must stay below the controls. */}
      <EdgeToolbar edgeId={id} x={labelX} y={labelY} isVisible={selected} className="nodrag nopan" style={{ zIndex: 2000 }}>
        <div className="wf-edge-toolbar wf-edge-toolbar-polished" role="group" aria-label={`${toneLabel}连线操作`} style={toneStyle}>
          <span className="wf-edge-type"><i aria-hidden="true" />{toneLabel}</span>
          <button
            type="button"
            className="wf-edge-insert"
            title="在这里插入节点"
            aria-label="在这里插入节点"
            onClick={(event) => handlers.onInsertNode(id, canvasEdgeInsertPoint(event, event.currentTarget.getBoundingClientRect()))}
          ><Plus size={14} aria-hidden="true" /><span>插入节点</span></button>
          <button
            type="button"
            className="wf-edge-disconnect"
            title="删除这条连线"
            aria-label="删除这条连线"
            onClick={() => handlers.onDisconnect(id)}
          ><Unlink size={14} aria-hidden="true" /></button>
        </div>
      </EdgeToolbar>
    </>
  )
}

const WorkflowEdge = memo(WorkflowEdgeRenderer)
WorkflowEdge.displayName = 'WorkflowEdge'

export const canvasEdgeType = 'workflow'
export const edgeTypes: EdgeTypes = { [canvasEdgeType]: WorkflowEdge }
export const defaultEdgeOptions: Partial<Edge> = { type: canvasEdgeType }
