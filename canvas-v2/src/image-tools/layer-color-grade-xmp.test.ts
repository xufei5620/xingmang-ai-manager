import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { defaultImageLayerColorGrade, imageLayerHslChannels } from './layer-color-grade'
import { defaultImageLayerColorDetail } from './layer-color-detail'
import { parseColorGradeXmp, serializeColorGradeXmp } from './layer-color-grade-xmp'
import { maximumColorGradeXmpBytes, parseColorGradeXmpXml } from './layer-color-grade-xmp-xml'

function packet(properties: string, body = ''): string { return `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" ${properties}>${body}</rdf:Description></rdf:RDF></x:xmpmeta>` }
function curve(points: string[], field = 'ToneCurvePV2012'): string { return `<crs:${field}><rdf:Seq>${points.map((point) => `<rdf:li>${point}</rdf:li>`).join('')}</rdf:Seq></crs:${field}>` }

describe('Camera Raw color grade parameter exchange', () => {
  it('maps the actual owned nonzero reference presence fields and retains the target disabled state without changing its draft', () => {
    const text = readFileSync(new URL('./test-fixtures/effects-positive.xmp', import.meta.url), 'utf8')
    const current = { ...defaultImageLayerColorGrade(), presence: { version: 1 as const, enabled: false, texture: 0, clarity: 0, dehaze: 0 } }, before = structuredClone(current)
    const review = parseColorGradeXmp(text, current)
    expect(review.settings.presence).toEqual({ version: 1, enabled: false, texture: 60, clarity: 40, dehaze: 30 })
    expect(review.differences.filter((entry) => ['纹理', '清晰度', '去除薄雾'].includes(entry.field))).toEqual([{ field: '纹理', before: '0', after: '60' }, { field: '清晰度', before: '0', after: '40' }, { field: '去除薄雾', before: '0', after: '30' }])
    expect(review.mappedFields).toEqual(expect.arrayContaining(['Texture', 'Clarity2012', 'Dehaze']))
    expect(review.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ field: '质感与去雾开关', value: '停用', message: expect.stringContaining('保持原样') }), expect.objectContaining({ field: '纹理、清晰度与去除薄雾', message: expect.stringContaining('不保证像素一致') })]))
    expect(current).toEqual(before)
  })
  it.each([true, false])('exchanges signed presence parameters with enabled=%s retained locally and explicit switch warnings', (enabled) => {
    const current = { ...defaultImageLayerColorGrade(), presence: { version: 1 as const, enabled, texture: -100, clarity: 100, dehaze: -25.5 } }
    const exported = serializeColorGradeXmp('自有质感', current), imported = parseColorGradeXmp(exported.text, current)
    expect(imported.settings).toEqual(current); expect(exported.mappedFields).toHaveLength(49)
    for (const [field, value] of [['Texture', '-100'], ['Clarity2012', '100'], ['Dehaze', '-25.5']]) expect(exported.text).toContain(`crs:${field}="${value}"`)
    expect(exported.text).not.toMatch(/EnablePresence|lutAssetId|xingmang-layer/)
    expect(exported.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ field: '质感与去雾开关', message: expect.stringContaining('JSON') })]))
    if (!enabled) expect(exported.warnings.find((entry) => entry.field === '质感与去雾开关')?.message).toContain('在其他软件导入可能启用')
  })
  it('creates presence only for mapped fields and preserves every absent value and unsupported parameter for review', () => {
    const grade = defaultImageLayerColorGrade()
    expect(parseColorGradeXmp(packet('crs:Exposure2012="1"'), grade).settings.presence).toBeUndefined()
    const created = parseColorGradeXmp(packet('crs:Texture="-60" crs:EnablePresence="False"'), grade)
    expect(created.settings.presence).toEqual({ version: 1, enabled: true, texture: -60, clarity: 0, dehaze: 0 })
    expect(created.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'EnablePresence' }), expect.objectContaining({ field: '质感与去雾开关', message: expect.stringContaining('创建并启用') })]))
    const current = { ...grade, presence: { version: 1 as const, enabled: false, texture: 60, clarity: 40, dehaze: 30 } }
    const partial = parseColorGradeXmp(packet('', '<crs:Clarity2012>-20</crs:Clarity2012>').replaceAll('crs:', 'camera:').replace('xmlns:crs=', 'xmlns:camera='), current)
    expect(partial.settings.presence).toEqual({ ...current.presence, clarity: -20 }); expect(current.presence.clarity).toBe(40)
  })
  it.each(['Texture', 'Clarity2012', 'Dehaze'])('refuses invalid and namespace-confused %s without mutating the draft', (field) => {
    const grade = defaultImageLayerColorGrade(), before = structuredClone(grade)
    for (const value of ['-101', '101', 'NaN', 'Infinity', '1e309', '', '1oops']) expect(() => parseColorGradeXmp(packet(`crs:${field}="${value}"`), grade)).toThrow(/XMP/)
    expect(() => parseColorGradeXmp(packet(`xmlns:fake="https://invalid.example/" fake:${field}="60"`), grade)).toThrow(/命名空间/)
    expect(() => parseColorGradeXmp(packet(`crs:${field}="60" crs:${field}="40"`), grade)).toThrow(/重复/)
    expect(grade).toEqual(before)
  })
  it('reads the owned reference primary calibration values while keeping unsupported optical adjustments explicit', () => {
    const text = readFileSync(new URL('./test-fixtures/reference-own-settings.xmp', import.meta.url), 'utf8'), current = defaultImageLayerColorGrade()
    current.hsl.green.hue = 12; current.vignette = -25; current.colorGrading.midtones.saturation = 17
    const before = JSON.stringify(current), review = parseColorGradeXmp(text, current)
    expect(review.settings).toMatchObject({ exposure: 1, temperature: 6500, tint: 15, vibrance: 20, vignette: -25 })
    expect(review.settings.hsl.green.hue).toBe(12)
    expect(review.settings.colorGrading.midtones.saturation).toBe(17)
    expect(review.differences.map((entry) => entry.field)).toEqual(['曝光', '色温', '色调', '自然饱和度'])
    expect(review.warnings.map((entry) => entry.field)).toEqual(expect.arrayContaining(['VignetteAmountOptical', 'VignetteAmount', '白平衡', '校准']))
    expect(review.mappedFields).toEqual(expect.arrayContaining(['RedHue', 'GreenHue', 'BlueHue']))
    expect(review.mappedFields).toContain('Clarity2012'); expect(review.warnings.map((entry) => entry.field)).not.toContain('Clarity2012')
    expect(review.mappedFields.length).toBeGreaterThan(15)
    expect(JSON.stringify(current)).toBe(before)
  })

  it('exchanges all light fields, all 24 HSL controls, four curves and confirmed split-toning fields', () => {
    const grade = defaultImageLayerColorGrade()
    Object.assign(grade, { exposure: -1.25, contrast: 12, highlights: -22, shadows: 33, whites: 44, blacks: -55, temperature: 6500, tint: -25, vibrance: 31, saturation: -11, blackWhite: true, grain: 23, vignette: -45 })
    for (const [at, channel] of imageLayerHslChannels.entries()) grade.hsl[channel] = { hue: at * 10 - 30, saturation: at * 5, luminance: at ? -at * 3 : 0 }
    for (const channel of ['rgb', 'red', 'green', 'blue'] as const) grade.curves[channel] = [{ x: 0, y: 0 }, { x: 128 / 255, y: 155 / 255 }, { x: 1, y: 1 }]
    grade.colorGrading.shadows = { hue: 240, saturation: 21, luminance: 11 }; grade.colorGrading.highlights = { hue: 40, saturation: 18, luminance: -7 }; grade.colorGrading.balance = 13
    const exported = serializeColorGradeXmp('自有 & <暖色> "预设"', grade), imported = parseColorGradeXmp(exported.text, grade)
    expect(imported.settings).toEqual(grade)
    expect(exported.mappedFields).toHaveLength(46)
    expect(exported.text).toContain('Exposure2012="-1.25"')
    expect(exported.text).toContain('<rdf:li>128, 155</rdf:li>')
    expect(exported.text).toContain('&amp; &lt;暖色&gt; &quot;预设&quot;')
    expect(exported.text).not.toContain('xingmang-layer-color-grade')
    expect(exported.text).not.toContain('ColorGradeMidtone')
    expect(exported.warnings.map((entry) => entry.field)).toEqual(expect.arrayContaining(['分级参数', '黑白与分级', '白平衡']))
    expect(imported.warnings.some((entry) => entry.message.includes('中间调、亮度、混合保持原样'))).toBe(true)
  })

  it('retains absent controls and explicitly reports unknown modern grading, grain shape and metadata', () => {
    const grade = defaultImageLayerColorGrade(); grade.colorGrading.blending = 71; grade.curves.red[0].y = .2
    const review = parseColorGradeXmp(packet('crs:Exposure2012="0.5" crs:ColorGradeMidtoneHue="72" crs:GrainSize="30" crs:Version="17"'), grade)
    expect(review.settings.colorGrading.blending).toBe(71)
    expect(review.settings.curves.red[0].y).toBe(.2)
    expect(review.warnings.map((entry) => [entry.field, entry.value])).toEqual([['ColorGradeMidtoneHue', '72'], ['GrainSize', '30'], ['Version', '17']])
  })

  it.each(['builtin', 'asset'] as const)('preserves the complete current %s LUT when importing XMP and reviews that boundary', (kind) => {
    const grade = defaultImageLayerColorGrade()
    grade.lut = { version: 1, enabled: false, strength: 0, source: kind === 'builtin' ? { kind: 'builtin', presetId: 'xm-lut-movie-tone-v1' } : { kind: 'asset', lutAssetId: 'a'.repeat(43), digest: 'b'.repeat(64), name: '自有冷调', domainMin: [-1, 0, 0], domainMax: [2, 1, 1] } }
    const before = JSON.stringify(grade), imported = parseColorGradeXmp(packet('crs:Exposure2012="1" crs:NativeLut="not-supported"'), grade)
    expect(imported.settings.lut).toEqual(grade.lut)
    expect(imported.settings.lut).not.toBe(grade.lut)
    expect(imported.settings.exposure).toBe(1)
    expect(imported.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'LUT 调色', message: expect.stringContaining('当前 LUT、开关与强度均保留') }), expect.objectContaining({ field: 'NativeLut' })]))
    expect(imported.differences.map((entry) => entry.field)).toEqual(['曝光'])
    expect(JSON.stringify(grade)).toBe(before)
  })

  it.each(['builtin', 'asset'] as const)('exports ordinary CRS parameters with an explicit JSON recommendation instead of embedding a %s LUT in XMP', (kind) => {
    const grade = defaultImageLayerColorGrade()
    grade.lut = { version: 1, enabled: true, strength: 67, source: kind === 'builtin' ? { kind: 'builtin', presetId: 'xm-lut-movie-tone-v1' } : { kind: 'asset', lutAssetId: 'a'.repeat(43), digest: 'b'.repeat(64), name: '自有冷调', domainMin: [0, 0, 0], domainMax: [1, 1, 1] } }
    const result = serializeColorGradeXmp('自有调整', grade)
    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'LUT 调色', message: expect.stringContaining('完整 JSON 调整预设') })]))
    expect(result.mappedFields).toHaveLength(46)
    expect(result.mappedFields.join(' ')).not.toMatch(/Lut|LUT/)
    expect(result.text).not.toContain('lutAssetId'); expect(result.text).not.toContain('xm-lut-'); expect(result.text).not.toContain('自有冷调')
    expect(parseColorGradeXmp(result.text, defaultImageLayerColorGrade()).settings.lut).toBeUndefined()
  })

  it('reads the six actual owned reference detail properties without inventing the four properties omitted by that export', () => {
    const text = readFileSync(new URL('./test-fixtures/reference-detail-edited.xmp', import.meta.url), 'utf8')
    const grade = defaultImageLayerColorGrade(); grade.detail = { ...defaultImageLayerColorDetail(), enabled: false, luminance: { amount: 0, detail: 29, contrast: 17 }, color: { amount: 0, detail: 31, smoothness: 19 } }
    const before = JSON.stringify(grade), review = parseColorGradeXmp(text, grade)
    expect(review.settings.detail).toEqual({ version: 1, enabled: false, sharpening: { amount: 80, radius: 1.5, detail: 40, masking: 35 }, luminance: { amount: 70, detail: 29, contrast: 17 }, color: { amount: 60, detail: 31, smoothness: 19 } })
    expect(review.mappedFields).toEqual(expect.arrayContaining(['Sharpness', 'SharpenRadius', 'SharpenDetail', 'SharpenEdgeMasking', 'LuminanceSmoothing', 'ColorNoiseReduction']))
    for (const absent of ['LuminanceNoiseReductionDetail', 'LuminanceNoiseReductionContrast', 'ColorNoiseReductionDetail', 'ColorNoiseReductionSmoothness']) expect(review.mappedFields).not.toContain(absent)
    expect(review.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ field: '细节与降噪', message: expect.stringContaining('不保证像素一致') }), expect.objectContaining({ field: '细节开关', message: expect.stringContaining('当前细节开关与未提供的参数保持原样') })]))
    expect(JSON.stringify(grade)).toBe(before)
  })
  it.each([true, false])('round trips all ten documented CRS detail values and preserves the local enabled=%s flag explicitly', (enabled) => {
    const grade = defaultImageLayerColorGrade(); grade.detail = { version: 1, enabled, sharpening: { amount: 150, radius: .5, detail: 40, masking: 35 }, luminance: { amount: 70, detail: 45, contrast: 20 }, color: { amount: 60, detail: 55, smoothness: 65 } }
    const exported = serializeColorGradeXmp('自有细节参数', grade), imported = parseColorGradeXmp(exported.text, grade)
    expect(exported.mappedFields).toHaveLength(56)
    expect(exported.text).toContain('crs:Sharpness="150"'); expect(exported.text).toContain('crs:SharpenRadius="0.5"')
    expect(exported.text).toContain('crs:LuminanceNoiseReductionDetail="45"'); expect(exported.text).toContain('crs:LuminanceNoiseReductionContrast="20"')
    expect(exported.text).toContain('crs:ColorNoiseReductionDetail="55"'); expect(exported.text).toContain('crs:ColorNoiseReductionSmoothness="65"')
    expect(exported.text).not.toContain('EnableDetail'); expect(exported.text).not.toContain('enabled=')
    expect(imported.settings).toEqual(grade)
    expect(exported.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ field: '细节开关', message: expect.stringContaining('JSON') }), expect.objectContaining({ field: '细节与降噪' })]))
    if (!enabled) expect(exported.warnings.find((entry) => entry.field === '细节开关')?.message).toContain('停用')
  })
  it('creates a visible enabled detail configuration only when a mapped property is present and reviews that creation', () => {
    const grade = defaultImageLayerColorGrade(), unchanged = parseColorGradeXmp(packet('crs:Exposure2012="1"'), grade)
    expect(unchanged.settings.detail).toBeUndefined()
    const review = parseColorGradeXmp(packet('crs:ColorNoiseReductionDetail="55" crs:EnableDetail="False"'), grade)
    expect(review.settings.detail).toEqual({ ...defaultImageLayerColorDetail(), color: { amount: 0, detail: 55, smoothness: 50 } })
    expect(review.differences).toEqual([{ field: '颜色细节', before: '50', after: '55' }])
    expect(review.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'EnableDetail' }), expect.objectContaining({ field: '细节开关', message: expect.stringContaining('确认后将创建并启用') })]))
    expect(grade.detail).toBeUndefined()
  })
  it('supports aliases and scalar child detail fields while retaining every absent value', () => {
    const grade = defaultImageLayerColorGrade(); grade.detail = defaultImageLayerColorDetail(); grade.detail.sharpening.radius = 2.75
    const text = packet('', '<crs:ColorNoiseReductionSmoothness>65</crs:ColorNoiseReductionSmoothness>').replaceAll('crs:', 'camera:').replace('xmlns:crs=', 'xmlns:camera=')
    const review = parseColorGradeXmp(text, grade)
    expect(review.settings.detail?.color.smoothness).toBe(65); expect(review.settings.detail?.sharpening.radius).toBe(2.75)
  })
  it.each([
    ['Sharpness', '-1'], ['Sharpness', '151'], ['Sharpness', '1.5'], ['SharpenRadius', '.49'], ['SharpenRadius', '3.01'],
    ['SharpenDetail', 'NaN'], ['SharpenEdgeMasking', '1e309'], ['LuminanceSmoothing', '101'], ['LuminanceNoiseReductionDetail', '-1'],
    ['LuminanceNoiseReductionContrast', '.5'], ['ColorNoiseReduction', 'Infinity'], ['ColorNoiseReductionDetail', '101'], ['ColorNoiseReductionSmoothness', '1oops'],
  ])('rejects malformed or nonrepresentable detail %s=%s without changing the draft', (field, value) => {
    const grade = defaultImageLayerColorGrade(), before = JSON.stringify(grade)
    expect(() => parseColorGradeXmp(packet(`crs:${field}="${value}"`), grade)).toThrow(/XMP/)
    expect(JSON.stringify(grade)).toBe(before)
  })
  it('rejects duplicate or namespace-confused detail attributes and rejects lossy integer exports', () => {
    expect(() => parseColorGradeXmp(packet('crs:ColorNoiseReductionDetail="1" crs:ColorNoiseReductionDetail="2"'), defaultImageLayerColorGrade())).toThrow(/XMP/)
    expect(() => parseColorGradeXmp(packet('xmlns:fake="https://example.invalid/" fake:LuminanceNoiseReductionDetail="10"'), defaultImageLayerColorGrade())).toThrow(/命名空间/)
    const grade = defaultImageLayerColorGrade(); grade.detail = defaultImageLayerColorDetail(); grade.detail.color.smoothness = 50.5
    expect(() => serializeColorGradeXmp('自有', grade)).toThrow(/整数|JSON/)
  })

  it('accepts namespace aliases, scalar child properties, XML entities and xpacket wrappers without resolving anything', () => {
    const text = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>${packet('', '<crs:Exposure2012>+1.25</crs:Exposure2012><crs:Note>own &amp; &#x4e2d; &quot;test&quot;</crs:Note>').replaceAll('crs:', 'camera:').replace('xmlns:crs=', 'xmlns:camera=')}<?xpacket end="w"?>`
    const review = parseColorGradeXmp(text, defaultImageLayerColorGrade())
    expect(review.settings.exposure).toBe(1.25)
    expect(review.warnings[0].value).toBe('own & 中 "test"')
  })

  it.each(['NaN', 'Infinity', '-Infinity', '1oops', '', '5', '-4.1', '1e309'])('rejects invalid or locally unrepresentable exposure %s without clipping', (value) => {
    expect(() => parseColorGradeXmp(packet(`crs:Exposure2012="${value}"`), defaultImageLayerColorGrade())).toThrow(/XMP/)
  })
  it.each(['0', '-20', '15000'])('does not invent relative-temperature conversion for %s', (value) => {
    expect(() => parseColorGradeXmp(packet(`crs:Temperature="${value}"`), defaultImageLayerColorGrade())).toThrow(/本地支持范围/)
  })
  it.each(['Truee', 'TRUE', '2'])('rejects malformed grayscale switch %s', (value) => {
    expect(() => parseColorGradeXmp(packet(`crs:ConvertToGrayscale="${value}"`), defaultImageLayerColorGrade())).toThrow(/布尔/)
  })
  it.each([
    ['0, 0', '128, 200', '255, 255', '260, 1'], ['0, 0', '128, 40', '128, 50', '255, 255'], ['1, 0', '255, 255'], ['0, 0', '255, NaN'], ['0 0', '255, 255'], ['0, 0', '255, 255, 0'], Array.from({ length: 17 }, (_, at) => `${at * 255 / 16}, 0`),
  ])('rejects unsupported or malformed curves without dropping points: %j', (...points) => {
    expect(() => parseColorGradeXmp(packet('', curve(points)), defaultImageLayerColorGrade())).toThrow(/XMP/)
  })
  it('reviews curve quantization and refuses collapsed integer coordinates', () => {
    const grade = defaultImageLayerColorGrade(); grade.curves.rgb = [{ x: 0, y: 0 }, { x: .5, y: .7 }, { x: 1, y: 1 }]
    expect(serializeColorGradeXmp('Own', grade).warnings.some((entry) => entry.message.includes('四舍五入'))).toBe(true)
    grade.curves.rgb.splice(1, 0, { x: .0001, y: .2 })
    expect(() => serializeColorGradeXmp('Own', grade)).toThrow(/重合/)
  })
  it('rejects input with no mapped adjustments instead of presenting a successful import', () => {
    expect(() => parseColorGradeXmp(packet('crs:ProcessVersion="6.0"'), defaultImageLayerColorGrade())).toThrow(/没有本工具可映射/)
  })
  it.each(['', 'name\u0001', 'name\ud800', 'name\ufffe'])('does not export an invalid XML title: %s', (name) => {
    expect(() => serializeColorGradeXmp(name, defaultImageLayerColorGrade())).toThrow(/XMP/)
  })
})

describe('bounded offline XMP XML reader', () => {
  it.each([
    '<!DOCTYPE x [<!ENTITY p SYSTEM "file:///etc/passwd">]>', '<!ENTITY a "test">', '<?xml-stylesheet href="https://example.invalid/a"?>', '<?xpacket begin="a" begin="b"?>',
  ])('rejects declarations and external processing instructions: %s', (prefix) => { expect(() => parseColorGradeXmpXml(prefix + packet('crs:Exposure2012="1"'))).toThrow(/XMP/) })
  it.each([
    packet('crs:Exposure2012="1" crs:Exposure2012="2"'), packet('xmlns:other="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="1" other:Exposure2012="2"'),
    packet('crs:Exposure2012="1"', '<crs:Exposure2012>2</crs:Exposure2012>'), packet('crs:Exposure2012="1"', '<crs:Exposure2012 xmlns:crs="https://evil.invalid/">2</crs:Exposure2012>'),
    packet('crs:Exposure2012="1"').replace('http://ns.adobe.com/camera-raw-settings/1.0/', 'https://evil.invalid/'),
    packet('xmlns:fake="https://evil.invalid/" fake:Exposure2012="1"'), packet('rdf:resource="https://example.invalid/a" crs:Exposure2012="1"'),
    packet('crs:Exposure2012="1"', '<other:include xmlns:other="http://www.w3.org/2001/XInclude" href="file:///tmp/a"/>'),
    packet('xml:base="https://example.invalid/" crs:Exposure2012="1"'), packet('crs:Exposure2012="&unknown;"'), packet('crs:Exposure2012="&#0;"'),
    packet('crs:Exposure2012="1"').replace('rdf:about=""', 'rdf:about="https://example.invalid/a"'), packet('crs:Exposure2012="1"') + '<second/>',
  ])('rejects duplicate, namespace-confused or externally referenced input', (text) => { expect(() => parseColorGradeXmp(text, defaultImageLayerColorGrade())).toThrow(/XMP/) })
  it('enforces byte, depth, element, attribute and valid-character limits', () => {
    expect(() => parseColorGradeXmpXml('中'.repeat(maximumColorGradeXmpBytes / 2))).toThrow(/64 KiB/)
    expect(() => parseColorGradeXmpXml('<a>'.repeat(17) + '</a>'.repeat(17))).toThrow(/深度/)
    expect(() => parseColorGradeXmpXml(`<a>${'<b/>'.repeat(513)}</a>`)).toThrow(/数量/)
    expect(() => parseColorGradeXmpXml(`<a ${Array.from({ length: 257 }, (_, at) => `k${at}="1"`).join(' ')}/>`)).toThrow(/数量/)
    expect(() => parseColorGradeXmpXml('<a>\u0001</a>')).toThrow(/字符/)
    expect(() => parseColorGradeXmpXml('<a>\ud800</a>')).toThrow(/字符/)
  })
})
