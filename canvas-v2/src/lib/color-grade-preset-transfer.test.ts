import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { defaultImageLayerColorGrade, type ImageLayerColorGrade } from '../image-tools/layer-color-grade'
import { defaultImageLayerColorDetail } from '../image-tools/layer-color-detail'
import { defaultImageLayerColorCalibration } from '../image-tools/layer-color-calibration'
import { parseColorGradePreset, serializeColorGradePreset } from '../image-tools/layer-color-grade-editor-state'
import { createLayerColorLutPreset } from '../image-tools/layer-color-lut-presets'
import type { ColorLutTable } from '../image-tools/layer-color-lut'
import { buildColorLutSelection, type AssetColorLutSource } from '../image-tools/layer-color-lut-selection'
import { describeColorLutResource, parseColorLutResource, serializeColorLutResource, type ColorLutResourceDescriptor } from './color-lut-resource-contract'
import { buildColorGradePresetTransfer, importColorGradePresetTransfer, maximumColorGradePresetTransferBytes } from './color-grade-preset-transfer'

let table: ColorLutTable, descriptor: ColorLutResourceDescriptor, content: string, grade: ImageLayerColorGrade, transfer: string
function sameTable(value: ColorLutTable) { expect(value.name).toBe(table.name); expect(value.domainMin).toEqual(table.domainMin); expect(value.domainMax).toEqual(table.domainMax); expect(value.data).toEqual(table.data) }
function freshEnvelope() { return JSON.parse(transfer) as { format: string; version: number; name: string; settings: ImageLayerColorGrade; resources: { content: string }[] } }
function read() { return vi.fn(async (_source: AssetColorLutSource, _signal: AbortSignal) => ({ descriptor, table })) }
function upload() { return vi.fn(async (_table: ColorLutTable, _signal: AbortSignal) => ({ ...descriptor, assetId: 'z'.repeat(43) })) }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((accept) => { resolve = accept }); return { promise, resolve } }
async function settle() { for (let at = 0; at < 8; at++) await Promise.resolve() }
beforeAll(async () => {
  table = { ...createLayerColorLutPreset('xm-lut-cool-tone-v1'), name: '自有 LUT 😀', domainMin: [-1, 0, .1], domainMax: [2, 1, 1.5] }
  const bytes = serializeColorLutResource(table)
  content = new TextDecoder().decode(bytes); descriptor = { ...await describeColorLutResource(bytes), assetId: 'a'.repeat(43) }
  grade = { ...defaultImageLayerColorGrade(), exposure: 1.25, temperature: 6500, lut: { version: 1, enabled: false, strength: 0, source: { kind: 'asset', lutAssetId: descriptor.assetId, digest: descriptor.digest, name: descriptor.name, domainMin: [...descriptor.domainMin], domainMax: [...descriptor.domainMax] } } }
  grade.hsl.green.hue = 19; grade.curves.rgb = [{ x: 0, y: .1 }, { x: .4, y: .6 }, { x: 1, y: .9 }]
  transfer = await buildColorGradePresetTransfer('完整自有调整', grade, read())
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('self-contained color grade preset version two', () => {
  it.each([{ enabled: true, shadowTint: 25, redHue: 40 }, { enabled: false, shadowTint: -25, redHue: 40 }, { enabled: true, shadowTint: 0, redHue: 0 }])('round trips full version five calibration with latent presence, detail and a current-owner LUT remap: %j', async (values) => {
    const settings = { ...structuredClone(grade), calibration: { ...defaultImageLayerColorCalibration(), ...values }, presence: { version: 1 as const, enabled: false, texture: 60, clarity: 40, dehaze: 30 }, detail: defaultImageLayerColorDetail() }, original = structuredClone(settings), reader = read(), writer = upload()
    const text = await buildColorGradePresetTransfer('完整校准', settings, reader), envelope = JSON.parse(text)
    expect(envelope.version).toBe(5); expect(envelope.settings).toEqual(settings); expect(envelope.resources).toEqual([{ content }])
    const imported = await importColorGradePresetTransfer(text, writer)
    expect(imported.settings).toEqual({ ...settings, lut: { ...settings.lut, source: { ...settings.lut?.source, lutAssetId: 'z'.repeat(43) } } })
    expect(reader).toHaveBeenCalledOnce(); expect(writer).toHaveBeenCalledOnce(); sameTable(writer.mock.calls[0][0]); expect(settings).toEqual(original)
  })
  it('keeps all seven explicit neutral calibration values in version five without resource I/O', async () => {
    const settings = { ...defaultImageLayerColorGrade(), calibration: defaultImageLayerColorCalibration() }, reader = read(), writer = upload()
    const text = await buildColorGradePresetTransfer('中性校准', settings, reader)
    expect(JSON.parse(text)).toMatchObject({ version: 5, resources: [] }); expect(await importColorGradePresetTransfer(text, writer)).toEqual({ name: '中性校准', settings })
    expect(reader).not.toHaveBeenCalled(); expect(writer).not.toHaveBeenCalled(); expect(() => parseColorGradePreset(text)).toThrow('格式或版本')
  })
  it.each([1, 2, 3, 4])('refuses any calibration presence in old version %s before touching the current owner uploader', async (version) => {
    const writer = upload()
    for (const calibration of [null, false, 0, {}, defaultImageLayerColorCalibration(), { ...defaultImageLayerColorCalibration(), enabled: false, redHue: 40 }]) await expect(importColorGradePresetTransfer(JSON.stringify({ ...freshEnvelope(), version, settings: { ...grade, calibration } }), writer)).rejects.toThrow('旧版文件不能包含校准')
    expect(writer).not.toHaveBeenCalled()
  })
  it('rejects missing and malformed version five calibration and tampered LUT content before upload', async () => {
    const writer = upload()
    await expect(importColorGradePresetTransfer(JSON.stringify({ ...freshEnvelope(), version: 5 }), writer)).rejects.toThrow('缺少校准')
    for (const calibration of [null, false, {}, { ...defaultImageLayerColorCalibration(), version: 2 }, { ...defaultImageLayerColorCalibration(), shadowTint: 101 }, { ...defaultImageLayerColorCalibration(), unknown: true }]) await expect(importColorGradePresetTransfer(JSON.stringify({ ...freshEnvelope(), version: 5, settings: { ...grade, calibration } }), writer)).rejects.toThrow()
    const value = { ...freshEnvelope(), version: 5, settings: { ...grade, calibration: defaultImageLayerColorCalibration() }, resources: [{ content: content.replace('自有 LUT', '改过 LUT') }] }
    await expect(importColorGradePresetTransfer(JSON.stringify(value), writer)).rejects.toThrow(); expect(writer).not.toHaveBeenCalled()
  })
  it.each([{ enabled: true, texture: 60, clarity: -40, dehaze: 30 }, { enabled: false, texture: 60, clarity: 40, dehaze: 30 }, { enabled: true, texture: 0, clarity: 0, dehaze: 0 }])('uses version four for every explicit presence including inactive values while preserving detail and remapping the full LUT: %j', async (values) => {
    const settings = { ...structuredClone(grade), presence: { version: 1 as const, ...values }, detail: defaultImageLayerColorDetail() }, original = structuredClone(settings), reader = read(), writer = upload()
    const text = await buildColorGradePresetTransfer('完整质感预设', settings, reader), envelope = JSON.parse(text)
    expect(envelope.version).toBe(4); expect(envelope.settings).toEqual(settings); expect(envelope.resources).toEqual([{ content }])
    const imported = await importColorGradePresetTransfer(text, writer)
    expect(imported.settings).toEqual({ ...settings, lut: { ...settings.lut, source: { ...settings.lut?.source, lutAssetId: 'z'.repeat(43) } } })
    expect(settings).toEqual(original); expect(reader).toHaveBeenCalledOnce(); expect(writer).toHaveBeenCalledOnce(); sameTable(writer.mock.calls[0][0])
    expect(() => parseColorGradePreset(text)).toThrow('64 KiB')
  })
  it('round trips presence without resource I/O and keeps old detail-only version three and ordinary version two behavior', async () => {
    const reader = read(), writer = upload(), presence = { version: 1 as const, enabled: false, texture: -50, clarity: 20, dehaze: 0 }
    const settings = { ...defaultImageLayerColorGrade(), presence }, text = await buildColorGradePresetTransfer('本地质感', settings, reader)
    expect(JSON.parse(text)).toMatchObject({ version: 4, resources: [] }); expect(await importColorGradePresetTransfer(text, writer)).toEqual({ name: '本地质感', settings })
    expect(() => parseColorGradePreset(text)).toThrow('格式或版本')
    const detail = { ...defaultImageLayerColorGrade(), detail: defaultImageLayerColorDetail() }, oldText = await buildColorGradePresetTransfer('细节原稿', detail, reader)
    expect(JSON.parse(oldText).version).toBe(3); expect((await importColorGradePresetTransfer(oldText, writer)).settings).toEqual(detail)
    expect(JSON.parse(await buildColorGradePresetTransfer('旧普通', defaultImageLayerColorGrade(), reader)).version).toBe(2)
    expect(reader).not.toHaveBeenCalled(); expect(writer).not.toHaveBeenCalled()
  })
  it.each([1, 2, 3])('refuses every presence value in old preset version %s before LUT upload', async (version) => {
    const writer = upload()
    for (const presence of [null, false, 0, {}, { version: 1, enabled: false, texture: 0, clarity: 0, dehaze: 0 }]) {
      const value = { ...freshEnvelope(), version, settings: { ...grade, presence } }
      await expect(importColorGradePresetTransfer(JSON.stringify(value), writer)).rejects.toThrow('旧版文件不能包含质感与去雾')
    }
    expect(writer).not.toHaveBeenCalled()
  })
  it('refuses missing or malformed version four presence and unknown versions before resource I/O', async () => {
    const writer = upload()
    await expect(importColorGradePresetTransfer(JSON.stringify({ ...freshEnvelope(), version: 4 }), writer)).rejects.toThrow('缺少质感与去雾')
    for (const presence of [null, false, {}, { version: 2, enabled: true, texture: 0, clarity: 0, dehaze: 0 }, { version: 1, enabled: true, texture: 101, clarity: 0, dehaze: 0 }, { version: 1, enabled: true, texture: 0, clarity: 0, dehaze: 0, unknown: true }]) await expect(importColorGradePresetTransfer(JSON.stringify({ ...freshEnvelope(), version: 4, settings: { ...grade, presence } }), writer)).rejects.toThrow()
    await expect(importColorGradePresetTransfer(JSON.stringify({ ...freshEnvelope(), version: 6 }), writer)).rejects.toThrow('版本')
    expect(writer).not.toHaveBeenCalled()
  })
  it('exports the complete canonical LUT even when disabled at zero strength and keeps grade1 lightweight', () => {
    const envelope = freshEnvelope()
    expect(envelope).toMatchObject({ format: 'xingmang-layer-color-grade', version: 2, name: '完整自有调整', settings: grade })
    expect(envelope.resources).toEqual([{ content }])
    expect(new TextEncoder().encode(transfer).length).toBeLessThan(maximumColorGradePresetTransferBytes)
    expect(JSON.stringify(envelope.settings).length).toBeLessThan(4096)
    sameTable(parseColorLutResource(new TextEncoder().encode(envelope.resources[0].content)))
    expect(() => parseColorGradePreset(transfer)).toThrow()
  })
  it('fully validates the embedded bytes before calling only the current-owner uploader and remaps its receipt', async () => {
    const write = upload(), before = JSON.stringify(grade), result = await importColorGradePresetTransfer(transfer, write)
    expect(write).toHaveBeenCalledOnce(); sameTable(write.mock.calls[0][0])
    expect(write.mock.calls[0][1]).toBeInstanceOf(AbortSignal)
    expect(result).toEqual({ name: '完整自有调整', settings: { ...grade, lut: { ...grade.lut, source: { ...grade.lut?.source, lutAssetId: 'z'.repeat(43) } } } })
    expect(JSON.stringify(grade)).toBe(before)
  })
  it.each(['none', 'builtin'] as const)('exports and imports %s without any resource I/O', async (kind) => {
    const settings = { ...defaultImageLayerColorGrade(), ...(kind === 'builtin' ? { lut: buildColorLutSelection({ kind: 'builtin', presetId: 'xm-lut-movie-tone-v1' }) } : {}) }, reader = read(), writer = upload()
    const text = await buildColorGradePresetTransfer('  原创预设  ', settings, reader)
    expect(JSON.parse(text).resources).toEqual([])
    expect(await importColorGradePresetTransfer(text, writer)).toEqual({ name: '原创预设', settings })
    expect(reader).not.toHaveBeenCalled(); expect(writer).not.toHaveBeenCalled(); expect(() => parseColorGradePreset(text)).toThrow('版本')
  })
  it('retains original version-one behavior for a legacy file without any LUT presence', async () => {
    const text = serializeColorGradePreset('原有调整', { ...defaultImageLayerColorGrade(), exposure: -.5 }), writer = upload()
    expect(await importColorGradePresetTransfer(text, writer)).toEqual(parseColorGradePreset(text)); expect(writer).not.toHaveBeenCalled()
  })
  it.each([null, false, 0, '', {}, { version: 1 }, { version: 2 }, { version: 1, source: { kind: 'builtin', presetId: 'xm-lut-movie-tone-v1' } }])('rejects any version-one LUT presence without accessing resources: %j', async (lut) => {
    const writer = upload(), value = { format: 'xingmang-layer-color-grade', version: 1, name: '旧裸引用', settings: { ...defaultImageLayerColorGrade(), lut } }
    await expect(importColorGradePresetTransfer(JSON.stringify(value), writer)).rejects.toThrow('旧版文件不能包含 LUT 引用')
    expect(writer).not.toHaveBeenCalled()
  })
  it.each([
    (value: ReturnType<typeof freshEnvelope>) => ({ ...value, extra: true }),
    (value: ReturnType<typeof freshEnvelope>) => { const { resources: _resources, ...rest } = value; return rest },
    (value: ReturnType<typeof freshEnvelope>) => ({ ...value, version: 3 }),
    (value: ReturnType<typeof freshEnvelope>) => ({ ...value, format: 'other' }),
    (value: ReturnType<typeof freshEnvelope>) => ({ ...value, resources: null }),
    (value: ReturnType<typeof freshEnvelope>) => ({ ...value, resources: [] }),
    (value: ReturnType<typeof freshEnvelope>) => ({ ...value, resources: [...value.resources, ...value.resources] }),
    (value: ReturnType<typeof freshEnvelope>) => ({ ...value, resources: [{ content, digest: descriptor.digest }] }),
    (value: ReturnType<typeof freshEnvelope>) => ({ ...value, resources: [{}] }),
    (value: ReturnType<typeof freshEnvelope>) => ({ ...value, resources: [{ content: null }] }),
    (value: ReturnType<typeof freshEnvelope>) => ({ ...value, settings: { ...value.settings, endpoint: 'https://invalid.example/' } }),
  ])('rejects malformed envelopes and resource counts before uploading #%#', async (modify) => {
    const writer = upload()
    await expect(importColorGradePresetTransfer(JSON.stringify(modify(freshEnvelope())), writer)).rejects.toThrow()
    expect(writer).not.toHaveBeenCalled()
  })
  it.each(['none', 'builtin'] as const)('rejects an extraneous embedded resource for %s', async (kind) => {
    const value = freshEnvelope(); value.settings = defaultImageLayerColorGrade()
    if (kind === 'builtin') value.settings.lut = buildColorLutSelection({ kind: 'builtin', presetId: 'xm-lut-high-saturation-v1' })
    const writer = upload(); await expect(importColorGradePresetTransfer(JSON.stringify(value), writer)).rejects.toThrow('多余')
    expect(writer).not.toHaveBeenCalled()
  })
  it.each(['digest', 'name', 'domainMin', 'domainMax'] as const)('rejects an embedded resource whose %s does not match the retained selection', async (field) => {
    const value = freshEnvelope(), source = value.settings.lut?.source
    if (!source || source.kind !== 'asset') throw new Error('Missing owned fixture')
    if (field === 'digest') source.digest = 'b'.repeat(64); else if (field === 'name') source.name += ' changed'; else source[field][0] += .1
    const writer = upload(); await expect(importColorGradePresetTransfer(JSON.stringify(value), writer)).rejects.toThrow('摘要、名称或输入域不一致')
    expect(writer).not.toHaveBeenCalled()
  })
  it('detects canonical sample-byte tampering and noncanonical encoding before upload', async () => {
    const value = freshEnvelope(), resource = JSON.parse(content) as { data: string }; resource.data = (resource.data[0] === 'A' ? 'B' : 'A') + resource.data.slice(1)
    value.resources[0].content = JSON.stringify(resource)
    const writer = upload(); await expect(importColorGradePresetTransfer(JSON.stringify(value), writer)).rejects.toThrow()
    value.resources[0].content = ' ' + content
    await expect(importColorGradePresetTransfer(JSON.stringify(value), writer)).rejects.toThrow('规范编码')
    value.resources[0].content = 'https://old-owner.invalid/resource'
    await expect(importColorGradePresetTransfer(JSON.stringify(value), writer)).rejects.toThrow(); expect(writer).not.toHaveBeenCalled()
  })
  it.each(['digest', 'name', 'domainMin', 'domainMax', 'byteSize', 'assetId'] as const)('rejects an inconsistent read-resource %s receipt when exporting', async (field) => {
    const changed = structuredClone(descriptor)
    if (field === 'digest') changed.digest = 'b'.repeat(64); else if (field === 'name') changed.name += ' changed'; else if (field === 'assetId') changed.assetId = 'q'.repeat(43); else if (field === 'byteSize') changed.byteSize++; else changed[field][0] += .1
    await expect(buildColorGradePresetTransfer('完整预设', grade, async () => ({ descriptor: changed, table }))).rejects.toThrow()
  })
  it('rejects a reader returning different sample bytes under the original descriptor', async () => {
    const changed = { ...table, data: new Float32Array(table.data) }; changed.data[100] = .123456
    await expect(buildColorGradePresetTransfer('错误样本', grade, async () => ({ descriptor, table: changed }))).rejects.toThrow('素材回执与已核验的 LUT 内容不一致')
  })
  it.each(['digest', 'name', 'domainMin', 'domainMax', 'byteSize', 'mimeType', 'assetId'] as const)('rejects an inconsistent current-owner upload %s receipt instead of returning a setting', async (field) => {
    const changed = structuredClone(descriptor)
    if (field === 'digest') changed.digest = 'b'.repeat(64); else if (field === 'name') changed.name += ' changed'; else if (field === 'assetId') changed.assetId = '../old-account'; else if (field === 'byteSize') changed.byteSize++; else if (field === 'mimeType') Object.assign(changed, { mimeType: 'image/png' }); else changed[field][0] += .1
    await expect(importColorGradePresetTransfer(transfer, async () => changed)).rejects.toThrow()
  })
  it('snapshots settings before an asynchronous export so later caller edits do not replace its LUT or grade', async () => {
    const settings = structuredClone(grade), pending = deferred<{ descriptor: ColorLutResourceDescriptor; table: ColorLutTable }>(), exporting = buildColorGradePresetTransfer('快照', settings, async () => pending.promise)
    settings.exposure = -2; if (settings.lut) settings.lut.strength = 99
    pending.resolve({ descriptor, table }); const result = JSON.parse(await exporting)
    expect(result.settings).toEqual(grade)
  })
  it('does not trust an old account ID even when it is shaped like the current content address', async () => {
    const value = freshEnvelope(), source = value.settings.lut?.source
    if (!source || source.kind !== 'asset') throw new Error('Missing owned fixture')
    source.lutAssetId = 'q'.repeat(43)
    const writer = upload(), result = await importColorGradePresetTransfer(JSON.stringify(value), writer)
    expect(writer).toHaveBeenCalledOnce(); expect(result.settings.lut?.source).toMatchObject({ lutAssetId: 'z'.repeat(43), digest: descriptor.digest })
  })
  it.each(['', 'name\u0001', 'name\ud800', 'a'.repeat(81)])('rejects an invalid transfer title %j without reading a resource', async (name) => {
    const reader = read(); await expect(buildColorGradePresetTransfer(name, grade, reader)).rejects.toThrow('名称'); expect(reader).not.toHaveBeenCalled()
  })
  it('bounds UTF-8 input before parsing and preserves the stricter legacy 64 KiB boundary', async () => {
    const writer = upload()
    await expect(importColorGradePresetTransfer('中'.repeat(maximumColorGradePresetTransferBytes / 3 + 1), writer)).rejects.toThrow('768 KiB')
    await expect(importColorGradePresetTransfer(' '.repeat(70 * 1024) + serializeColorGradePreset('原有', defaultImageLayerColorGrade()), writer)).rejects.toThrow('64 KiB')
    await expect(importColorGradePresetTransfer('not JSON', writer)).rejects.toThrow('JSON')
    expect(writer).not.toHaveBeenCalled()
  })
  it.each([NaN, Infinity, -Infinity, 0])('rejects an invalid or expired deadline %s before any resource I/O', async (deadline) => {
    const reader = read(), writer = upload()
    await expect(buildColorGradePresetTransfer('受限预设', grade, reader, { deadline })).rejects.toThrow()
    await expect(importColorGradePresetTransfer(transfer, writer, { deadline })).rejects.toThrow()
    expect(reader).not.toHaveBeenCalled(); expect(writer).not.toHaveBeenCalled()
  })
  it('rejects pre-aborted export and import without touching an account resource', async () => {
    const controller = new AbortController(), reader = read(), writer = upload(); controller.abort()
    await expect(buildColorGradePresetTransfer('已取消', grade, reader, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(importColorGradePresetTransfer(transfer, writer, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(reader).not.toHaveBeenCalled(); expect(writer).not.toHaveBeenCalled()
  })
  it('immediately cancels a pending export and discards a late reader result', async () => {
    const controller = new AbortController(), pending = deferred<{ descriptor: ColorLutResourceDescriptor; table: ColorLutTable }>(), reader = vi.fn(async (_source: AssetColorLutSource, _signal: AbortSignal) => pending.promise)
    const running = buildColorGradePresetTransfer('取消读取', grade, reader, { signal: controller.signal }), rejected = expect(running).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort(); await rejected; expect(reader.mock.calls[0][1].aborted).toBe(true)
    pending.resolve({ descriptor, table }); await settle()
  })
  it('immediately cancels a pending owner upload and never returns its late descriptor', async () => {
    const controller = new AbortController(), pending = deferred<ColorLutResourceDescriptor>(), started = deferred<void>(), writer = vi.fn(async (_table: ColorLutTable, _signal: AbortSignal) => { started.resolve(); return pending.promise })
    const running = importColorGradePresetTransfer(transfer, writer, { signal: controller.signal }), rejected = expect(running).rejects.toMatchObject({ name: 'AbortError' })
    await started.promise; controller.abort(); await rejected; expect(writer.mock.calls[0][1].aborted).toBe(true)
    pending.resolve({ ...descriptor, assetId: 'z'.repeat(43) }); await settle()
  })
  it('enforces a deadline while a resource callback is pending and aborts its supplied signal', async () => {
    vi.useFakeTimers(); const pending = deferred<{ descriptor: ColorLutResourceDescriptor; table: ColorLutTable }>(), reader = vi.fn(async (_source: AssetColorLutSource, _signal: AbortSignal) => pending.promise)
    const running = buildColorGradePresetTransfer('超时读取', grade, reader, { deadline: Date.now() + 20 }), rejected = expect(running).rejects.toMatchObject({ name: 'TimeoutError' })
    await vi.advanceTimersByTimeAsync(20); await rejected; expect(reader.mock.calls[0][1].aborted).toBe(true)
    pending.resolve({ descriptor, table }); await settle()
  })
  it('enforces a deadline while an owner upload is pending without accepting its late receipt', async () => {
    vi.useFakeTimers(); const pending = deferred<ColorLutResourceDescriptor>(), started = deferred<void>(), writer = vi.fn(async (_table: ColorLutTable, _signal: AbortSignal) => { started.resolve(); return pending.promise })
    const running = importColorGradePresetTransfer(transfer, writer, { deadline: Date.now() + 1000 }), rejected = expect(running).rejects.toMatchObject({ name: 'TimeoutError' })
    await started.promise; await vi.advanceTimersByTimeAsync(1000); await rejected; expect(writer.mock.calls[0][1].aborted).toBe(true)
    pending.resolve(descriptor); await settle()
  })
})
