import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createEmptyWorkflow, serializeWorkflow, type WorkflowNode } from '../model'
import { ProjectHistoryGraph, ProjectHistoryDialog } from '../components/ProjectHistoryDialog'
import { CanvasNodeRenameDialog } from '../components/CanvasNodeRenameDialog'
import type { CanvasHostBridge } from '../host'
import { buildProjectHistoryPreview } from './project-history-preview'
import type { CanvasProjectRevisionDetail } from '../lib/project-history-contract'

function node(id: string, kind: WorkflowNode['kind'], x: number, y: number, parentId?: string): WorkflowNode {
  return { id, kind, position: { x, y }, parentId, data: { prompt: '', model: '', status: 'idle', settings: { title: id } } }
}
const workflow = { ...createEmptyWorkflow('包装设计'), nodes: [node('根编组', 'group', 100, -20), node('并行 A', 'prompt', 20, 100, '根编组'), node('并行 B', 'prompt', 20, 420, '根编组'), node('输出', 'output', 800, 250)], edges: [
  { id: 'a', source: '并行 A', target: '输出', sourceHandle: 'out:text', targetHandle: 'in:text' },
  { id: 'b', source: '并行 B', target: '输出', sourceHandle: 'out:text', targetHandle: 'in:text' },
] }
const detail: CanvasProjectRevisionDetail = { revision: { id: 'a'.repeat(32), projectId: 'project', projectVersion: 3, kind: 'save', savedAt: '2026-10-14T00:00:00Z', nodeCount: 4, edgeCount: 2, assetCount: 0 }, content: serializeWorkflow(workflow), missingAssets: [], canRestore: true, projectProvenance: [] }

describe('project history graph preview', () => {
  it('uses saved coordinates and group offsets without collapsing parallel branches into a row', () => {
    const preview = buildProjectHistoryPreview(workflow)
    expect(preview.nodes.find((entry) => entry.id === '并行 A')).toMatchObject({ x: 120, y: 80 })
    expect(preview.nodes.find((entry) => entry.id === '并行 B')).toMatchObject({ x: 120, y: 400 })
    expect(preview.edges).toHaveLength(2)
    expect(preview.nodes[0].group).toBe(true)
    expect(workflow.nodes[1].position).toEqual({ x: 20, y: 100 })
  })
  it('handles cyclic legacy groups and bounds rendered nodes without changing the full graph', () => {
    const malformed = { ...createEmptyWorkflow('legacy'), nodes: [node('a', 'group', 1, 2, 'b'), node('b', 'group', 3, 4, 'a')] }
    expect(buildProjectHistoryPreview(malformed).nodes).toHaveLength(2)
    const large = { ...createEmptyWorkflow('large'), nodes: Array.from({ length: 2001 }, (_, index) => node(String(index), 'prompt', index, index)) }
    const preview = buildProjectHistoryPreview(large)
    expect(preview.nodes).toHaveLength(2000)
    expect(preview.truncated).toBe(true)
    expect(large.nodes).toHaveLength(2001)
  })
  it('renders an accessible real graph with actual node and edge totals', () => {
    const html = renderToStaticMarkup(createElement(ProjectHistoryGraph, { detail }))
    expect(html).toContain('版本 3 的真实画布结构，4 个节点、2 条连线')
    expect(html).toContain('transform="translate(120 80)"')
    expect(html).toContain('transform="translate(120 400)"')
    expect(html).toContain('按保存时布局预览')
  })
  it('keeps unknown outcomes actionable while clearly distinguishing version history from run history', () => {
    const html = renderToStaticMarkup(createElement(ProjectHistoryDialog, { projectId: 'project', name: '包装设计', cloudVersion: 8, bridge: {} as CanvasHostBridge, busy: false, error: '请求回执丢失', pendingRevisionId: detail.revision.id, pendingState: 'unknown', onRestore() {}, onRetry() {}, onReload() {}, onClose() {} }))
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('核对原恢复操作')
    expect(html).toContain('保留本地草稿并读取云端')
    expect(html).toContain('自动保存已暂停')
    expect(html).not.toContain('运行历史')
  })
  it('shows an explicit same-operation retry only for a confirmed missing result', () => {
    const html = renderToStaticMarkup(createElement(ProjectHistoryDialog, { projectId: 'project', name: '包装设计', cloudVersion: 8, bridge: {} as CanvasHostBridge, busy: false, error: null, pendingRevisionId: detail.revision.id, pendingOperationId: '33333333-3333-4333-8333-333333333333', pendingState: 'missing', onRestore() {}, onRetry() {}, onRetryMissing() {}, onReload() {}, onClose() {} }))
    expect(html).toContain('服务器未找到原恢复操作')
    expect(html).toContain('按原编号重试恢复')
    expect(html).toContain('33333333-3333-4333-8333-333333333333')
    expect(html).toContain('刷新和核对只读取原结果，不会重新提交')
  })
  it.each(['completed', 'changed'] as const)('does not expose a write retry for a known %s receipt', (state) => {
    const html = renderToStaticMarkup(createElement(ProjectHistoryDialog, { projectId: 'project', name: '包装设计', cloudVersion: 9, bridge: {} as CanvasHostBridge, busy: false, error: null, pendingRevisionId: detail.revision.id, pendingState: state, onRestore() {}, onRetry() {}, onRetryMissing() {}, onReload() {}, onClose() {} }))
    expect(html).not.toContain('按原编号重试恢复')
    expect(html).toContain('保留本地草稿并读取云端，结束核对')
    expect(html).toContain(state === 'completed' ? '核对并载入已恢复版本' : '恢复已提交，工程随后又有更新')
  })
  it('labels node renaming as node settings instead of personal workshop content', () => {
    const html = renderToStaticMarkup(createElement(CanvasNodeRenameDialog, { name: '产品图', onConfirm() {}, onClose() {} }))
    expect(html).toContain('节点设置')
    expect(html).not.toContain('我的创意工坊')
    expect(html).toContain('aria-label="关闭节点设置窗口"')
  })
})
