import type { WorkflowFile } from '../model'
import { parseWorkflowFileDetailed, serializeWorkflow } from './workflow-serializer'
import { maximumWorkflowBytes } from './workflow-schema'

export const xingCanvasPackageVersion = 1 as const
export const xingCanvasExtension = '.xingcanvas'
const maximumPackageBytes = maximumWorkflowBytes + 256 * 1024
const maximumLicenseNotices = 64
const maximumNoticeLength = 8_000

export interface XingCanvasPackage {
  packageVersion: typeof xingCanvasPackageVersion
  format: 'xingmang-canvas-project'
  createdAt: string
  workflow: unknown
  licenses: Array<{ name: string; license: string; notice?: string }>
}

export interface ParsedXingCanvasPackage {
  workflow: WorkflowFile
  warnings: string[]
  licenses: XingCanvasPackage['licenses']
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function safeLicense(value: unknown): XingCanvasPackage['licenses'][number] | null {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.license !== 'string') return null
  if (!value.name || value.name.length > 256 || !value.license || value.license.length > 128) return null
  if (value.notice !== undefined && (typeof value.notice !== 'string' || value.notice.length > maximumNoticeLength)) return null
  return { name: value.name, license: value.license, ...(typeof value.notice === 'string' ? { notice: value.notice } : {}) }
}

export function serializeXingCanvasProject(
  workflow: WorkflowFile,
  options: { createdAt?: string; licenses?: XingCanvasPackage['licenses'] } = {},
): string {
  const licenses = (options.licenses ?? []).slice(0, maximumLicenseNotices).map((entry) => safeLicense(entry))
  if (licenses.some((entry) => entry === null)) throw new Error('项目许可证信息格式错误')
  const project: XingCanvasPackage = {
    packageVersion: xingCanvasPackageVersion,
    format: 'xingmang-canvas-project',
    createdAt: options.createdAt ?? new Date().toISOString(),
    workflow: JSON.parse(serializeWorkflow(workflow)),
    licenses: licenses as XingCanvasPackage['licenses'],
  }
  const content = JSON.stringify(project, null, 2)
  if (content.length > maximumPackageBytes) throw new Error('项目文件超过安全上限')
  return content
}

export function parseXingCanvasProject(content: string): ParsedXingCanvasPackage | null {
  if (typeof content !== 'string' || content.length === 0 || content.length > maximumPackageBytes) return null
  let raw: unknown
  try { raw = JSON.parse(content) } catch { return null }
  if (!isRecord(raw) || raw.packageVersion !== xingCanvasPackageVersion || raw.format !== 'xingmang-canvas-project') return null
  if (typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt))) return null
  if (!Array.isArray(raw.licenses) || raw.licenses.length > maximumLicenseNotices) return null
  const licenses = raw.licenses.map(safeLicense)
  if (licenses.some((entry) => entry === null)) return null
  const parsed = parseWorkflowFileDetailed(JSON.stringify(raw.workflow))
  if (!parsed) return null
  return { workflow: parsed.workflow, warnings: parsed.warnings, licenses: licenses as XingCanvasPackage['licenses'] }
}
