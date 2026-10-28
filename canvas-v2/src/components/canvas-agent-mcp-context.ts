import { canvasAgentMcpToolKey, parseCanvasAgentMcpResults, parseCanvasAgentMcpTools, validateCanvasAgentMcpSnapshots } from '../lib/canvas-agent-mcp-context'
import type { CanvasMcpClient, CanvasMcpResultReference, CanvasMcpResultSnapshot, CanvasMcpToolReference, CanvasMcpToolSnapshot } from '../lib/canvas-mcp-contract'

export function parseAgentDraftMcpTools(value: unknown): CanvasMcpToolReference[] { return parseCanvasAgentMcpTools(value) ?? [] }
export function parseAgentDraftMcpResults(value: unknown): CanvasMcpResultReference[] { return parseCanvasAgentMcpResults(value) ?? [] }
export function mcpToolSnapshotReference(value: CanvasMcpToolSnapshot): CanvasMcpToolReference { return { connectionId: value.connectionId, connectionVersion: value.connectionVersion, toolName: value.toolName, toolSchemaDigest: value.toolSchemaDigest } }
export function mcpResultSnapshotReference(value: CanvasMcpResultSnapshot): CanvasMcpResultReference { return { callId: value.callId, resultDigest: value.resultDigest } }
export async function verifyAgentMcpContext(client: CanvasMcpClient | undefined, tools: readonly CanvasMcpToolReference[], results: readonly CanvasMcpResultReference[], signal?: AbortSignal) {
  if (!tools.length && !results.length) return {}
  if (!client?.active()) throw new Error('MCP 连接暂不可用，请重新打开连接面板')
  const toolSnapshots: CanvasMcpToolSnapshot[] = [], resultSnapshots: CanvasMcpResultSnapshot[] = []
  for (const reference of parseAgentDraftMcpTools(tools)) {
    signal?.throwIfAborted()
    const snapshot = await client.request('previewTool', reference, signal)
    if (!client.active()) throw new Error('账号已切换，请重新选择工具')
    if (canvasAgentMcpToolKey(snapshot) !== canvasAgentMcpToolKey(reference) || snapshot.connectionVersion !== reference.connectionVersion || snapshot.toolSchemaDigest !== reference.toolSchemaDigest) throw new Error('工具配置已变化，请移除后重新选择')
    toolSnapshots.push(snapshot)
  }
  for (const reference of parseAgentDraftMcpResults(results)) {
    signal?.throwIfAborted()
    const snapshot = await client.request('previewResult', reference, signal)
    if (!client.active()) throw new Error('账号已切换，请重新选择结果')
    if (snapshot.callId !== reference.callId || snapshot.resultDigest !== reference.resultDigest) throw new Error('工具结果与原引用不一致，请重新选择')
    resultSnapshots.push(snapshot)
  }
  signal?.throwIfAborted()
  return validateCanvasAgentMcpSnapshots(toolSnapshots, resultSnapshots)
}
