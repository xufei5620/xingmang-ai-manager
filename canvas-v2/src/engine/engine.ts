import type { AssetRef, NodeKind, WorkflowEdge, WorkflowNode } from '../model'

// 客户端 DAG 执行引擎 —— 画布只描述图,这里负责跑。刻意零框架依赖:
// 输入是领域模型,副作用全部经注入的 executor/onNodeUpdate 回调发生,
// 因此可以在主仓 vitest(node 环境)里直接测。
// 执行策略见 docs/CANVAS-V2-PLAN.md 第 5 节:拓扑就绪即触发(不做整层
// barrier)、单节点失败不阻断无依赖分支、下游因上游失败标记 skipped。

export interface NodeInputs {
  /** 按输入端口类型汇集的上游产物:text 端口收上游文本,image 端口收 AssetRef。 */
  text?: string
  image?: AssetRef
}

export interface NodeExecutionResult {
  output: { text?: string; asset?: AssetRef }
  costQuota?: number
}

/**
 * 一种节点的执行实现。M0 用 mock 执行器;M1 换成 relay 真实现(文生图
 * 直调 + 视频任务轮询),接口不变。signal 用于整图取消。
 */
export type NodeExecutor = (
  node: WorkflowNode,
  inputs: NodeInputs,
  signal: AbortSignal,
) => Promise<NodeExecutionResult>

export interface RunCallbacks {
  onNodeUpdate(nodeId: string, update: {
    status: 'queued' | 'running' | 'succeeded' | 'failed'
    result?: AssetRef
    errorMessage?: string
    costQuota?: number
  }): void
}

export interface RunOutcome {
  succeeded: string[]
  failed: string[]
  /** 因上游失败/取消而未执行的节点。 */
  skipped: string[]
}

interface GraphIndex {
  nodesById: Map<string, WorkflowNode>
  /** target 节点 id → 入边列表。 */
  incoming: Map<string, WorkflowEdge[]>
  /** source 节点 id → 出边列表。 */
  outgoing: Map<string, WorkflowEdge[]>
}

function indexGraph(nodes: WorkflowNode[], edges: WorkflowEdge[]): GraphIndex {
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  const incoming = new Map<string, WorkflowEdge[]>()
  const outgoing = new Map<string, WorkflowEdge[]>()
  for (const edge of edges) {
    if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) continue
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge])
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge])
  }
  return { nodesById, incoming, outgoing }
}

/**
 * Kahn 拓扑排序。返回 null 表示图中有环 —— 画布连线校验(ports.ts)已经
 * 禁止成环,这里是引擎自身的防御(I5 精神:引擎不信任调用方给的图)。
 */
export function topologicalOrder(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[] | null {
  const { incoming, outgoing } = indexGraph(nodes, edges)
  const inDegree = new Map<string, number>(nodes.map((node) => [node.id, incoming.get(node.id)?.length ?? 0]))
  const queue = nodes.filter((node) => (inDegree.get(node.id) ?? 0) === 0).map((node) => node.id)
  const order: string[] = []
  while (queue.length > 0) {
    const id = queue.shift() as string
    order.push(id)
    for (const edge of outgoing.get(id) ?? []) {
      const next = (inDegree.get(edge.target) ?? 0) - 1
      inDegree.set(edge.target, next)
      if (next === 0) queue.push(edge.target)
    }
  }
  return order.length === nodes.length ? order : null
}

function collectInputs(
  node: WorkflowNode,
  index: GraphIndex,
  outputs: Map<string, NodeExecutionResult>,
): NodeInputs {
  const inputs: NodeInputs = {}
  for (const edge of index.incoming.get(node.id) ?? []) {
    const upstream = outputs.get(edge.source)
    if (!upstream) continue
    if (upstream.output.text !== undefined) {
      // 多条 text 入边时拼接(如多个提示词节点汇入一个图像节点)。
      inputs.text = inputs.text === undefined ? upstream.output.text : `${inputs.text}\n${upstream.output.text}`
    }
    if (upstream.output.asset?.kind === 'image') inputs.image = upstream.output.asset
  }
  return inputs
}

/**
 * 跑整张图。就绪即触发:节点在全部上游成功后立刻并发执行,慢分支不阻塞
 * 快分支。上游失败 → 整条下游链 skipped(不误跑半截管线烧额度)。
 */
export async function runWorkflow(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  executors: Record<NodeKind, NodeExecutor>,
  callbacks: RunCallbacks,
  signal: AbortSignal,
): Promise<RunOutcome> {
  const order = topologicalOrder(nodes, edges)
  if (order === null) throw new Error('工作流中存在循环连接,请先断开成环的连线')

  const index = indexGraph(nodes, edges)
  const outputs = new Map<string, NodeExecutionResult>()
  const outcome: RunOutcome = { succeeded: [], failed: [], skipped: [] }
  const settled = new Map<string, Promise<void>>()

  function upstreamPromises(nodeId: string): Promise<void>[] {
    return (index.incoming.get(nodeId) ?? []).map((edge) => settled.get(edge.source) ?? Promise.resolve())
  }

  for (const nodeId of order) {
    const node = index.nodesById.get(nodeId) as WorkflowNode
    const run = (async () => {
      await Promise.all(upstreamPromises(nodeId))
      const upstreamFailed = (index.incoming.get(nodeId) ?? []).some(
        (edge) => !outputs.has(edge.source),
      )
      if (upstreamFailed || signal.aborted) {
        outcome.skipped.push(nodeId)
        return
      }
      callbacks.onNodeUpdate(nodeId, { status: 'running' })
      try {
        const result = await executors[node.kind](node, collectInputs(node, index, outputs), signal)
        outputs.set(nodeId, result)
        outcome.succeeded.push(nodeId)
        callbacks.onNodeUpdate(nodeId, {
          status: 'succeeded',
          result: result.output.asset,
          costQuota: result.costQuota,
        })
      } catch (error) {
        outcome.failed.push(nodeId)
        callbacks.onNodeUpdate(nodeId, {
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : String(error),
        })
      }
    })()
    settled.set(nodeId, run)
    callbacks.onNodeUpdate(nodeId, { status: 'queued' })
  }

  await Promise.all(settled.values())
  return outcome
}

/** M0 的演示执行器:不出网,延时后返回占位产物,用来验证整条编排链路。 */
export function createMockExecutors(delayMs = 600): Record<NodeKind, NodeExecutor> {
  const wait = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('已取消'))
    }, { once: true })
  })
  return {
    text: async (node, _inputs, signal) => {
      await wait(signal)
      return { output: { text: node.data.prompt } }
    },
    image: async (node, inputs, signal) => {
      await wait(signal)
      const prompt = [inputs.text, node.data.prompt].filter(Boolean).join('\n')
      if (!prompt) throw new Error('请输入图像提示词或连接上游文本节点')
      return { output: { asset: { kind: 'image', remoteUrl: `mock://image?prompt=${encodeURIComponent(prompt.slice(0, 64))}` } }, costQuota: 0 }
    },
    video: async (node, inputs, signal) => {
      await wait(signal)
      const prompt = [inputs.text, node.data.prompt].filter(Boolean).join('\n')
      if (!prompt && !inputs.image) throw new Error('请输入视频提示词或连接上游图像节点')
      return { output: { asset: { kind: 'video', remoteUrl: 'mock://video', taskId: `mock-${node.id}` } }, costQuota: 0 }
    },
  }
}
