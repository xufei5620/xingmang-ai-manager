import { graphHasLayerGroups } from '../lib/layer-groups-contract'
import { graphHasColorGradeCalibration } from '../lib/color-calibration-contract'
import { graphHasColorGradePresence } from '../lib/color-presence-contract'
import { graphHasColorGradeDetail } from '../lib/color-detail-contract'
import { collectWorkflowColorLutSources } from '../lib/workflow-color-lut-resources'
import type { WorkflowFile } from '../model'
import { parseWorkflowFileDetailed, serializeWorkflow } from './workflow-serializer'
import { maximumWorkflowBytes } from './workflow-schema'

export const xingCanvasPackageVersion = 1 as const
export const xingCanvasExtension = '.xingcanvas'
const maximumPackageBytes = maximumWorkflowBytes + 256 * 1024
const maximumLicenseNotices = 64
const maximumNoticeLength = 8_000
const maximumEmbeddedAssets = 64

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
  embeddedAssetCount: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function safeLicense(value: unknown): XingCanvasPackage['licenses'][number] | null {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.license !== 'string') return null
  if (!hasOnlyKeys(value, ['name', 'license', 'notice'])) return null
  if (!value.name || value.name.length > 256 || value.name.includes('\0') || !value.license || value.license.length > 128 || value.license.includes('\0')) return null
  if (value.notice !== undefined && (typeof value.notice !== 'string' || value.notice.length > maximumNoticeLength || value.notice.includes('\0'))) return null
  return { name: value.name, license: value.license, ...(typeof value.notice === 'string' ? { notice: value.notice } : {}) }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function utf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength }

function validCreatedAt(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && !value.includes('\0') && Number.isFinite(Date.parse(value))
}

/** Embedded bytes are never decoded, trusted as media, or uploaded by this reader. */
function embeddedAssetCount(value: unknown): number | null {
  if (!Array.isArray(value) || value.length > maximumEmbeddedAssets) return null
  const ids = new Set<string>()
  for (const asset of value) {
    if (!isRecord(asset) || !hasOnlyKeys(asset, ['assetId', 'mimeType', 'bytesBase64', 'sha256'])) return null
    if (typeof asset.assetId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(asset.assetId) || ids.has(asset.assetId)) return null
    if (typeof asset.mimeType !== 'string' || !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType)) return null
    if (typeof asset.bytesBase64 !== 'string' || !asset.bytesBase64.length || asset.bytesBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(asset.bytesBase64)) return null
    if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)) return null
    ids.add(asset.assetId)
  }
  return value.length
}

export function serializeXingCanvasProject(
  workflow: WorkflowFile,
  options: { createdAt?: string; licenses?: XingCanvasPackage['licenses'] } = {},
): string {
  if (graphHasLayerGroups(workflow)) throw new Error('含持久图层编组的工程请使用第 8 版完整便携项目包，不能写入第 1 版载体')
  if (graphHasColorGradeCalibration(workflow)) throw new Error('含 RGB 原色校准的工程请使用第 7 版完整便携项目包，不能写入第 1 版载体')
  if (graphHasColorGradePresence(workflow)) throw new Error('含纹理、清晰度与去雾的工程请使用第 6 版完整便携项目包，不能写入第 1 版载体')
  if (graphHasColorGradeDetail(workflow)) throw new Error('含细节与降噪的工程请使用第 5 版完整便携项目包，不能写入第 1 版载体')
  if (collectWorkflowColorLutSources(workflow).length) throw new Error('含自定义 LUT 的工程请使用便携项目包携带完整调色表')
  const createdAt = options.createdAt ?? new Date().toISOString()
  if (!validCreatedAt(createdAt)) throw new Error('项目文件时间格式错误')
  if ((options.licenses ?? []).length > maximumLicenseNotices) throw new Error('项目许可证信息数量超过安全上限')
  const licenses = (options.licenses ?? []).map((entry) => safeLicense(entry))
  if (licenses.some((entry) => entry === null)) throw new Error('项目许可证信息格式错误')
  const project: XingCanvasPackage = {
    packageVersion: xingCanvasPackageVersion,
    format: 'xingmang-canvas-project',
    createdAt,
    workflow: JSON.parse(serializeWorkflow(workflow)),
    licenses: licenses as XingCanvasPackage['licenses'],
  }
  const content = JSON.stringify(project, null, 2)
  if (utf8Bytes(content) > maximumPackageBytes) throw new Error('项目文件超过安全上限')
  return content
}

export function parseXingCanvasProject(content: string): ParsedXingCanvasPackage | null {
  if (typeof content !== 'string' || content.length === 0 || content.length > maximumPackageBytes || utf8Bytes(content) > maximumPackageBytes) return null
  let raw: unknown
  try { raw = JSON.parse(content) } catch { return null }
  if (!isRecord(raw) || raw.packageVersion !== xingCanvasPackageVersion || raw.format !== 'xingmang-canvas-project') return null
  if (graphHasLayerGroups(raw.workflow)) throw new Error('第 1 版项目包不能包含持久图层编组，请重新导出第 8 版便携项目包')
  if (graphHasColorGradeCalibration(raw.workflow)) throw new Error('第 1 版项目包不能包含 RGB 原色校准，请重新导出第 7 版便携项目包')
  if (graphHasColorGradePresence(raw.workflow)) throw new Error('第 1 版项目包不能包含纹理、清晰度与去雾，请重新导出第 6 版便携项目包')
  if (graphHasColorGradeDetail(raw.workflow)) throw new Error('第 1 版项目包不能包含细节与降噪，请重新导出第 5 版便携项目包')
  if (!validCreatedAt(raw.createdAt)) return null
  const desktopPackage = Object.prototype.hasOwnProperty.call(raw, 'assets') || Object.prototype.hasOwnProperty.call(raw, 'provenance')
  if (!hasOnlyKeys(raw, desktopPackage ? ['format', 'packageVersion', 'createdAt', 'workflow', 'assets', 'provenance'] : ['format', 'packageVersion', 'createdAt', 'workflow', 'licenses'])) return null
  const notices = desktopPackage ? raw.provenance : raw.licenses
  if (!Array.isArray(notices) || notices.length > maximumLicenseNotices) return null
  if (desktopPackage && notices.some((notice) => !isRecord(notice) || !hasOnlyKeys(notice, ['name', 'license']))) return null
  const licenses = notices.map(safeLicense)
  if (licenses.some((entry) => entry === null)) return null
  const count = desktopPackage ? embeddedAssetCount(raw.assets) : 0
  if (count === null) return null
  const parsed = parseWorkflowFileDetailed(JSON.stringify(raw.workflow))
  if (!parsed) return null
  return {
    workflow: parsed.workflow,
    warnings: [...parsed.warnings, ...(count ? [`项目包内有 ${count} 张嵌入图片，当前仅读取工作流，不会复制这些图片；请单独导入图片并重新选择素材。`] : [])],
    licenses: licenses as XingCanvasPackage['licenses'],
    embeddedAssetCount: count,
  }
}
