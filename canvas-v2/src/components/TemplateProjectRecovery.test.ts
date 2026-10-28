import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createEmptyWorkflow, serializeWorkflow } from '../model'
import type { SavedTemplateProjectSubmission } from '../templates/template-project-creation'
import { TemplateProjectRecovery } from './TemplateProjectRecovery'

function submission(): SavedTemplateProjectSubmission {
  const workflow = createEmptyWorkflow('原工程 <安全纯文本>')
  workflow.nodes = [{ id: 'original-node', kind: 'note', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'idle', settings: { text: '不会在预览中展示的完整原始内容' } } }]
  return { version: 1, ownerId: 123, operationId: '11111111-1111-4111-8111-111111111111', templateId: 'xingmang-drama-script-parse', signature: 'original-configuration', content: serializeWorkflow(workflow) }
}

describe('template project recovery dialog', () => {
  it('shows original workflow facts and explicit recovery actions without issuing requests', () => {
    const onRetry = vi.fn()
    const onExport = vi.fn()
    const onClose = vi.fn()
    const html = renderToStaticMarkup(createElement(TemplateProjectRecovery, { submission: submission(), busy: false, error: '原创建结果未确认', onRetry, onExport, onClose }))
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('已保留原配置与完整工作流')
    expect(html).toContain('原工程 &lt;安全纯文本&gt;')
    expect(html).toContain('1 个节点、0 条连线')
    expect(html).toContain('核对原创建')
    expect(html).toContain('导出工作流')
    expect(html).toContain('暂时返回')
    expect(html).toContain('role="alert"')
    expect(html).not.toContain('不会在预览中展示的完整原始内容')
    expect(onRetry).not.toHaveBeenCalled()
    expect(onExport).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('disables all actions during a pending creation check including closing the dialog', () => {
    const html = renderToStaticMarkup(createElement(TemplateProjectRecovery, { submission: submission(), busy: true, error: null, onRetry() {}, onExport() {}, onClose() {} }))
    expect(html).toContain('aria-busy="true"')
    expect(html.match(/disabled=""/g)).toHaveLength(3)
    expect(html).toContain('role="status"')
    expect(html).not.toContain('role="alert"')
  })
})
