import { defaultImageLayerColorDetail } from '../image-tools/layer-color-detail'
import { createEmptyWorkflow, type WorkflowFile } from '../model'
import { colorGradeRecipeFixture } from './color-grade.test-fixture'

export function colorGradeDetailRecipeFixture() {
  const recipe = colorGradeRecipeFixture(), detail = defaultImageLayerColorDetail()
  detail.enabled = false
  detail.sharpening = { amount: 0, radius: 2.3, detail: 67, masking: 81 }
  detail.luminance = { amount: 0, detail: 71, contrast: 32 }
  detail.color = { amount: 0, detail: 64, smoothness: 83 }
  recipe.layers[0].colorGrade!.detail = detail
  return recipe
}

export function colorGradeDetailWorkflowFixture(): WorkflowFile {
  return { ...createEmptyWorkflow('细节与降噪工程'), nodes: [{ id: 'grade', kind: 'image-layer', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'idle', settings: { imageTransform: colorGradeDetailRecipeFixture() } } }] }
}
