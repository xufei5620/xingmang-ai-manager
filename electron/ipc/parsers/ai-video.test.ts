import { describe, expect, it } from 'vitest'
import { parseCanvasVideoGenerateInput } from '../../canvas-request-parser'
import {
  maximumVideoStudioExportBytes,
  parseAiVideoAssetId,
  parseAiVideoGenerateInput,
  parseVideoStudioExportBytes,
  parseVideoStudioPlanInput,
} from './ai-video'

const assetA = 'A'.repeat(43)
const assetB = 'B'.repeat(43)
const generate = { requestId: 'video-1', group: '视频分组', model: 'grok-video', prompt: '海浪\n远处有船', seconds: '6' }
const plan = { requestId: 'plan-1', group: '文字分组', model: 'gpt-6-astra', idea: '一只猫\n回家', shotCount: 4, secondsPerShot: 6, aspect: '16:9', captions: true }

describe('main window video request parsers', () => {
  it('accepts what the chat and video studio pages send, reference images included', () => {
    expect(parseAiVideoGenerateInput({ ...generate, imageAssetIds: [assetA, assetB], width: 720, height: 1280 })).toEqual({
      ...generate, imageAssetIds: [assetA, assetB], width: 720, height: 1280,
    })
    expect(parseAiVideoGenerateInput({ ...generate, mode: 'i2va', resolution: '720p', aspectRatio: '9:16', promptOptimization: false }))
      .toMatchObject({ mode: 'i2va', resolution: '720p', aspectRatio: '9:16', promptOptimization: false })
  })

  it('refuses the canvas-only references, account fields and bad values with the main window wording', () => {
    for (const [input, message] of [
      [null, '视频请求格式错误'],
      [{ ...generate, imageAssetId: assetA }, '视频请求包含未知字段'],
      [{ ...generate, videoAssetIds: [assetA] }, '视频请求包含未知字段'],
      [{ ...generate, audioAssetIds: [assetA] }, '视频请求包含未知字段'],
      [{ ...generate, expectedUserId: 9 }, '视频请求包含未知字段'],
      [{ ...generate, projectId: 'p' }, '视频请求包含未知字段'],
      [{ ...generate, imageAssetIds: ['../a'] }, '视频参考图片资产标识格式错误'],
      [{ ...generate, imageAssetIds: [assetA, assetA] }, '视频参考图片不能重复'],
      [{ ...generate, imageAssetIds: Array.from({ length: 10 }, (_, index) => `${index}`.padEnd(43, 'x')) }, '视频参考图片数量格式错误'],
      [{ ...generate, seconds: '16' }, '视频时长必须是 1-15 秒的整数'],
      [{ ...generate, width: 720 }, '视频比例不受支持'],
      [{ ...generate, mode: 'auto' }, 'MiniMax 生成模式不受支持'],
      [{ ...generate, resolution: '1080p' }, 'MiniMax 分辨率不受支持'],
      [{ ...generate, promptOptimization: 'yes' }, 'MiniMax 提示词优化开关格式错误'],
      [{ ...generate, prompt: '海浪\x1B' }, '视频提示词格式错误'],
      [{ ...generate, model: 'm'.repeat(129) }, '视频模型格式错误'],
    ] as const) {
      expect(() => parseAiVideoGenerateInput(input), JSON.stringify(input)).toThrow(message)
    }
  })

  it('keeps the canvas wording and its extra references after sharing the parser', () => {
    expect(parseCanvasVideoGenerateInput({ ...generate, imageAssetId: assetA, videoAssetIds: [assetB] }))
      .toEqual({ ...generate, imageAssetId: assetA, videoAssetIds: [assetB] })
    expect(() => parseCanvasVideoGenerateInput({ ...generate, extra: 1 })).toThrow('画布视频请求包含未知字段')
    expect(() => parseCanvasVideoGenerateInput({ ...generate, seconds: '0' })).toThrow('画布视频时长必须是 1-15 秒的整数')
    expect(() => parseCanvasVideoGenerateInput({ ...generate, mode: 'auto' })).toThrow('画布 MiniMax 生成模式不受支持')
  })

  it('reads a storyboard request and refuses anything outside its limits', () => {
    expect(parseVideoStudioPlanInput(plan)).toEqual(plan)
    for (const [input, message] of [
      [[], '分镜请求格式错误'],
      [{ ...plan, userId: 1 }, '分镜请求包含未知字段'],
      [{ ...plan, idea: '   ' }, '想法要写 1 到 2000 个字'],
      [{ ...plan, idea: '猫'.repeat(2_001) }, '想法要写 1 到 2000 个字'],
      [{ ...plan, idea: '猫\x07' }, '想法要写 1 到 2000 个字'],
      [{ ...plan, shotCount: 0 }, '镜头数要在 1 到 12 个之间'],
      [{ ...plan, shotCount: 13 }, '镜头数要在 1 到 12 个之间'],
      [{ ...plan, shotCount: 2.5 }, '镜头数要在 1 到 12 个之间'],
      [{ ...plan, secondsPerShot: 16 }, '每个镜头要在 1 到 15 秒之间'],
      [{ ...plan, aspect: '4:3' }, '成片画面比例不受支持'],
      [{ ...plan, captions: 'yes' }, '字幕开关格式错误'],
      [{ ...plan, requestId: '' }, '分镜请求标识格式错误'],
    ] as const) {
      expect(() => parseVideoStudioPlanInput(input), JSON.stringify(input)).toThrow(message)
    }
  })

  it('takes only well-formed asset ids', () => {
    expect(parseAiVideoAssetId(assetA)).toBe(assetA)
    for (const value of ['../../etc/passwd', `${assetA}x`, 42, undefined]) {
      expect(() => parseAiVideoAssetId(value)).toThrow('视频编号格式错误')
    }
  })

  it('takes the composed film as bytes without copying and refuses empty, oversize or non-byte input', () => {
    const bytes = new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112])
    const parsed = parseVideoStudioExportBytes(bytes)
    expect(Buffer.isBuffer(parsed)).toBe(true)
    expect(parsed.buffer).toBe(bytes.buffer)
    expect([...parseVideoStudioExportBytes(bytes.buffer)]).toEqual([...bytes])
    expect(() => parseVideoStudioExportBytes(new Uint8Array())).toThrow('成片是空的，请重新导出')
    expect(() => parseVideoStudioExportBytes('ftyp')).toThrow('成片内容格式错误')
    expect(() => parseVideoStudioExportBytes([1, 2, 3])).toThrow('成片内容格式错误')
    // A real 512 MB buffer is too much for a unit test; only the length is read before refusing.
    const oversize = { byteLength: maximumVideoStudioExportBytes + 1 }
    Object.setPrototypeOf(oversize, Uint8Array.prototype)
    expect(() => parseVideoStudioExportBytes(oversize)).toThrow('成片超过 512 MB')
  })
})
