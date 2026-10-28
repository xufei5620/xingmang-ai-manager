// 工坊配置的来源方式（可移植 / 仅本人固定来源）和按方式清理工作流，画布内核和网页都用；查本人来源的服务端核对留在 workshop-private-sources（#3）。
import { graphHasNodeMediaSource } from './node-model-source-contract'
import type { WorkflowFile } from '../model'
import type { WorkshopSourcePolicy } from './workshop-contract'
import { sanitizeOwnerPrivateWorkshopWorkflow, sanitizeWorkshopWorkflow, WorkshopError } from './workshop-sanitizer'

export function parseWorkshopSourcePolicy(value: unknown): WorkshopSourcePolicy {
  if (value === undefined || value === 'portable') return 'portable'
  if (value === 'owner-private') return value
  throw new WorkshopError('请选择可移植配置或仅本人固定来源')
}

export function workshopWorkflowSourcePolicy(value: unknown): WorkshopSourcePolicy {
  return graphHasNodeMediaSource(value) ? 'owner-private' : 'portable'
}

export function sanitizeWorkshopWorkflowForPolicy(value: unknown, kind: 'node' | 'group', name: string, policy: WorkshopSourcePolicy): WorkflowFile {
  return policy === 'owner-private' ? sanitizeOwnerPrivateWorkshopWorkflow(value, kind, name) : sanitizeWorkshopWorkflow(value, kind, name)
}
