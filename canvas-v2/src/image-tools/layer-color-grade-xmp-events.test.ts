import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { defaultImageLayerColorGrade, parseImageLayerColorGrade } from './layer-color-grade'
import { defaultImageLayerColorDetail } from './layer-color-detail'
import { defaultImageLayerColorCalibration } from './layer-color-calibration'
import { ColorGradeXmpReview } from './ColorGradeXmpReview'
import { maximumColorGradeXmpBytes, parseColorGradeXmp, serializeColorGradeXmp } from './layer-color-grade-xmp'
import { getPreparedColorLutTable } from './layer-color-lut-runtime'

const source = ts.createSourceFile('LayerColorGradeEditor.tsx', readFileSync(new URL('./LayerColorGradeEditor.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  let declaration = ''
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node.getText(source); ts.forEachChild(node, visit) }
  visit(source); if (!declaration) throw new Error(`Missing editor function ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${declaration})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
function deferred() { let resolve: (value: string) => void = () => {}; const promise = new Promise<string>((done) => { resolve = done }); return { resolve, promise } }
function fixture() {
  const presetTransfer = { current: null as { controller: AbortController; request: number; revision: number; scope: string } | null }, readingRef = { current: false }, xmpReviewRef = { current: null as unknown }
  const env = { completed: { current: false }, histogramController: { current: null as AbortController | null }, alive: { current: true }, importRequest: { current: 0 }, revision: { current: 0 }, scope: 'source-a', activeScope: { current: 'source-a' }, initialScope: { current: 'source-a' }, draftRef: { current: defaultImageLayerColorGrade() }, maximumColorGradeXmpBytes, parseColorGradeXmp, parseImageLayerColorGrade, serializeColorGradeXmp, getPreparedColorLutTable, presetTransfer, readingRef, lutReadingRef: { current: false }, xmpReviewRef, lutStateRef: { current: { busy: false, error: '', tables: new Map(), retry: vi.fn() } }, abortPresetTransfer: () => { const pending = presetTransfer.current; presetTransfer.current = null; pending?.controller.abort() }, setReading: vi.fn((next: boolean) => { readingRef.current = next }), setError: vi.fn(), setXmpReview: vi.fn(), setNotice: vi.fn(), setHidden: vi.fn(), setBefore: vi.fn(), change: vi.fn(), onApply: vi.fn(), onClose: vi.fn(), presetName: '自有设置', xmpFocus: { current: null as unknown }, xmpReview: null as unknown }
  env.change.mockImplementation((grade) => { env.draftRef.current = parseImageLayerColorGrade(grade); env.revision.current++ })
  env.setXmpReview.mockImplementation((review) => { env.xmpReview = review; xmpReviewRef.current = review })
  function call<T>(name: string): T { return actual<T>(name, env) }
  function read(text: string) { return call<(file: unknown) => Promise<void>>('importXmp')({ size: text.length, name: '自有.xmp', text: async () => text }) }
  const valid = serializeColorGradeXmp('自有设置', { ...defaultImageLayerColorGrade(), exposure: 1, temperature: 6500, tint: 15, vibrance: 20 }).text
  return { env, call, read, valid }
}

describe('actual XMP review and editor callbacks', () => {
  it('reviews seven calibration changes, cancels unchanged and preserves the disabled target through explicit confirmation and one apply', async () => {
    const f = fixture(), original = { ...defaultImageLayerColorGrade(), calibration: { ...defaultImageLayerColorCalibration(), enabled: false } }, incoming = { ...defaultImageLayerColorGrade(), calibration: { ...defaultImageLayerColorCalibration(), shadowTint: 25, redHue: 40, redSaturation: -30, greenHue: -35, greenSaturation: 20, blueHue: 30, blueSaturation: -25 } }
    f.env.draftRef.current = original
    const text = serializeColorGradeXmp('自有校准', incoming).text
    await f.read(text); expect(f.env.change).not.toHaveBeenCalled(); expect(f.env.onApply).not.toHaveBeenCalled()
    expect(f.env.xmpReview).toMatchObject({ data: { differences: expect.arrayContaining([{ field: '阴影色调', before: '0', after: '25' }, { field: '红原色色相', before: '0', after: '40' }]), warnings: expect.arrayContaining([expect.objectContaining({ field: '校准开关', value: '停用' })]) } })
    expect((f.env.xmpReview as { data: { differences: unknown[] } }).data.differences).toHaveLength(7)
    f.call<() => void>('cancelXmpImport')(); expect(f.env.draftRef.current).toEqual(original)
    await f.read(text); f.call<() => void>('confirmXmp')()
    expect(f.env.draftRef.current.calibration).toEqual({ ...incoming.calibration, enabled: false }); expect(f.env.onApply).not.toHaveBeenCalled()
    const apply = f.call<() => void>('apply'); apply(); apply()
    expect(f.env.onApply).toHaveBeenCalledExactlyOnceWith({ ...incoming, calibration: { ...incoming.calibration, enabled: false } }); expect(f.env.onClose).toHaveBeenCalledOnce()
  })
  it('does not overwrite a later calibration edit when an older XMP read resolves', async () => {
    const f = fixture(), pending = deferred(), read = f.call<(file: unknown) => Promise<void>>('importXmp')({ size: 100, name: 'late.xmp', text: () => pending.promise })
    const later = { ...defaultImageLayerColorGrade(), calibration: { ...defaultImageLayerColorCalibration(), redHue: -70 } }
    f.env.change(later); pending.resolve(serializeColorGradeXmp('旧校准', { ...defaultImageLayerColorGrade(), calibration: { ...defaultImageLayerColorCalibration(), redHue: 40 } }).text); await read
    expect(f.env.draftRef.current).toEqual(later); expect(f.env.xmpReview).toBeNull(); expect(f.env.onApply).not.toHaveBeenCalled(); expect(f.env.setError).toHaveBeenLastCalledWith(expect.stringContaining('调整已改变'))
  })
  it('stages all three presence differences, cancels unchanged and applies once only after explicit confirmation', async () => {
    const f = fixture(), original = { ...defaultImageLayerColorGrade(), presence: { version: 1 as const, enabled: false, texture: 0, clarity: 0, dehaze: 0 } }, incoming = { ...defaultImageLayerColorGrade(), presence: { version: 1 as const, enabled: true, texture: 60, clarity: 40, dehaze: 30 } }
    f.env.draftRef.current = original
    const text = serializeColorGradeXmp('自有质感', incoming).text
    await f.read(text); expect(f.env.change).not.toHaveBeenCalled(); expect(f.env.onApply).not.toHaveBeenCalled()
    expect(f.env.xmpReview).toMatchObject({ data: { differences: [{ field: '纹理', before: '0', after: '60' }, { field: '清晰度', before: '0', after: '40' }, { field: '去除薄雾', before: '0', after: '30' }], warnings: expect.arrayContaining([expect.objectContaining({ field: '质感与去雾开关', value: '停用' })]) } })
    f.call<() => void>('cancelXmpImport')(); expect(f.env.draftRef.current).toEqual(original)
    await f.read(text); f.call<() => void>('confirmXmp')(); expect(f.env.draftRef.current.presence).toEqual({ ...incoming.presence, enabled: false }); expect(f.env.onApply).not.toHaveBeenCalled()
    const apply = f.call<() => void>('apply'); apply(); apply()
    expect(f.env.onApply).toHaveBeenCalledExactlyOnceWith({ ...incoming, presence: { ...incoming.presence, enabled: false } }); expect(f.env.onClose).toHaveBeenCalledOnce()
  })
  it('stages parsed differences without changing the draft, cancels intact, and confirms before a single final commit', async () => {
    const f = fixture(), original = JSON.stringify(f.env.draftRef.current)
    await f.read(f.valid)
    expect(f.env.change).not.toHaveBeenCalled(); expect(f.env.onApply).not.toHaveBeenCalled()
    expect(f.env.xmpReview).toMatchObject({ mode: 'import', data: { differences: expect.arrayContaining([{ field: '曝光', before: '0', after: '1' }]) } })
    f.call<() => void>('cancelXmpImport')(); expect(JSON.stringify(f.env.draftRef.current)).toBe(original); expect(f.env.xmpReview).toBeNull()
    await f.read(f.valid); f.call<() => void>('confirmXmp')()
    expect(f.env.change).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ exposure: 1, temperature: 6500, tint: 15, vibrance: 20 }))
    expect(f.env.onApply).not.toHaveBeenCalled(); expect(f.env.xmpReview).toBeNull()
    const apply = f.call<() => void>('apply'); apply(); apply()
    expect(f.env.onApply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ version: 1, exposure: 1 }))
    expect(f.env.onClose).toHaveBeenCalledOnce()
  })
  it('reviews all ten detail fields, cancels without edits, and preserves the current disabled flag through explicit confirmation and one apply', async () => {
    const f = fixture(), original = { ...defaultImageLayerColorGrade(), detail: { ...defaultImageLayerColorDetail(), enabled: false } }, incoming = { ...defaultImageLayerColorGrade(), detail: { version: 1 as const, enabled: true, sharpening: { amount: 80, radius: 1.5, detail: 40, masking: 35 }, luminance: { amount: 70, detail: 45, contrast: 20 }, color: { amount: 60, detail: 55, smoothness: 65 } } }
    f.env.draftRef.current = original
    const text = serializeColorGradeXmp('自有细节', incoming).text
    await f.read(text)
    expect(f.env.draftRef.current).toEqual(original); expect(f.env.onApply).not.toHaveBeenCalled()
    expect(f.env.xmpReview).toMatchObject({ data: { mappedFields: expect.arrayContaining(['Sharpness', 'ColorNoiseReductionSmoothness']), warnings: expect.arrayContaining([expect.objectContaining({ field: '细节开关', value: '停用' })]) } })
    f.call<() => void>('cancelXmpImport')(); expect(f.env.draftRef.current).toEqual(original)
    await f.read(text); f.call<() => void>('confirmXmp')()
    expect(f.env.draftRef.current.detail).toEqual({ ...incoming.detail, enabled: false }); expect(f.env.onApply).not.toHaveBeenCalled()
    const apply = f.call<() => void>('apply'); apply(); apply()
    expect(f.env.onApply).toHaveBeenCalledExactlyOnceWith({ ...incoming, detail: { ...incoming.detail, enabled: false } }); expect(f.env.onClose).toHaveBeenCalledOnce()
  })
  it('bounds file size before reading and rejects malformed content without staging a successful review', async () => {
    const f = fixture(), text = vi.fn().mockResolvedValue(f.valid)
    await f.call<(file: unknown) => Promise<void>>('importXmp')({ size: maximumColorGradeXmpBytes + 1, text })
    expect(text).not.toHaveBeenCalled(); expect(f.env.xmpReview).toBeNull()
    await f.read('<!DOCTYPE x><x/>'); expect(f.env.change).not.toHaveBeenCalled(); expect(f.env.xmpReview).toBeNull(); expect(f.env.setError).toHaveBeenCalledWith(expect.stringContaining('DOCTYPE'))
  })
  it.each(['cancelled', 'closed', 'unmounted', 'source', 'newer-import', 'edited'] as const)('never stages a late file over %s', async (condition) => {
    const f = fixture(), pending = deferred(), read = f.call<(file: unknown) => Promise<void>>('importXmp')({ size: 100, name: 'late.xmp', text: () => pending.promise })
    if (condition === 'cancelled') f.call<() => void>('cancelXmpImport')()
    if (condition === 'closed') f.call<() => void>('close')()
    if (condition === 'unmounted') f.env.alive.current = false
    if (condition === 'source') f.env.activeScope.current = 'source-b'
    if (condition === 'newer-import') await f.read(f.valid)
    if (condition === 'edited') f.env.change({ ...f.env.draftRef.current, exposure: -.5 })
    const staged = f.env.xmpReview
    pending.resolve(f.valid); await read
    expect(f.env.xmpReview).toBe(staged)
    expect(f.env.change).toHaveBeenCalledTimes(condition === 'edited' ? 1 : 0)
    expect(f.env.onApply).not.toHaveBeenCalled()
    if (condition === 'edited') expect(f.env.setError).toHaveBeenLastCalledWith(expect.stringContaining('调整已改变'))
  })
  it.each(['edited', 'source', 'cancelled', 'closed', 'unmounted'] as const)('refuses a previously rendered confirmation after %s', async (condition) => {
    const f = fixture(); await f.read(f.valid)
    const confirm = f.call<() => void>('confirmXmp')
    if (condition === 'edited') f.env.change({ ...f.env.draftRef.current, exposure: -.5 })
    if (condition === 'source') f.env.activeScope.current = 'source-b'
    if (condition === 'cancelled') f.call<() => void>('cancelXmpImport')()
    if (condition === 'closed') f.call<() => void>('close')()
    if (condition === 'unmounted') f.env.alive.current = false
    confirm()
    expect(f.env.change).toHaveBeenCalledTimes(condition === 'edited' ? 1 : 0)
    expect(f.env.onApply).not.toHaveBeenCalled()
  })
  it('requires explicit export review and leaves the draft unchanged when export is cancelled', () => {
    const f = fixture(), original = JSON.stringify(f.env.draftRef.current)
    f.call<() => void>('exportXmp')()
    expect(f.env.xmpReview).toMatchObject({ mode: 'export', data: { text: expect.stringContaining('<crs:ToneCurvePV2012>'), warnings: expect.arrayContaining([expect.objectContaining({ field: '分级参数' })]) } })
    f.call<() => void>('cancelXmpImport')()
    expect(f.env.change).not.toHaveBeenCalled(); expect(JSON.stringify(f.env.draftRef.current)).toBe(original)
    expect(f.env.xmpFocus.current).toMatchObject({ mode: 'export', scope: 'source-a', request: f.env.importRequest.current })
  })
  it('downloads standard XML only after explicit export confirmation without committing the layer', async () => {
    const f = fixture(), click = vi.fn(), createObjectURL = vi.fn((_blob: Blob) => 'blob:own-xmp'), revokeObjectURL = vi.fn(), anchor = { href: '', download: '', click }, timers: (() => void)[] = []
    f.call<() => void>('exportXmp')()
    expect(createObjectURL).not.toHaveBeenCalled()
    const confirm = actual<() => void>('confirmXmp', { ...f.env, Blob, URL: { createObjectURL, revokeObjectURL }, document: { createElement: vi.fn(() => anchor) }, setTimeout: (callback: () => void) => timers.push(callback) })
    confirm(); confirm()
    expect(createObjectURL).toHaveBeenCalledOnce(); expect(click).toHaveBeenCalledOnce(); expect(anchor.download).toBe('星芒-图像调整预设.xmp')
    const blob = createObjectURL.mock.calls[0][0]
    expect(blob.type).toBe('application/rdf+xml'); expect(await blob.text()).toContain('crs:Exposure2012="0"')
    expect(f.env.change).not.toHaveBeenCalled(); expect(f.env.onApply).not.toHaveBeenCalled(); expect(f.env.xmpFocus.current).toMatchObject({ mode: 'export', scope: 'source-a' })
    timers[0](); expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:own-xmp')
  })
  it('does not export an obsolete review after a newer draft edit', () => {
    const f = fixture(); f.call<() => void>('exportXmp')()
    f.env.change({ ...f.env.draftRef.current, temperature: 7000 }); f.call<() => void>('confirmXmp')()
    expect(f.env.setError).toHaveBeenLastCalledWith(expect.stringContaining('核对期间调整或图层已改变')); expect(f.env.xmpReview).toBeNull(); expect(f.env.onApply).not.toHaveBeenCalled()
  })
  it('leaves a newer import review intact when a retained older confirm or cancel callback arrives', async () => {
    const f = fixture(); await f.read(f.valid)
    const oldConfirm = f.call<() => void>('confirmXmp'), oldCancel = f.call<() => void>('cancelXmpImport')
    await f.read(serializeColorGradeXmp('Newer', { ...defaultImageLayerColorGrade(), exposure: 2 }).text)
    const newer = f.env.xmpReview, request = f.env.importRequest.current
    oldConfirm(); oldCancel()
    expect(f.env.xmpReview).toBe(newer); expect(f.env.importRequest.current).toBe(request); expect(f.env.change).not.toHaveBeenCalled()
    f.call<() => void>('confirmXmp')(); expect(f.env.change).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ exposure: 2 }))
  })
  it('renders actual difference values, every unsupported warning and explicit confirmation without executing markup', () => {
    const data = parseColorGradeXmp(serializeColorGradeXmp('Own', { ...defaultImageLayerColorGrade(), exposure: .5 }).text, defaultImageLayerColorGrade())
    data.warnings.push({ field: '<script>unsupported</script>', value: '<img src=x>', message: '不会应用' })
    const html = renderToStaticMarkup(createElement(ColorGradeXmpReview, { mode: 'import', name: 'own.xmp', ...data, onConfirm() {}, onCancel() {} }))
    expect(html).toContain('XMP 导入参数核对'); expect(html).toContain('确认应用到草稿'); expect(html).toContain('取消导入'); expect(html).toContain('<th>曝光</th><td>0</td><td>0.5</td>')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('&lt;script&gt;unsupported&lt;/script&gt;'); expect(html).not.toContain('<img src=x>')
    expect(html).toContain('<details class="color-grade-xmp-warnings"><summary>'); expect(html).toContain('确认前请展开核对 · 未映射项不会应用')
    expect(html).not.toContain('class="color-grade-xmp-warnings" open')
    expect(html).toContain('缺失与不支持的参数保留当前值'); expect(html).toContain('不保证像素一致')
    const exported = renderToStaticMarkup(createElement(ColorGradeXmpReview, { mode: 'export', name: 'own.xmp', differences: [], warnings: data.warnings, mappedFields: data.mappedFields, onConfirm() {}, onCancel() {} }))
    expect(exported).toContain('确认并下载 XMP'); expect(exported).toContain('完整设置与曲线原始精度请同时保存 JSON')
  })
  it('keeps twenty warning details in an initially collapsed disclosure with visible review actions', () => {
    const warnings = Array.from({ length: 20 }, (_, at) => ({ field: `Unsupported${at}`, value: `${at}`, message: `保留原值${at}` }))
    const html = renderToStaticMarkup(createElement(ColorGradeXmpReview, { mode: 'import', name: 'own.xmp', mappedFields: ['Exposure2012'], differences: [{ field: '曝光', before: '0', after: '1' }], warnings, onConfirm() {}, onCancel() {} }))
    expect(html).toContain('不支持项与互通限制（20 项）')
    expect(html).toContain('<details class="color-grade-xmp-warnings"><summary>')
    for (const warning of warnings) expect(html).toContain(`<b>${warning.field}</b><code>${warning.value}</code><span>${warning.message}</span>`)
    expect(html).toContain('</ul></details><div class="color-grade-xmp-actions">')
    expect(html).toContain('确认应用到草稿'); expect(html).toContain('取消导入')
  })
})
