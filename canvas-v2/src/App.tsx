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
import { createMockExecutors, runWorkflow, type NodeInputs } from './engine/engine'
import { createRelayExecutors } from './engine/executors'
import type { RelayConfig } from './engine/relay'
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
  // null = 宿主未给账号 token(浏览器开发态/未登录)→ 运行走 mock 执行器。
  const [relayConfig, setRelayConfig] = useState<RelayConfig | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    let active = true
    void hostBridge().getAuthToken()
      .then((token) => { if (active && token) setRelayConfig(token) })
      .catch(() => undefined)
    return () => { active = false }
  }, [])

  const patchNodeData = useCallback((nodeId: string, patch: Partial<CanvasNode['data']>) => {
    setNodes((current) => current.map((node) => (
      node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node
    )))
  }, [setNodes])

  const buildExecutors = useCallback(() => (
    relayConfig
      ? createRelayExecutors(relayConfig, {
          // 提交即落 taskId:运行中途保存工作流也能带走任务 ID,断线可恢复。
          onVideoTaskSubmitted: (nodeId, taskId) => patchNodeData(nodeId, {
            result: { kind: 'video', taskId },
          }),
        })
      : createMockExecutors()
  ), [relayConfig, patchNodeData])

  // 单节点重跑:输入不重新执行上游,直接取画布状态里上游节点的既有产物
  // (文本节点的输出=它的提示词;图像节点的输出=它上次成功的 result)。
  const rerunNode = useCallback(async (nodeId: string) => {
    if (running) return
    const target = nodes.find((entry) => entry.id === nodeId)
    if (!target) return
    const inputs: NodeInputs = {}
    for (const edge of edges) {
      if (edge.target !== nodeId) continue
      const source = nodes.find((entry) => entry.id === edge.source)
      if (!source) continue
      if (source.type === 'text') {
        inputs.text = inputs.text === undefined ? source.data.prompt : `${inputs.text}\n${source.data.prompt}`
      }
      if (source.type === 'image' && source.data.result?.kind === 'image') {
        inputs.image = source.data.result
      }
    }
    setRunning(true)
    const controller = new AbortController()
    abortRef.current = controller
    patchNodeData(nodeId, { status: 'running', errorMessage: undefined })
    try {
      const executors = buildExecutors()
      const result = await executors[target.type as NodeKind](toWorkflowNode(target), inputs, controller.signal)
      patchNodeData(nodeId, { status: 'succeeded', result: result.output.asset, costQuota: result.costQuota })
    } catch (error) {
      patchNodeData(nodeId, {
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
      })
    } finally {
      abortRef.current = null
      setRunning(false)
    }
  }, [running, nodes, edges, patchNodeData, buildExecutors])

  useEffect(() => {
    registerNodeChangeHandlers({
      onPromptChange: (nodeId, prompt) => patchNodeData(nodeId, { prompt }),
      onModelChange: (nodeId, model) => patchNodeData(nodeId, { model }),
      onRerun: (nodeId) => void rerunNode(nodeId),
    })
  }, [patchNodeData, rerunNode])

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
        buildExecutors(),
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
    const result = await hostBridge().saveFile('xingmang-workflow.json', serializeWorkflow(workflow))
    if (result) setBanner('工作流已保存')
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
        <span className="canvas-mode">{relayConfig ? '已连接星芒账号' : '演示模式(未连接账号,运行为模拟)'}</span>
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
