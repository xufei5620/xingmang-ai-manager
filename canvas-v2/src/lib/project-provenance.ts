export interface ProjectProvenance { name: string; license: string; notice?: string }
export const maximumProjectProvenanceBytes = 64 * 1024

export class ProjectProvenanceError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

function text(value: unknown, maximum: number): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !value.includes('\0') }

/** Source declarations are preserved as supplied, never inferred as a license grant. */
export function parseProjectProvenance(value: unknown): ProjectProvenance[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 64) throw new ProjectProvenanceError('项目来源清单格式不正确，最多保留 64 项来源声明')
  const result = value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new ProjectProvenanceError('项目来源信息格式不正确')
    const fields = entry as Record<string, unknown>
    if (Object.keys(fields).some((key) => !['name', 'license', 'notice'].includes(key)) || !text(fields.name, 256) || !text(fields.license, 128) || fields.notice !== undefined && (typeof fields.notice !== 'string' || fields.notice.length > 8000 || fields.notice.includes('\0'))) throw new ProjectProvenanceError('项目来源名称、许可声明或附注不符合长度及字段限制')
    return { name: fields.name, license: fields.license, ...(typeof fields.notice === 'string' ? { notice: fields.notice } : {}) }
  })
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > maximumProjectProvenanceBytes) throw new ProjectProvenanceError('项目来源清单不能超过 64 KB，请保留完整离线来源档案并减少本项目附注')
  return result
}

export function serializeProjectProvenance(value: unknown): string | null {
  const parsed = parseProjectProvenance(value)
  return parsed.length ? JSON.stringify(parsed) : null
}

export function readStoredProjectProvenance(value: unknown): ProjectProvenance[] {
  if (value === null || value === undefined) return []
  try {
    if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > maximumProjectProvenanceBytes) throw new Error('Invalid stored declaration')
    return parseProjectProvenance(JSON.parse(value))
  } catch { throw new ProjectProvenanceError('工程来源信息暂不可读取，请保留当前内容并核对原导入文件', 503) }
}

/** Omitting empty provenance keeps the pre-v14 operation digest byte-for-byte stable. */
export function projectProvenanceDigestFields(value: readonly ProjectProvenance[]): { packageProvenance?: ProjectProvenance[] } {
  const parsed = parseProjectProvenance(value)
  return parsed.length ? { packageProvenance: parsed } : {}
}
