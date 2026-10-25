import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { createFixtureServer } from '../../../../e2e/harness.mjs'
import { openFixturePage } from '../../../../e2e/fixture-readiness.mjs'

// 拼片引擎在真浏览器里跑：WebCodecs 编解码、后台线程、MP4 读写都只有浏览器里才有，
// node 里的单元测试只核得了纯计算那一半。片段是页面现做的纯色视频，不碰网络。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
let server, browser, base
before(async () => {
  ;({ server, origin: base } = await createFixtureServer({ root, configFile: false }))
  browser = await chromium.launch({ headless: true, executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function open() {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/*', async (route) => { if (new URL(route.request().url()).hostname !== '127.0.0.1') return route.abort(); await route.continue() })
  await openFixturePage(page, `${base}/src/renderer-v2/features/video-studio/browser-fixture.html`,
    (timeout) => page.waitForFunction(() => Boolean(window.videoStudioHarness), null, { timeout }), { label: 'video studio fixture' })
  return { page, errors }
}

function near(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`)
}

function closeColor(actual, expected, label) {
  for (const [index, channel] of expected.entries()) near(actual[index], channel, 40, `${label} channel ${index}`)
}

test('joins clips of different sizes, rates and audio into one MP4 with a caption', async () => {
  const { page, errors } = await open()
  const summary = await page.evaluate(async () => {
    const harness = window.videoStudioHarness
    const clips = await harness.sampleClips()
    const result = await harness.compose({ clips, options: { aspect: '16:9', resolution: 480, fit: 'cover', frameRate: 30 } })
    const inspected = await harness.inspect(result.data, {
      colors: [{ time: 0.5, x: 427, y: 200 }, { time: 1.75, x: 427, y: 240 }, { time: 3, x: 427, y: 240 }],
      bright: [{ time: 0.5, top: 405, bottom: 450 }, { time: 3, top: 405, bottom: 450 }],
      loudness: [{ from: 0.2, to: 0.8 }, { from: 1.3, to: 2.3 }, { from: 2.7, to: 3.3 }],
    })
    const stages = [...new Set(result.progress.map((item) => item.stage))]
    const ratios = result.progress.map((item) => item.ratio)
    return { result: { ...result, data: result.data.byteLength, progress: undefined }, inspected, stages, lastRatio: ratios.at(-1), sorted: ratios.every((value, index) => index === 0 || value >= ratios[index - 1]) }
  })
  assert.deepEqual(errors, [])
  assert.equal(summary.result.width, 854)
  assert.equal(summary.result.height, 480)
  assert.equal(summary.result.duration, 3.5)
  assert.ok(summary.result.data > 1000, 'the MP4 must hold data')
  assert.ok(['avc', 'vp9', 'av1'].includes(summary.result.videoCodec), summary.result.videoCodec)
  assert.ok(['aac', 'opus'].includes(summary.result.audioCodec), summary.result.audioCodec)
  assert.match(summary.result.mimeType, /^video\/mp4/)
  assert.deepEqual(summary.stages, ['reading', 'rendering', 'finishing'])
  assert.equal(summary.lastRatio, 1)
  assert.equal(summary.sorted, true)

  const { inspected } = summary
  assert.equal(inspected.width, 854)
  assert.equal(inspected.height, 480)
  assert.equal(inspected.videoCodec, summary.result.videoCodec)
  assert.equal(inspected.packetCount, 105)
  near(inspected.videoDuration, 3.5, 0.04, 'video duration')
  assert.equal(inspected.audioSampleRate, 48000)
  assert.equal(inspected.audioChannels, 2)
  near(inspected.audioDuration, 3.5, 0.08, 'audio duration')
  closeColor(inspected.colors[0], [255, 0, 0], 'first clip')
  closeColor(inspected.colors[1], [0, 0, 255], 'second clip')
  closeColor(inspected.colors[2], [0, 255, 0], 'third clip')
  assert.ok(inspected.bright[0] > 50, `the caption must be burnt into the first clip (${inspected.bright[0]} bright pixels)`)
  assert.equal(inspected.bright[1], 0, 'the third clip has no caption')
  assert.ok(inspected.loudness[0] > 0.1, `the first clip keeps its tone (${inspected.loudness[0]})`)
  assert.ok(inspected.loudness[1] < 0.01, `the silent clip stays silent (${inspected.loudness[1]})`)
  assert.ok(inspected.loudness[2] > 0.1, `the mono clip plays on the left channel too (${inspected.loudness[2]})`)
  await page.close()
})

test('letterboxes instead of cropping when asked to contain, and honours trims', async () => {
  const { page, errors } = await open()
  const summary = await page.evaluate(async () => {
    const harness = window.videoStudioHarness
    const clips = [
      { data: await harness.makeClip({ width: 240, height: 320, frameRate: 30, seconds: 2, color: '#0000ff' }), trimStart: 0.5, trimEnd: 0.5 },
    ]
    const result = await harness.compose({ clips, options: { aspect: '16:9', resolution: 480, fit: 'contain', frameRate: 25 } })
    return { duration: result.duration, audioCodec: result.audioCodec, inspected: await harness.inspect(result.data, { colors: [{ time: 0.5, x: 20, y: 240 }, { time: 0.5, x: 427, y: 240 }] }) }
  })
  assert.deepEqual(errors, [])
  assert.equal(summary.duration, 1)
  assert.equal(summary.audioCodec, null, 'no clip has sound, so the film has no audio track')
  assert.equal(summary.inspected.audioCodec, null)
  assert.equal(summary.inspected.packetCount, 25)
  closeColor(summary.inspected.colors[0], [0, 0, 0], 'letterbox')
  closeColor(summary.inspected.colors[1], [0, 0, 255], 'picture')
  await page.close()
})

test('runs the same job in a background worker and follows a codec preference', async () => {
  const { page, errors } = await open()
  const summary = await page.evaluate(async () => {
    const harness = window.videoStudioHarness
    const clips = await harness.sampleClips()
    const lengths = clips.map((clip) => clip.data.byteLength)
    const result = await harness.compose({ clips, options: { aspect: '9:16', resolution: 480, fit: 'cover', frameRate: 24 }, encoding: { video: ['vp9'], audio: ['opus'] } }, { worker: true })
    const transferred = clips.map((clip) => clip.data.byteLength)
    const inspected = await harness.inspect(result.data, { colors: [{ time: 2, x: 240, y: 427 }] })
    return { lengths, transferred, result: { ...result, data: result.data.byteLength, progress: result.progress.length }, inspected }
  })
  assert.deepEqual(errors, [])
  assert.ok(summary.lengths.every((length) => length > 0))
  assert.deepEqual(summary.transferred, [0, 0, 0], 'the clip bytes move to the worker instead of being copied')
  assert.equal(summary.result.width, 480)
  assert.equal(summary.result.height, 854)
  assert.equal(summary.result.videoCodec, 'vp9')
  assert.equal(summary.result.audioCodec, 'opus')
  assert.equal(summary.inspected.videoCodec, 'vp9')
  assert.equal(summary.inspected.audioCodec, 'opus')
  assert.equal(summary.inspected.packetCount, 84)
  assert.ok(summary.result.progress > 0, 'the worker reports progress back to the page')
  closeColor(summary.inspected.colors[0], [0, 0, 255], 'second clip in portrait')
  await page.close()
})

test('stops promptly when cancelled, in the page and in the worker', async () => {
  const { page, errors } = await open()
  const summary = await page.evaluate(async () => {
    const harness = window.videoStudioHarness
    const make = () => harness.makeClip({ width: 320, height: 240, frameRate: 30, seconds: 2, color: '#ff0000' })
    const options = { aspect: '16:9', resolution: 480, fit: 'cover', frameRate: 30 }
    return {
      page: await harness.failure(async () => harness.compose({ clips: [{ data: await make() }], options }, { abortAt: 0.3 })),
      worker: await harness.failure(async () => harness.compose({ clips: [{ data: await make() }], options }, { abortAt: 0.3, worker: true })),
    }
  })
  assert.deepEqual(errors, [])
  assert.equal(summary.page.name, 'AbortError')
  assert.equal(summary.worker.name, 'AbortError')
  await page.close()
})

test('explains which clip it cannot read', async () => {
  const { page, errors } = await open()
  const summary = await page.evaluate(async () => {
    const harness = window.videoStudioHarness
    const good = await harness.makeClip({ width: 320, height: 240, frameRate: 30, seconds: 1, color: '#ff0000' })
    const junk = new TextEncoder().encode('not a video at all').buffer
    const options = { aspect: '16:9', resolution: 480, fit: 'cover', frameRate: 30 }
    return {
      page: await harness.failure(() => harness.compose({ clips: [{ data: good.slice(0) }, { data: junk.slice(0) }], options })),
      worker: await harness.failure(() => harness.compose({ clips: [{ data: good }, { data: junk }], options }, { worker: true })),
      tooShort: await harness.failure(async () => harness.compose({ clips: [{ data: await harness.makeClip({ width: 320, height: 240, frameRate: 30, seconds: 1, color: '#ff0000' }), trimStart: 0.9 }], options })),
    }
  })
  assert.deepEqual(errors, [])
  assert.deepEqual(summary.page, { name: 'VideoStudioError', message: '第 2 段不是能读的视频文件（支持 MP4、MOV、WebM）' })
  assert.equal(summary.worker.message, '第 2 段不是能读的视频文件（支持 MP4、MOV、WebM）')
  assert.equal(summary.tooShort.message, '第 1 段剪掉首尾后不到 0.2 秒，没法用')
  await page.close()
})
