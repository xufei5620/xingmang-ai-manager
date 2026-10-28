import { parseImageLayerColorGrade, type ImageLayerColorGrade } from '../image-tools/layer-color-grade'
import { parseColorGradePreset } from '../image-tools/layer-color-grade-editor-state'
import { parseColorLutSelection, type AssetColorLutSource } from '../image-tools/layer-color-lut-selection'
import type { ColorLutTable, ColorLutWorkOptions } from '../image-tools/layer-color-lut'
import { checkColorLutResourceWork, describeColorLutResource, parseColorLutResource, parseColorLutResourceDescriptor, serializeColorLutResource, type ColorLutResourceContentDescriptor, type ColorLutResourceDescriptor } from './color-lut-resource-contract'

export const maximumColorGradePresetTransferBytes = 768 * 1024
export type ReadColorGradePresetResource = (source: AssetColorLutSource, signal: AbortSignal) => Promise<{ descriptor: ColorLutResourceDescriptor; table: ColorLutTable }>
export type UploadColorGradePresetResource = (table: ColorLutTable, signal: AbortSignal) => Promise<ColorLutResourceDescriptor>
export interface ColorGradePresetTransfer { name: string; settings: ImageLayerColorGrade }

interface TransferWork {
  options: ColorLutWorkOptions & { signal: AbortSignal }
  check(): void
  wait<T>(operation: () => Promise<T>): Promise<T>
  dispose(): void
}
function fail(message: string): never { throw new Error(`调整预设${message}；当前调整未改变`) }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('格式不完整')
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).length !== keys.length || Object.keys(raw).some((key) => !keys.includes(key))) fail('包含缺失或不支持的字段')
  return raw
}
function title(value: unknown): string {
  if (typeof value !== 'string') fail('名称无效')
  const name = value.trim()
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name) || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(name)) fail('名称需要 1–80 个有效字符')
  return name
}
function bounded(text: string): void {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > maximumColorGradePresetTransferBytes) fail('不能超过 768 KiB')
}
function sameDomain(first: readonly number[], second: readonly number[]): boolean { return first.length === second.length && first.every((value, index) => value === second[index]) }
function matchSource(source: AssetColorLutSource, descriptor: ColorLutResourceContentDescriptor): void {
  if (source.digest !== descriptor.digest || source.name !== descriptor.name || !sameDomain(source.domainMin, descriptor.domainMin) || !sameDomain(source.domainMax, descriptor.domainMax)) fail('内嵌 LUT 与设置中的摘要、名称或输入域不一致')
}
function matchDescriptor(expected: ColorLutResourceContentDescriptor, value: unknown): ColorLutResourceDescriptor {
  const descriptor = parseColorLutResourceDescriptor(value)
  if (descriptor.version !== expected.version || descriptor.digest !== expected.digest || descriptor.size !== expected.size || descriptor.name !== expected.name || descriptor.byteSize !== expected.byteSize || descriptor.mimeType !== expected.mimeType || !sameDomain(descriptor.domainMin, expected.domainMin) || !sameDomain(descriptor.domainMax, expected.domainMax)) fail('素材回执与已核验的 LUT 内容不一致')
  return descriptor
}
function createWork(input: ColorLutWorkOptions): TransferWork {
  const controller = new AbortController(), options = { signal: controller.signal, deadline: input.deadline }, externalSignal = input.signal
  let timer: ReturnType<typeof setTimeout> | undefined
  function cancel() { controller.abort(new DOMException('已取消调整预设转移，当前调整保留', 'AbortError')) }
  function expire() {
    const remaining = options.deadline === undefined ? Infinity : options.deadline - Date.now()
    if (remaining > 0) { if (Number.isFinite(remaining)) timer = setTimeout(expire, Math.min(remaining, 2_147_483_647)); return }
    const error = new Error('调整预设处理超时，当前调整未改变'); error.name = 'TimeoutError'; controller.abort(error)
  }
  function check() { try { checkColorLutResourceWork(options) } catch (cause) { if (!controller.signal.aborted) controller.abort(cause); throw cause } }
  if (externalSignal?.aborted) cancel()
  check()
  externalSignal?.addEventListener('abort', cancel, { once: true })
  if (input.deadline !== undefined) expire()
  return {
    options, check,
    wait<T>(operation: () => Promise<T>): Promise<T> {
      check()
      return new Promise<T>((resolve, reject) => {
        let settled = false
        function done(callback: () => void) { if (settled) return; settled = true; controller.signal.removeEventListener('abort', abort); callback() }
        function abort() { done(() => reject(controller.signal.reason)) }
        controller.signal.addEventListener('abort', abort, { once: true })
        if (controller.signal.aborted) { abort(); return }
        try { Promise.resolve(operation()).then((value) => done(() => { try { check(); resolve(value) } catch (cause) { reject(cause) } }), (cause) => done(() => reject(cause))) }
        catch (cause) { done(() => reject(cause)) }
      })
    },
    dispose() { if (timer !== undefined) clearTimeout(timer); externalSignal?.removeEventListener('abort', cancel) },
  }
}

/** Preset files are self-contained. Projects continue storing only lightweight
 * account resource references; this envelope is never a project serializer. */
