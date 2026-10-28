import { describe, expect, it } from 'vitest'
import { colorGradeDetailWorkflowFixture } from '../lib/color-detail.test-fixture'
import { parseWorkflowFileDetailed, serializeWorkflow } from './workflow-serializer'
import { parseXingCanvasProject, serializeXingCanvasProject } from './project-package'

function rawWorkflow() { return JSON.parse(serializeWorkflow(colorGradeDetailWorkflowFixture())) }
describe('detail persistence is lossless and placement strict', () => {
  it('retains disabled zero detail and latent edit parameters in current raw workflow', () => {
    const original = colorGradeDetailWorkflowFixture(), parsed = parseWorkflowFileDetailed(serializeWorkflow(original))!
    expect(parsed.workflow.nodes[0].data.settings?.imageTransform).toEqual(original.nodes[0].data.settings?.imageTransform)
    expect(serializeWorkflow(parsed.workflow)).toBe(serializeWorkflow(original))
  })
  it.each(['flat-null', 'flat-future', 'wrong-kind', 'mixed-flat', 'mixed-kind'])('rejects %s in both actual reader and serializer rather than dropping editable detail', (placement) => {
    const raw = rawWorkflow()
    if (placement.startsWith('mixed')) { raw.nodes.push(structuredClone(raw.nodes[0])); raw.nodes[1].id = 'invalid' }
    const node = raw.nodes.at(-1)
    if (placement.endsWith('kind')) node.kind = 'note'
    else { node.data.imageTransform = node.data.settings.imageTransform; delete node.data.settings.imageTransform }
    if (placement === 'flat-null') node.data.imageTransform.layers[0].colorGrade.detail = null
    if (placement === 'flat-future') node.data.imageTransform.layers[0].colorGrade.detail = { version: 2 }
    expect(parseWorkflowFileDetailed(JSON.stringify(raw))).toBeNull()
    expect(() => serializeWorkflow(raw)).toThrow('细节与降噪')
  })
  it.each([null, false, 0, { version: 2 }])('explicitly rejects detail %j under the legacy project1 carrier', (detail) => {
    const raw = rawWorkflow(); raw.nodes[0].data.settings.imageTransform.layers[0].colorGrade.detail = detail
    expect(() => parseXingCanvasProject(JSON.stringify({ format: 'xingmang-canvas-project', packageVersion: 1, createdAt: '2026-10-18T00:00:00.000Z', workflow: raw, licenses: [] }))).toThrow('第 1 版项目包不能包含')
    expect(() => serializeXingCanvasProject(raw)).toThrow('第 5 版')
  })
})
