import { describe, expect, it, vi } from 'vitest'
import type { CanvasAgentDraft } from './canvas-agent-panel-state'
import { readCanvasAgentDraft, writeCanvasAgentDraft } from './canvas-agent-panel-state'
import { verifyAgentMcpContext } from './canvas-agent-mcp-context'
import { canvasMcpToolSchemaDigest } from '../lib/canvas-mcp-contract'

const scope = { ownerId: 'owner', projectId: 'project' }, key = 'xingmang.canvas.agent.v6.owner.project.session'
const reference = { connectionId: 'connection', connectionVersion: 2, toolName: 'research', toolSchemaDigest: 'a'.repeat(64) }
const result = { callId: 'call', resultDigest: 'b'.repeat(64) }
function memory() { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } } }
function draft(): CanvasAgentDraft {
  return { text: '创作', selectedNodeIds: [], model: 'text', mcpToolReferences: [reference], mcpResultReferences: [result], pending: { kind: 'start', input: { operationId: '11111111-1111-4111-8111-111111111111', projectId: 'project', sessionId: 'session', expectedSessionVersion: 1, baseProjectVersion: 1, selectedNodeIds: [], providerId: 'provider', model: 'text', prompt: '创作', mcpToolReferences: [reference], mcpResultReferences: [result] } } }
}
describe('MCP draft and request boundaries', () => {
  it('keeps selector-only context and pending identity across reload and older-page writes', () => {
    const storage = memory(), original = draft()
    expect(writeCanvasAgentDraft(scope, 'session', original, storage)).toBe(true)
    expect(readCanvasAgentDraft(scope, 'session', storage)).toEqual(original)
    for (const version of [1, 2, 3, 4, 5]) {
      const oldKey = key.replace('.v6.', `.v${version}.`)
      expect(JSON.parse(storage.getItem(oldKey)!)).toEqual({ version: 6 })
      storage.setItem(oldKey, JSON.stringify({ version, text: '迟到写入', selectedNodeIds: [], model: '' }))
    }
    expect(readCanvasAgentDraft(scope, 'session', storage)).toEqual(original)
    expect(readCanvasAgentDraft({ ...scope, ownerId: 'other' }, 'session', storage).mcpToolReferences).toBeUndefined()
    expect(storage.getItem(key)).not.toMatch(/inputSchema|connectionUrl|Bearer|structuredContent/)
  })
  it('migrates version-three skills without dropping pending context', () => {
    const storage = memory(), original = { text: '旧草稿', selectedNodeIds: [], model: 'text', skillReferences: [{ skillId: 'skill', version: 1, contentDigest: 'c'.repeat(64), resourcePaths: [] }] }
    storage.setItem(key.replace('.v6.', '.v3.'), JSON.stringify({ version: 3, ...original }))
    const loaded = readCanvasAgentDraft(scope, 'session', storage)
    expect(loaded).toEqual({ ...original, pending: undefined })
    expect(writeCanvasAgentDraft(scope, 'session', loaded, storage)).toBe(true)
    expect(readCanvasAgentDraft(scope, 'session', storage)).toEqual(loaded)
  })
  it('blocks malformed pending references rather than retrying a context-free replacement', () => {
    const storage = memory(), original = draft()
    if (original.pending?.kind !== 'start') throw Error('fixture')
    storage.setItem(key, JSON.stringify({ version: 6, ...original, pending: { kind: 'start', input: { ...original.pending.input, mcpToolReferences: [{ ...reference, connectionVersion: 0 }] } } }))
    const loaded = readCanvasAgentDraft(scope, 'session', storage)
    expect(loaded.pending).toBeUndefined(); expect(loaded.pendingMcpError).toContain('不能作为新请求重发')
    expect(writeCanvasAgentDraft(scope, 'session', loaded, storage)).toBe(true)
    expect(readCanvasAgentDraft(scope, 'session', storage).pendingMcpError).toBeTruthy()
  })
  it('rejects stale or switched-account previews before the send can reserve a new operation', async () => {
    const tool = { name: 'research', inputSchema: { type: 'object' }, schemaSupported: true, toolSchemaDigest: '' }
    tool.toolSchemaDigest = await canvasMcpToolSchemaDigest(tool)
    const selector = { ...reference, toolSchemaDigest: tool.toolSchemaDigest }, snapshot = { ...selector, connectionName: '研究连接', connectionUrl: 'https://tools.example.com/mcp', tool }
    const request = vi.fn().mockResolvedValue({ ...snapshot, connectionVersion: 3 })
    await expect(verifyAgentMcpContext({ active: () => true, request }, [selector], [])).rejects.toThrow('变化')
    let active = true
    request.mockImplementation(async () => { active = false; return snapshot })
    await expect(verifyAgentMcpContext({ active: () => active, request }, [selector], [])).rejects.toThrow('账号已切换')
    await expect(verifyAgentMcpContext(undefined, [selector], [])).rejects.toThrow('暂不可用')
  })
})