export async function buildColorGradePresetTransfer(name: string, grade: ImageLayerColorGrade, readResource: ReadColorGradePresetResource, options: ColorLutWorkOptions = {}): Promise<string> {
  const work = createWork(options)
  try {
    const settings = parseImageLayerColorGrade(grade), presetName = title(name), resources: { content: string }[] = []
    const selection = settings.lut === undefined ? undefined : parseColorLutSelection(settings.lut)
    if (selection?.source.kind === 'asset') {
      const source = selection.source
      const found = await work.wait(() => readResource({ ...source, domainMin: [...source.domainMin], domainMax: [...source.domainMax] }, work.options.signal))
      if (!found || typeof found !== 'object') fail('没有读取到完整 LUT 素材')
      const descriptor = parseColorLutResourceDescriptor(found.descriptor), bytes = serializeColorLutResource(found.table, work.options)
      const expected = await work.wait(() => describeColorLutResource(bytes, work.options))
      matchDescriptor(expected, descriptor); matchSource(source, expected)
      if (descriptor.assetId !== source.lutAssetId) fail('读取到了不同的 LUT 素材')
      resources.push({ content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) })
    }
    work.check()
    const text = JSON.stringify({ format: 'xingmang-layer-color-grade', version: Object.hasOwn(settings, 'calibration') ? 5 : Object.hasOwn(settings, 'presence') ? 4 : Object.hasOwn(settings, 'detail') ? 3 : 2, name: presetName, settings, resources })
    bounded(text); work.check()
    return text
  } finally { work.dispose() }
}

export async function importColorGradePresetTransfer(text: string, uploadResource: UploadColorGradePresetResource, options: ColorLutWorkOptions = {}): Promise<ColorGradePresetTransfer> {
  const work = createWork(options)
  try {
    bounded(text)
    let value: unknown
    try { value = JSON.parse(text) } catch { fail('不是有效的 JSON 文件') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('格式不受支持')
    const raw = value as Record<string, unknown>
    const hasCalibration = Boolean(raw.settings && typeof raw.settings === 'object' && Object.hasOwn(raw.settings, 'calibration'))
    const hasPresence = Boolean(raw.settings && typeof raw.settings === 'object' && Object.hasOwn(raw.settings, 'presence'))
    const hasDetail = Boolean(raw.settings && typeof raw.settings === 'object' && Object.hasOwn(raw.settings, 'detail'))
    if (hasCalibration && raw.version !== 5) fail('旧版文件不能包含校准，请使用版本 5 完整预设')
    if (raw.version === 5 && !hasCalibration) fail('版本 5 文件缺少校准配置')
    if (hasPresence && raw.version !== 4 && raw.version !== 5) fail('旧版文件不能包含质感与去雾，请使用版本 4 完整预设')
    if (raw.version === 4 && !hasPresence) fail('版本 4 文件缺少质感与去雾配置')
    if (hasDetail && raw.version !== 3 && raw.version !== 4 && raw.version !== 5) fail('旧版文件不能包含细节与降噪，请使用版本 3 完整预设')
    if (raw.version === 3 && !hasDetail) fail('版本 3 文件缺少细节与降噪配置')
    if (raw.version === 1) {
      if (raw.settings && typeof raw.settings === 'object' && Object.prototype.hasOwnProperty.call(raw.settings, 'lut')) fail('旧版文件不能包含 LUT 引用，请使用带完整调色表的版本 2 文件')
      const legacy = parseColorGradePreset(text)
      work.check(); return legacy
    }
    const envelope = object(value, ['format', 'version', 'name', 'settings', 'resources'])
    if (envelope.format !== 'xingmang-layer-color-grade' || (envelope.version !== 2 && envelope.version !== 3 && envelope.version !== 4 && envelope.version !== 5)) fail('格式或版本不受支持')
    const name = title(envelope.name), settings = parseImageLayerColorGrade(envelope.settings)
    if (!Array.isArray(envelope.resources) || envelope.resources.length > 1) fail('只允许一个完整 LUT 资源')
    const source = settings.lut?.source
    if (source?.kind !== 'asset') {
      if (envelope.resources.length) fail('包含与设置无关的多余 LUT 资源')
      work.check(); return { name, settings }
    }
    if (envelope.resources.length !== 1) fail('缺少自定义 LUT 的完整资源，不能使用其他账号的裸引用')
    const resource = object(envelope.resources[0], ['content'])
    if (typeof resource.content !== 'string') fail('内嵌 LUT 必须是规范资源文本')
    const bytes = new TextEncoder().encode(resource.content), table = parseColorLutResource(bytes, work.options)
    const expected = await work.wait(() => describeColorLutResource(bytes, work.options))
    matchSource(source, expected)
    // Old account IDs are untrusted metadata. Only the current-owner upload
    // callback may establish the reference returned to the editor.
    const returned = await work.wait(() => uploadResource(table, work.options.signal)), descriptor = matchDescriptor(expected, returned)
    work.check()
    const lut = parseColorLutSelection({ ...settings.lut, source: { kind: 'asset', lutAssetId: descriptor.assetId, digest: descriptor.digest, name: descriptor.name, domainMin: descriptor.domainMin, domainMax: descriptor.domainMax } })
    return { name, settings: parseImageLayerColorGrade({ ...settings, lut }) }
  } finally { work.dispose() }
}
