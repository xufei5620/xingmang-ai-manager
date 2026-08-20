import { createContext, memo, useContext, useState } from 'react'
import { BaseEdge, EdgeToolbar, getBezierPath, type Edge, type EdgeProps, type EdgeTypes } from '@xyflow/react'
import { Plus, Unlink } from 'lucide-react'
import {
  canvasEdgeCurvature,
  canvasEdgeIsFlowing,
  canvasEdgeMidpoint,
  canvasEdgeStroke,
  canvasEdgeTone,
} from './workflow-edge-model'

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
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: canvasEdgeCurvature,
  })
  const tone = canvasEdgeTone(sourceHandleId)
  const midpoint = canvasEdgeMidpoint({ x: sourceX, y: sourceY }, { x: targetX, y: targetY })
  const flowing = canvasEdgeIsFlowing(data)
  const active = selected || hovered
  return (
    <>
      {/* A transparent wide path carries the pointer. The visible stroke is
          1.15px, which is far too thin to click or hover reliably. */}
      <path
        className="wf-edge-hit"
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={18}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      />
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        className={`wf-edge wf-edge-${tone}${active ? ' is-active' : ''}${flowing ? ' is-flowing' : ''}`}
        style={{ stroke: canvasEdgeStroke, strokeWidth: active ? 1.35 : 1.15 }}
      />
      {flowing && (
        <path
          className={`wf-edge-flow wf-edge-flow-${tone}`}
          d={path}
          fill="none"
          stroke={canvasEdgeStroke}
          strokeWidth={1.2}
          strokeLinecap="round"
        />
      )}
      <EdgeToolbar edgeId={id} x={midpoint.x} y={midpoint.y} isVisible={selected}>
        <div className="wf-edge-toolbar">
          <button
            type="button"
            title="在这里插入节点"
            aria-label="在这里插入节点"
            onClick={(event) => handlers.onInsertNode(id, { x: event.clientX, y: event.clientY })}
          ><Plus size={13} /></button>
          <button
            type="button"
            title="删除这条连线"
            aria-label="删除这条连线"
            onClick={() => handlers.onDisconnect(id)}
          ><Unlink size={13} /></button>
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
