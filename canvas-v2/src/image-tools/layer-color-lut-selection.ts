import { layerColorLutPresets } from './layer-color-lut-presets'
import { maximumColorLutNameLength } from './layer-color-lut'

export type ColorLutDomain = [number, number, number]

export interface BuiltinColorLutSource {
  kind: 'builtin'
  presetId: string
}

export interface AssetColorLutSource {
  kind: 'asset'
  lutAssetId: string
  digest: string
  name: string
  domainMin: ColorLutDomain
  domainMax: ColorLutDomain
}

export type ColorLutSource = BuiltinColorLutSource | AssetColorLutSource

/** Only immutable resource references belong in a project. The 33³ float
 * table is an owned asset; repeating it for every layer would exceed the
 * project's database limit before a twenty-layer document could be saved. */
export interface ColorLutSelection {
  version: 1
  enabled: boolean
  strength: number
  source: ColorLutSource
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('LUT 设置包含不支持的字段或格式')
  return value as Record<string, unknown>
}

function domain(value: unknown): ColorLutDomain {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((entry) => typeof entry === 'number' && Number.isFinite(entry) && entry >= -16 && entry <= 16)) throw new Error('LUT 输入范围需要三个 −16 至 16 的有限数值')
  return [value[0], value[1], value[2]]
}

export function parseColorLutSource(value: unknown): ColorLutSource {
  const raw = object(value, ['kind', 'presetId', 'lutAssetId', 'digest', 'name', 'domainMin', 'domainMax'])
  if (raw.kind === 'builtin') {
    object(raw, ['kind', 'presetId'])
    if (typeof raw.presetId !== 'string' || !layerColorLutPresets.some((preset) => preset.id === raw.presetId && preset.version === 1)) throw new Error('此内置 LUT 预设版本不受支持，请更新页面后重试')
    return { kind: 'builtin', presetId: raw.presetId }
  }
  if (raw.kind !== 'asset') throw new Error('LUT 来源必须是内置预设或账户调色表')
  object(raw, ['kind', 'lutAssetId', 'digest', 'name', 'domainMin', 'domainMax'])
  if (typeof raw.lutAssetId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw.lutAssetId) || typeof raw.digest !== 'string' || !/^[0-9a-f]{64}$/.test(raw.digest)) throw new Error('LUT 素材编号或文件摘要无效，请重新载入')
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name !== raw.name.trim() || raw.name.length > maximumColorLutNameLength || /[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(raw.name)) throw new Error('LUT 名称需要 1–160 个字符，不能包含控制字符')
  const domainMin = domain(raw.domainMin), domainMax = domain(raw.domainMax)
  if (domainMin.some((entry, index) => entry >= domainMax[index])) throw new Error('LUT 每个通道的输入下限必须小于上限')
  return { kind: 'asset', lutAssetId: raw.lutAssetId, digest: raw.digest, name: raw.name, domainMin, domainMax }
}

export function parseColorLutSelection(value: unknown): ColorLutSelection {
  const raw = object(value, ['version', 'enabled', 'strength', 'source'])
  if (raw.version !== 1) throw new Error('LUT 设置版本不受支持，请更新页面后重试')
  if (typeof raw.enabled !== 'boolean' || typeof raw.strength !== 'number' || !Number.isFinite(raw.strength) || raw.strength < 0 || raw.strength > 100) throw new Error('LUT 需要有效的应用开关和 0–100 的强度')
  return { version: 1, enabled: raw.enabled, strength: raw.strength, source: parseColorLutSource(raw.source) }
}

export function colorLutSourceKey(value: ColorLutSource): string {
  const source = parseColorLutSource(value)
  return source.kind === 'builtin' ? source.presetId : `${source.lutAssetId}:${source.digest}`
}

export function colorLutSelectionIsActive(value: ColorLutSelection | undefined): boolean {
  if (value === undefined) return false
  const selection = parseColorLutSelection(value)
  return selection.enabled && selection.strength > 0
}

/** The source is retained even when disabled or at zero strength. Those are
 * editable settings, not a request to discard a user's uploaded resource. */
export function buildColorLutSelection(source: ColorLutSource, previous?: ColorLutSelection): ColorLutSelection {
  const old = previous === undefined ? undefined : parseColorLutSelection(previous)
  return parseColorLutSelection({ version: 1, enabled: true, strength: old?.strength ?? 100, source })
}
