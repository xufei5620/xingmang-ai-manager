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
import { pollVideoTask, type RelayConfig } from './engine/relay'
import { hostBridge } from './host'
import { SimpleMode } from './SimpleMode'
import { isValidWorkflowConnection } from './ports'
import { defaultImageModel } from './models'
import { ModelSuggestions, nodeTypes, registerNodeChangeHandlers, type CanvasNode } from './nodes/WorkflowNodes'

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
  // 双模式(M2):简单模式=固定表单的单节点工作流,默认给小白;画布模式
  // 给要自己编排管线的用户。两种模式共享同一套 executors。
  const [viewMode, setViewMode] = useState<'simple' | 'canvas'>('simple')
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

  const downloadNodeAsset = useCallback(async (nodeId: string) => {
    const node = nodes.find((entry) => entry.id === nodeId)
    const asset = node?.data.result
    if (!asset?.remoteUrl || asset.remoteUrl.startsWith('mock://')) return
    const suggestedName = asset.kind === 'image'
      ? `xingmang-image-${nodeId}.png`
      : `xingmang-video-${nodeId}.mp4`
    const saved = await hostBridge().downloadAsset(asset.remoteUrl, suggestedName)
    if (saved) setBanner(`产物已保存到 ${saved.savedPath}`)
  }, [nodes])

  // 断线恢复:视频节点凭已落盘的 taskId 继续轮询(应用重启/中途关窗后
  // 打开工作流文件即可续查,不重新扣费提交任务)。
  const resumeTask = useCallback(async (nodeId: string) => {
    if (running) return
    const node = nodes.find((entry) => entry.id === nodeId)
    const taskId = node?.data.result?.taskId
    if (!taskId) return
    if (!relayConfig) {
      setBanner('未连接星芒账号,无法查询任务状态')
      return
    }
    setRunning(true)
    const controller = new AbortController()
    abortRef.current = controller
    patchNodeData(nodeId, { status: 'running', errorMessage: undefined })
    try {
      for (;;) {
        if (controller.signal.aborted) throw new Error('已取消')
        const state = await pollVideoTask(relayConfig, taskId)
        if (state.status === 'succeeded') {
          patchNodeData(nodeId, { status: 'succeeded', result: state.asset })
          setBanner('视频任务已完成')
          break
        }
        if (state.status === 'failed') throw new Error(state.reason)
        await new Promise((resolve) => setTimeout(resolve, 4_000))
      }
    } catch (error) {
      patchNodeData(nodeId, {
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
      })
    } finally {
      abortRef.current = null
      setRunning(false)
    }
  }, [running, nodes, relayConfig, patchNodeData])

  useEffect(() => {
    registerNodeChangeHandlers({
      onPromptChange: (nodeId, prompt) => patchNodeData(nodeId, { prompt }),
      onModelChange: (nodeId, model) => patchNodeData(nodeId, { model }),
      onRerun: (nodeId) => void rerunNode(nodeId),
      onDownloadAsset: (nodeId) => void downloadNodeAsset(nodeId),
      onResumeTask: (nodeId) => void resumeTask(nodeId),
    })
  }, [patchNodeData, rerunNode, downloadNodeAsset, resumeTask])

  const addNode = (kind: NodeKind) => {
    const node: WorkflowNode = {
      id: nextNodeId(),
      kind,
      position: { x: 120 + Math.random() * 240, y: 120 + Math.random() * 160 },
      // 图像节点预填当前默认模型(xm 已配渠道),省一次手输。
      data: { prompt: '', model: kind === 'image' ? defaultImageModel : '', status: 'idle' },
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

  // 「展开到画布」:把简单模式的一次输入物化成节点链,替换当前画布内容
  // (简单模式是入口形态,此时画布通常为空;后续可加"合并而非替换"选项)。
  const expandToCanvas = (workflow: WorkflowFile) => {
    setNodes(workflow.nodes.map(toCanvasNode))
    setEdges(workflow.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.sourceHandle,
      target: edge.target,
      targetHandle: edge.targetHandle,
    })))
    setViewMode('canvas')
    setBanner('已从简单模式展开为工作流,可继续编排')
  }

  if (viewMode === 'simple') {
    return (
      <div className="canvas-app">
        <header className="canvas-toolbar">
          <strong>星芒 AI 生成</strong>
          <div className="canvas-toolbar-group">
            <button type="button" onClick={() => setViewMode('canvas')}>画布模式</button>
          </div>
          <span className="canvas-mode">{relayConfig ? '已连接星芒账号' : '演示模式(未连接账号,运行为模拟)'}</span>
        </header>
        <SimpleMode
          executors={buildExecutors()}
          connected={relayConfig !== null}
          onExpandToCanvas={expandToCanvas}
        />
        <ModelSuggestions />
      </div>
    )
  }

  return (
    <div className="canvas-app">
      <header className="canvas-toolbar">
        <strong>星芒无限画布</strong>
        <div className="canvas-toolbar-group">
          <button type="button" onClick={() => setViewMode('simple')}>简单模式</button>
        </div>
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
      <ModelSuggestions />
    </div>
  )
}
