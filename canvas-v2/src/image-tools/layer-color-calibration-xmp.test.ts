import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { defaultImageLayerColorCalibration } from './layer-color-calibration'
import { defaultImageLayerColorGrade } from './layer-color-grade'
import { parseColorGradeXmp, serializeColorGradeXmp } from './layer-color-grade-xmp'

const mappings = [['ShadowTint', 'shadowTint'], ['RedHue', 'redHue'], ['RedSaturation', 'redSaturation'], ['GreenHue', 'greenHue'], ['GreenSaturation', 'greenSaturation'], ['BlueHue', 'blueHue'], ['BlueSaturation', 'blueSaturation']] as const
function packet(properties: string, namespace = 'http://ns.adobe.com/camera-raw-settings/1.0/') { return `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:crs="${namespace}" ${properties}/></rdf:RDF></x:xmpmeta>` }

describe('bounded CRS calibration intent exchange', () => {
  it('maps six primary values from the actual owned export and preserves the target shadow tint omitted by that file', () => {
    const text = readFileSync(new URL('./test-fixtures/calibration-combined.xmp', import.meta.url), 'utf8')
    expect(text).not.toContain('crs:ShadowTint='); expect(text).not.toContain('crs:ProcessVersion=')
    const current = { ...defaultImageLayerColorGrade(), calibration: { ...defaultImageLayerColorCalibration(), enabled: false, shadowTint: -60 } }, before = structuredClone(current), review = parseColorGradeXmp(text, current)
    expect(review.settings.calibration).toEqual({ version: 1, enabled: false, shadowTint: -60, redHue: 40, redSaturation: -30, greenHue: -35, greenSaturation: 20, blueHue: 30, blueSaturation: -25 })
    expect(review.mappedFields).toEqual(expect.arrayContaining(['RedHue', 'RedSaturation', 'GreenHue', 'GreenSaturation', 'BlueHue', 'BlueSaturation'])); expect(review.mappedFields).not.toContain('ShadowTint')
    expect(review.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ field: '校准开关', value: '停用' })])); expect(current).toEqual(before)
  })
  it('supports Adobe-defined ShadowTint independently of the reference export and creates defaults only on mapped calibration input', () => {
    const current = defaultImageLayerColorGrade(), review = parseColorGradeXmp(packet('crs:ShadowTint="-75"'), current)
    expect(review.settings.calibration).toEqual({ ...defaultImageLayerColorCalibration(), shadowTint: -75 })
    expect(review.mappedFields).toEqual(['ShadowTint']); expect(review.differences).toEqual([{ field: '阴影色调', before: '0', after: '-75' }])
    expect(review.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ field: '校准开关', message: expect.stringContaining('创建并启用') })])); expect(current.calibration).toBeUndefined()
    expect(parseColorGradeXmp(packet('crs:Exposure2012="1"'), current).settings.calibration).toBeUndefined()
  })
  it('round trips seven integer intents and warns that XMP does not carry the disabled flag or a processing version', () => {
    const calibration = { ...defaultImageLayerColorCalibration(), enabled: false, shadowTint: 25, redHue: 40, redSaturation: -30, greenHue: -35, greenSaturation: 20, blueHue: 30, blueSaturation: -25 }, exported = serializeColorGradeXmp('校准原稿', { ...defaultImageLayerColorGrade(), calibration })
    for (const [field, key] of mappings) expect(exported.text).toContain(`crs:${field}="${calibration[key]}"`)
    expect(exported.text).not.toContain('crs:ProcessVersion='); expect(exported.text).not.toContain('CalibrationEnabled')
    expect(exported.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ field: '校准开关', value: '停用', message: expect.stringContaining('在其他软件导入可能启用') })]))
    expect(parseColorGradeXmp(exported.text, { ...defaultImageLayerColorGrade(), calibration: defaultImageLayerColorCalibration() }).settings.calibration).toEqual({ ...calibration, enabled: true })
    const version = parseColorGradeXmp(packet('crs:RedHue="40" crs:ProcessVersion="6.0"'), defaultImageLayerColorGrade())
    expect(version.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'ProcessVersion', message: expect.stringContaining('不支持') })]))
  })
  it.each(mappings)('rejects invalid or ambiguous %s without mutating the draft or silently clipping it', (field, key) => {
    const current = { ...defaultImageLayerColorGrade(), calibration: { ...defaultImageLayerColorCalibration(), enabled: false, shadowTint: 25 } }, original = structuredClone(current)
    for (const value of ['101', '-101', 'NaN', 'Infinity', '0.5']) expect(() => parseColorGradeXmp(packet(`crs:${field}="${value}"`), current)).toThrow()
    expect(() => parseColorGradeXmp(packet(`crs:${field}="20" crs:${field}="30"`), current)).toThrow('重复')
    expect(() => parseColorGradeXmp(packet(`crs:${field}="20"`, 'https://example.invalid/wrong-crs'), current)).toThrow('混淆')
    expect(() => serializeColorGradeXmp('保留精度', { ...current, calibration: { ...current.calibration, [key]: .5 } })).toThrow('整数')
    expect(current).toEqual(original)
  })
})
