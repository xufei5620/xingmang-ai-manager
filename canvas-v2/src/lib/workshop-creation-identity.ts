import { WorkshopError } from './workshop-sanitizer'

export interface WorkshopCreationIdentity { operationId: string; kind: 'node' | 'group'; requestDigest: string }

export function parseWorkshopCreationIdentity(value: unknown): WorkshopCreationIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkshopError('原保存操作身份不完整')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !['operationId', 'kind', 'requestDigest'].includes(key)) || typeof input.operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.operationId) || (input.kind !== 'node' && input.kind !== 'group') || typeof input.requestDigest !== 'string' || !/^[0-9a-f]{64}$/.test(input.requestDigest)) throw new WorkshopError('原保存操作身份不正确')
  return { operationId: input.operationId.toLowerCase(), kind: input.kind as 'node' | 'group', requestDigest: input.requestDigest }
}

export function assertWorkshopCreationIdentity(actual: WorkshopCreationIdentity, expected: WorkshopCreationIdentity): void {
  const a = parseWorkshopCreationIdentity(actual), b = parseWorkshopCreationIdentity(expected)
  if (a.operationId !== b.operationId || a.kind !== b.kind || a.requestDigest !== b.requestDigest) throw new WorkshopError('保存操作回执与原编号或摘要不一致，请保留原记录并重新核对', 409)
}

