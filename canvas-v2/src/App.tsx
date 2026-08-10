import { useCallback, useEffect, useRef, useState } from 'react'
import {
  addEdge,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  createEmptyWorkflow,
  parseWorkflowFile,
  serializeWorkflow,
  type NodeKind,
  type WorkflowEdge,
  type WorkflowFile,
  type WorkflowNode,
} from './model'
import { createMockExecutors, runWorkflow } from './engine/engine'
import { hostBridge } from './host'
import { isValidWorkflowConnection } from './ports'
import { nodeTypes, registerNodeChangeHandlers, type CanvasNode } from './nodes/WorkflowNodes'

// 画布装配层:@xyflow/react 的 Node/Edge 与领域模型互相映射,引擎与
// 持久化只见领域模型。M0 执行走 mock 执行器(不出网);M1 把 executors
// 换成 relay 真实现(engine/relay.ts),本文件的编排逻辑不变。

let nodeSequence = 0

function nextNodeId(): string {
  nodeSequence += 1
  return `n${Date.now().toString(36)}-${nodeSequence}`
}

function toCanvasNode(node: WorkflowNode): CanvasNode {
  return { id: node.id, type: node.kind, position: node.position, data: { ...node.data } }
}

function toWorkflowNode(node: CanvasNode): WorkflowNode {
  return {
    id: node.id,
    kind: node.type as NodeKind,
    position: node.position,
    data: {
      prompt: node.data.prompt,
      model: node.data.model,
      status: node.data.status,
      result: node.data.result,
      errorMessage: node.data.errorMessage,
      costQuota: node.data.costQuota,
    },
  }
}

function toWorkflowEdge(edge: Edge): WorkflowEdge {
  return {
    id: edge.id,
    source: edge.source,
    sourceHandle: edge.sourceHandle ?? '',
    target: edge.target,
    targetHandle: edge.targetHandle ?? '',
  }
}

export function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [running, setRunning] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const patchNodeData = useCallback((nodeId: string, patch: Partial<CanvasNode['data']>) => {
    setNodes((current) => current.map((node) => (
      node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node
    )))
  }, [setNodes])

  useEffect(() => {
    registerNodeChangeHandlers({
      onPromptChange: (nodeId, prompt) => patchNodeData(nodeId, { prompt }),
      onModelChange: (nodeId, model) => patchNodeData(nodeId, { model }),
    })
  }, [patchNodeData])

  const addNode = (kind: NodeKind) => {
    const node: WorkflowNode = {
      id: nextNodeId(),
      kind,
      position: { x: 120 + Math.random() * 240, y: 120 + Math.random() * 160 },
      data: { prompt: '', model: '', status: 'idle' },
    }
    setNodes((current) => [...current, toCanvasNode(node)])
  }

  const onConnect = useCallback((connection: Connection) => {
    setEdges((current) => addEdge(connection, current))
  }, [setEdges])

  const isValidConnection = useCallback((connection: Connection | Edge) => (
    isValidWorkflowConnection(connection as Connection, {
      nodeKindOf: (nodeId) => {
        const node = nodes.find((entry) => entry.id === nodeId)
        return (node?.type as NodeKind | undefined) ?? null
      },
      edges,
    })
  ), [nodes, edges])

  const run = async () => {
    if (running) return
    setRunning(true)
    setBanner(null)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const outcome = await runWorkflow(
        nodes.map(toWorkflowNode),
        edges.map(toWorkflowEdge),
        createMockExecutors(),
        { onNodeUpdate: patchNodeData },
        controller.signal,
      )
      setBanner(`运行结束:成功 ${outcome.succeeded.length} / 失败 ${outcome.failed.length} / 跳过 ${outcome.skipped.length}`)
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
    } finally {
      abortRef.current = null
      setRunning(false)
    }
  }

  const cancel = () => abortRef.current?.abort()

  const save = async () => {
    const workflow: WorkflowFile = {
      ...createEmptyWorkflow('画布工作流'),
      nodes: nodes.map(toWorkflowNode),
      edges: edges.map(toWorkflowEdge),
    }
    const result = await hostBridge().saveFile({
      defaultFileName: 'xingmang-workflow.json',
      content: serializeWorkflow(workflow),
    })
    if (result.saved) setBanner('工作流已保存')
  }

  const load = async () => {
    const picked = await hostBridge().pickFile()
    if (!picked) return
    const workflow = parseWorkflowFile(picked.content)
    if (!workflow) {
      setBanner('无法读取该文件:不是有效的星芒工作流')
      return
    }
    setNodes(workflow.nodes.map(toCanvasNode))
    setEdges(workflow.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.sourceHandle,
      target: edge.target,
      targetHandle: edge.targetHandle,
    })))
    setBanner(`已打开「${workflow.name}」`)
  }

  return (
    <div className="canvas-app">
      <header className="canvas-toolbar">
        <strong>星芒无限画布</strong>
        <div className="canvas-toolbar-group">
          <button type="button" onClick={() => addNode('text')}>+ 文本</button>
          <button type="button" onClick={() => addNode('image')}>+ 图像</button>
          <button type="button" onClick={() => addNode('video')}>+ 视频</button>
        </div>
        <div className="canvas-toolbar-group">
          <button type="button" onClick={() => void load()}>打开</button>
          <button type="button" onClick={() => void save()}>保存</button>
          {running
            ? <button type="button" className="canvas-run" onClick={cancel}>取消</button>
            : <button type="button" className="canvas-run" onClick={() => void run()} disabled={nodes.length === 0}>运行</button>}
        </div>
        {banner && <span className="canvas-banner">{banner}</span>}
      </header>
      <div className="canvas-flow">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          fitView
          proOptions={{ hideAttribution: false }}
        >
          <Background />
          <MiniMap pannable zoomable />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  )
}
