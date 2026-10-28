import { buildCommerceWorkflow } from '../commerce/commerce-workflow'
import { defaultCommerceTask, type CommerceTaskKind } from '../commerce/commerce-task'
import type { WorkflowFile } from '../model'

export function imageTaskWorkflowFixture(kind: CommerceTaskKind = 'style-reference', analysis = false): WorkflowFile {
  let id = 0
  return buildCommerceWorkflow({ tasks: [defaultCommerceTask(kind)], source: { assetId: 'a'.repeat(43), width: 512, height: 512 }, ...(kind === 'style-reference' ? { reference: { assetId: 'b'.repeat(43), width: 512, height: 512 } } : {}), prompt: '原创商品测试', model: 'gpt-image-1', size: '1024x1024', quality: 'low', candidateCount: 1, ...(analysis ? { analysis: { model: 'gpt-4.1-mini', prompt: '分析原图结构和参考图的风格，不编造商品信息。' } } : {}), createId: () => `commerce-${++id}` })
}
