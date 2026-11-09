import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { createFixtureServer } from '../../../../e2e/harness.mjs'
import { fixtureReadyTimeoutMs, openFixturePage } from '../../../../e2e/fixture-readiness.mjs'

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

test('drops the hidden lead-in of a clip whose first frames are stamped before zero', async () => {
  const { page, errors } = await open()
  const summary = await page.evaluate(async () => {
    const harness = window.videoStudioHarness
    const data = await harness.makeClip({ width: 320, height: 240, frameRate: 30, seconds: 1, color: '#0000ff', tone: { frequency: 440, channels: 2 }, lead: { seconds: 0.25, color: '#ff0000' } })
    const source = await harness.inspect(data.slice(0), { colors: [{ time: 0.1, x: 160, y: 120 }] })
    const result = await harness.compose({ clips: [{ data }], options: { aspect: '16:9', resolution: 480, fit: 'cover', frameRate: 30 } })
    return {
      source,
      duration: result.duration,
      inspected: await harness.inspect(result.data, { colors: [{ time: 0.1, x: 427, y: 240 }], loudness: [{ from: 0.02, to: 0.2 }] }),
    }
  })
  assert.deepEqual(errors, [])
  // 原片在播放器里 0.1 秒就是蓝的：红的那几帧藏在 0 之前。
  closeColor(summary.source.colors[0], [0, 0, 255], 'source at 0.1s')
  assert.equal(summary.duration, 1)
  assert.equal(summary.inspected.packetCount, 30)
  closeColor(summary.inspected.colors[0], [0, 0, 255], 'film at 0.1s')
  assert.ok(summary.inspected.loudness[0] > 0.1, `the sound starts with the picture (${summary.inspected.loudness[0]})`)
  await page.close()
})

test('dips to black between shots and fades out at the end, picture and sound together', async () => {
  const { page, errors } = await open()
  const summary = await page.evaluate(async () => {
    const harness = window.videoStudioHarness
    const toned = (color) => harness.makeClip({ width: 320, height: 240, frameRate: 30, seconds: 2, color, tone: { frequency: 440, channels: 2 } })
    const options = { aspect: '16:9', resolution: 480, fit: 'cover', frameRate: 30 }
    const clips = async () => [{ data: await toned('#ff0000') }, { data: await toned('#0000ff') }]
    const faded = await harness.compose({ clips: await clips(), options: { ...options, transition: 'fade', fadeOut: true } }, { worker: true })
    const cut = await harness.compose({ clips: await clips(), options })
    const probe = {
      // 第一段中间、换段前最后一帧、换段后第一帧、第二段中间、片尾最后一帧。
      colors: [{ time: 1, x: 427, y: 240 }, { time: 1.98, x: 427, y: 240 }, { time: 2.02, x: 427, y: 240 }, { time: 3, x: 427, y: 240 }, { time: 3.98, x: 427, y: 240 }],
      loudness: [{ from: 0.5, to: 1.5 }, { from: 1.96, to: 2.04 }, { from: 3.94, to: 4 }],
    }
    return { duration: faded.duration, faded: await harness.inspect(faded.data, probe), cut: await harness.inspect(cut.data, probe) }
  })
  assert.deepEqual(errors, [])
  near(summary.duration, 4, 0.01, 'fades do not change the length')
  const [middle, beforeCut, afterCut, second, end] = summary.faded.colors
  closeColor(middle, [255, 0, 0], 'first shot in full')
  closeColor(beforeCut, [0, 0, 0], 'first shot has dipped to black')
  closeColor(afterCut, [0, 0, 0], 'second shot comes up from black')
  closeColor(second, [0, 0, 255], 'second shot in full')
  closeColor(end, [0, 0, 0], 'the film fades out')
  const [loud, atCut, atEnd] = summary.faded.loudness
  assert.ok(atCut < loud / 3, `the sound dips with the picture between shots (${loud} → ${atCut})`)
  assert.ok(atEnd < loud / 5, `the sound fades out with the film (${loud} → ${atEnd})`)
  // Without fades the old straight cut stays exactly as it was.
  closeColor(summary.cut.colors[1], [255, 0, 0], 'straight cut keeps the last frame')
  closeColor(summary.cut.colors[4], [0, 0, 255], 'no fade at the end unless asked')
  assert.ok(summary.cut.loudness[2] > summary.cut.loudness[0] / 2, 'no sound fade unless asked')
  await page.close()
})

test('lays a song under the film, starts it over when it runs out and fades it out at the end', async () => {
  const { page, errors } = await open()
  const summary = await page.evaluate(async () => {
    const harness = window.videoStudioHarness
    const options = { aspect: '16:9', resolution: 480, fit: 'cover', frameRate: 30 }
    const silent = () => harness.makeClip({ width: 320, height: 240, frameRate: 30, seconds: 2, color: '#0000ff' })
    const toned = () => harness.makeClip({ width: 320, height: 240, frameRate: 30, seconds: 2, color: '#ff0000', tone: { frequency: 440, channels: 2 } })
    // 两段没声音的片段（共 4 秒）、一首 1.5 秒的歌：歌放两遍多，最后 2 秒淡出。
    const withMusic = await harness.compose({ clips: [{ data: await silent() }, { data: await silent() }], options, music: { data: await harness.makeSong(1.5), gain: 0.8 }, clipGain: 0.3 }, { worker: true })
    // 不要原声、也没配乐：成片不带声音。
    const muted = await harness.compose({ clips: [{ data: await toned() }], options, clipGain: 0 })
    // 原声调小：还在，只是轻了。
    const quiet = await harness.compose({ clips: [{ data: await toned() }], options, clipGain: 0.3 })
    const loud = await harness.compose({ clips: [{ data: await toned() }], options })
    const unreadable = await harness.failure(async () => harness.compose({ clips: [{ data: await silent() }], options, music: { data: new TextEncoder().encode('not a song').buffer, gain: 0.8 } }))
    return {
      withMusic: { audioCodec: withMusic.audioCodec, inspected: await harness.inspect(withMusic.data, { loudness: [{ from: 0.2, to: 1.2 }, { from: 1.6, to: 1.9 }, { from: 3.85, to: 3.98 }] }) },
      muted: { audioCodec: muted.audioCodec },
      quiet: (await harness.inspect(quiet.data, { loudness: [{ from: 0.5, to: 1 }] })).loudness[0],
      loud: (await harness.inspect(loud.data, { loudness: [{ from: 0.5, to: 1 }] })).loudness[0],
      unreadable,
    }
  })
  assert.deepEqual(errors, [])
  assert.ok(['aac', 'opus'].includes(summary.withMusic.audioCodec), 'a film of silent clips gets a sound track once it has a song')
  const [first, again, last] = summary.withMusic.inspected.loudness
  assert.ok(first > 0.15, `the song plays from the start (${first})`)
  assert.ok(again > 0.15, `the song starts over after 1.5 seconds (${again})`)
  assert.ok(last < first / 5, `the song has all but faded out by the very end (${first} → ${last})`)
  assert.equal(summary.muted.audioCodec, null, 'with the clip sound off and no song there is nothing to hear')
  assert.ok(summary.quiet > 0.05 && summary.quiet < summary.loud * 0.5, `turning the clip sound down keeps it, quieter (${summary.quiet} vs ${summary.loud})`)
  assert.equal(summary.unreadable.message, '这首歌读不出来，换一首试试（支持 MP3、M4A、WAV、OGG）')
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

// —— 视频剪辑页 ——
// 页面接假的主进程桥（page-fixture.tsx），片段用上面那套现做的纯色视频，拼片走真的后台线程。

async function openStudio(search = '') {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/*', async (route) => { if (new URL(route.request().url()).hostname !== '127.0.0.1') return route.abort(); await route.continue() })
  await openFixturePage(page, `${base}/src/renderer-v2/features/video-studio/page-fixture.html${search}`,
    (timeout) => page.getByTestId('video-idea-input').waitFor({ timeout }), { label: 'video studio page' })
  // 模型表读完、两个模型都落定了才算打开好。
  await page.locator('[data-testid="video-text-model"][data-model="gpt-5.6-sol"]').waitFor()
  await page.locator('[data-testid="video-video-model"][data-model="grok-imagine-video-1.5"]').waitFor()
  return { page, errors }
}

function studioCalls(page, method) {
  return page.evaluate((name) => window.videoStudioPage.calls.filter((call) => call.method === name).map((call) => call.input), method)
}

async function writeStoryboard(page, idea, plan) {
  await page.getByTestId('video-idea-input').fill(idea)
  await page.getByTestId('video-shot-count').selectOption(String(plan.shots.length))
  await page.getByTestId('video-plan').click()
  await page.getByTestId('video-plan-stop').waitFor()
  await page.evaluate((value) => window.videoStudioPage.finishPlan(value), plan)
  await page.getByTestId(`video-shot-${plan.shots.length - 1}`).waitFor()
}

test('writes a storyboard, generates every shot and joins them into one film', async () => {
  const { page, errors } = await openStudio()
  await writeStoryboard(page, '一只橘猫在雨夜找回家的路', { title: '回家的猫', shots: [{ prompt: '红色的街', caption: 'Hello 星芒' }, { prompt: '蓝色的雨' }, { prompt: '绿色的门', caption: '到家了' }] })
  const [plan] = await studioCalls(page, 'plan')
  assert.deepEqual({ ...plan, requestId: typeof plan.requestId }, {
    requestId: 'string', group: 'GPT', model: 'gpt-5.6-sol', idea: '一只橘猫在雨夜找回家的路', shotCount: 3, secondsPerShot: 6, aspect: '9:16', captions: true,
  })
  assert.match(await page.getByTestId('video-shots').textContent(), /回家的猫.*3 个镜头 · 每段 6 秒 · 共约 18 秒/)

  // 把绿色那一镜挪到第二个。
  await page.getByTestId('video-shot-up-2').click()
  assert.equal(await page.getByTestId('video-shot-prompt-1').inputValue(), '绿色的门')

  await page.getByTestId('video-generate-all').click()
  await page.getByTestId('video-confirm').getByRole('button', { name: '开始生成' }).click()
  await page.waitForFunction(() => window.videoStudioPage.pendingClips().length === 3)
  const requests = await studioCalls(page, 'generate')
  assert.deepEqual(requests.map((input) => ({ ...input, requestId: undefined })), ['红色的街', '绿色的门', '蓝色的雨'].map((prompt) => ({
    requestId: undefined, group: '图片模型', model: 'grok-imagine-video-1.5', prompt, seconds: '6', width: 720, height: 1280,
  })))
  await page.evaluate((requestId) => window.videoStudioPage.progress({ requestId, stage: 'processing', value: 40 }), requests[0].requestId)
  await page.getByTestId('video-shot-0').getByText('生成中 40%').waitFor()
  assert.equal(await page.getByTestId('video-compose').isDisabled(), true, 'nothing to join until every clip is back')

  const colors = { 红色的街: '#ff0000', 绿色的门: '#00ff00', 蓝色的雨: '#0000ff' }
  for (const input of requests) await page.evaluate(([requestId, color]) => window.videoStudioPage.finishClip(requestId, color), [input.requestId, colors[input.prompt]])
  for (const index of [0, 1, 2]) await page.getByTestId(`video-shot-${index}`).getByText('已生成').waitFor()
  // 这里的缩略图地址出不来，和 Linux 上主进程取不到视频封面一样：不留裂图，镜头上照样有播放键和镜头号。
  await page.waitForFunction(() => document.querySelectorAll('.video-studio-thumb img').length === 0)
  for (const index of [0, 1, 2]) {
    const thumb = page.getByTestId(`video-shot-${index}`).getByRole('button', { name: `用播放器打开第 ${index + 1} 段` })
    assert.equal(await thumb.locator('b').textContent(), String(index + 1))
    assert.equal(await thumb.locator('svg').count(), 1)
  }

  await page.getByTestId('video-compose').click()
  // 真的在后台线程里拼三段，慢机器上要好一会儿；用和冷启动同一份的宽限，不另写一个数。
  await page.getByTestId('video-result').waitFor({ timeout: fixtureReadyTimeoutMs })
  await page.waitForFunction(() => document.querySelectorAll('.video-studio-thumb img').length === 0)
  const inspected = await page.evaluate(async () => {
    const data = window.videoStudioPage.exported()
    return window.videoStudioHarness.inspect(data, {
      colors: [{ time: 0.5, x: 360, y: 400 }, { time: 1.5, x: 360, y: 400 }, { time: 2.5, x: 360, y: 400 }],
      bright: [{ time: 0.5, top: 0, bottom: 1280 }, { time: 2.5, top: 0, bottom: 1280 }],
    })
  })
  assert.equal(inspected.width, 720)
  assert.equal(inspected.height, 1280)
  near(inspected.videoDuration, 3, 0.05, 'film duration')
  closeColor(inspected.colors[0], [255, 0, 0], 'first shot')
  closeColor(inspected.colors[1], [0, 255, 0], 'moved shot')
  closeColor(inspected.colors[2], [0, 0, 255], 'last shot')
  assert.ok(inspected.bright[0] > 50, 'the first caption is burnt in')
  assert.equal(inspected.bright[1], 0, 'the shot without a caption stays clean')
  assert.equal((await studioCalls(page, 'read')).length, 3)
  assert.equal((await studioCalls(page, 'store')).length, 1)
  assert.match(await page.getByTestId('video-notice').textContent(), /拼好了/)
  // 这几段都没声音，提示说的是没声音、没提文件夹，提示上就不挂「打开文件夹」；成片那一行照样有。
  assert.equal(await page.getByTestId('video-notice-folder').count(), 0)

  await page.getByTestId('video-result-open').click()
  const [opened] = await studioCalls(page, 'open')
  assert.match(opened, /^v+\d+$/)
  await page.getByTestId('video-result-folder').click()
  await page.waitForFunction(() => window.videoStudioPage.calls.some((call) => call.method === 'folder'))
  assert.deepEqual(await studioCalls(page, 'folder'), ['ai-output'])
  assert.equal(await page.getByTestId('video-error').count(), 0)

  // 重开页面：分镜、片段和成片都还在，没有再发任何付费请求。
  await page.reload()
  await page.getByTestId('video-result').waitFor()
  for (const index of [0, 1, 2]) await page.getByTestId(`video-shot-${index}`).getByText('已生成').waitFor()
  assert.equal(await page.getByTestId('video-shot-prompt-1').inputValue(), '绿色的门')
  assert.deepEqual(await studioCalls(page, 'generate'), [])

  // 重写分镜的时候不能拼：拼完的成片会挂到换过的分镜上。
  await page.getByTestId('video-plan').click()
  await page.getByTestId('video-confirm').getByRole('button', { name: '重新写' }).click()
  await page.getByTestId('video-plan-stop').waitFor()
  assert.equal(await page.getByTestId('video-compose').isDisabled(), true, 'no joining while the storyboard is being rewritten')
  assert.equal(await page.getByTestId('video-captions').getByRole('switch').isDisabled(), true, 'the caption switch waits for the storyboard too')
  await page.getByTestId('video-export').getByText('等分镜写完再拼。').waitFor()
  await page.evaluate(() => window.videoStudioPage.failPlan('这次 AI 没按格式写出分镜，把想法写具体一点或换个文字模型再试'))
  await page.getByTestId('video-error').waitFor()
  assert.equal(await page.getByTestId('video-compose').isDisabled(), false, 'the storyboard that is still there can be joined again')
  await page.getByTestId('video-result').waitFor()
  assert.deepEqual(errors, [])
  await page.close()
})

// 审查清单 JJ-1：生成到一半关掉软件，钱扣了的那段要回到镜头上，不能显示「还没生成」让客户再花一次钱。
test('picks shots that were still generating back up after the page reopens, without paying again', async () => {
  const { page, errors } = await openStudio()
  await writeStoryboard(page, '城市夜景', { title: '夜景', shots: [{ prompt: '霓虹招牌' }, { prompt: '车流' }] })
  await page.getByTestId('video-generate-all').click()
  await page.getByTestId('video-confirm').getByRole('button', { name: '开始生成' }).click()
  await page.waitForFunction(() => window.videoStudioPage.pendingClips().length === 2)
  const requests = (await studioCalls(page, 'generate')).map((input) => input.requestId)

  // 刷新页面当作关掉再打开：原来那两次请求的应答没了，两段照样当在生成，拿原来的请求号去接，不发新的生成。
  await page.reload()
  await page.waitForFunction(() => window.videoStudioPage.pendingResumes().length === 2)
  assert.deepEqual([...new Set(await studioCalls(page, 'resume'))].sort(), [...requests].sort())
  for (const index of [0, 1]) await page.getByTestId(`video-shot-${index}`).getByText('生成中').waitFor()
  await page.getByTestId('video-generate-stop').waitFor()
  await page.evaluate((requestId) => window.videoStudioPage.progress({ requestId, stage: 'processing', value: 70 }), requests[0])
  await page.getByTestId('video-shot-0').getByText('生成中 70%').waitFor()

  // 这两单钱已经扣了，点「停止生成」也拿不回来：不去停，接着等，镜头不变回「还没生成」。
  await page.getByTestId('video-generate-stop').click()
  await page.getByTestId('video-notice').getByText(/其中 2 段已经交给服务端/).waitFor()
  assert.deepEqual(await studioCalls(page, 'cancel'), [])
  for (const index of [0, 1]) await page.getByTestId(`video-shot-${index}`).getByText('生成中').waitFor()
  assert.equal(await page.getByTestId('video-generate-all').count(), 0)

  await page.evaluate((requestId) => window.videoStudioPage.finishResume(requestId, '#ff0000'), requests[0])
  await page.getByTestId('video-shot-0').getByText('已生成').waitFor()
  // 主进程那边没有这一单（没交出去，或者服务端说失败了）：回到「还没生成」，可以再点生成。
  await page.evaluate((requestId) => window.videoStudioPage.dropResume(requestId), requests[1])
  await page.getByTestId('video-shot-1').getByText('还没生成').waitFor()
  assert.equal(await page.getByTestId('video-generate-all').textContent(), '生成剩下的 1 段')
  assert.deepEqual(await studioCalls(page, 'generate'), [])
  assert.equal(await page.getByTestId('video-error').count(), 0)

  // 再打开一次：接回来的那段已经记在镜头上，没有还要接的。
  await page.reload()
  await page.getByTestId('video-shot-0').getByText('已生成').waitFor()
  await page.getByTestId('video-shot-1').getByText('还没生成').waitFor()
  assert.deepEqual(await studioCalls(page, 'resume'), [])
  assert.deepEqual(errors, [])
  await page.close()
})

// #1406 P1-1：点了「停止生成」，钱已经扣了的那几段不能变回「还没生成」，不然「生成剩下的」一点就是同一段付两次钱。
test('stops a storyboard and the clips not yet sent, and keeps waiting for the ones already billed', async () => {
  const { page, errors } = await openStudio()
  await page.getByTestId('video-idea-input').fill('海边日落')
  await page.getByTestId('video-plan').click()
  await page.getByTestId('video-plan-stop').click()
  await page.getByTestId('video-plan').waitFor()
  assert.equal((await studioCalls(page, 'cancel')).length, 1)
  assert.equal(await page.getByTestId('video-error').count(), 0, 'stopping on purpose is not an error')

  await writeStoryboard(page, '海边日落', { title: '日落', shots: [{ prompt: '海浪' }, { prompt: '夕阳' }, { prompt: '礁石' }] })
  await page.getByTestId('video-generate-all').click()
  await page.getByTestId('video-confirm').getByRole('button', { name: '开始生成' }).click()
  await page.waitForFunction(() => window.videoStudioPage.pendingClips().length === 3)
  const [first, second, third] = await page.evaluate(() => window.videoStudioPage.pendingClips())
  // 第三段还没交给服务端：停下就不花钱。
  await page.evaluate((requestId) => window.videoStudioPage.unsent(requestId), third.requestId)
  await page.evaluate((requestId) => window.videoStudioPage.failClip(requestId, '这次的描述没通过安全审核，换个说法再试'), first.requestId)
  await page.getByTestId('video-shot-0').getByText('这次的描述没通过安全审核，换个说法再试').waitFor()
  await page.getByTestId('video-shot-0').getByText('没生成出来').waitFor()

  await page.getByTestId('video-generate-stop').click()
  await page.getByTestId('video-notice').getByText('已经停下。其中 1 段已经交给服务端，钱已经扣了，停不下来；这里会接着等它生成好，好了自动放回对应的镜头。').waitFor()
  // 提示里没说作品文件夹，旁边就不挂「打开文件夹」。
  assert.equal(await page.getByTestId('video-notice-folder').count(), 0)
  assert.deepEqual((await studioCalls(page, 'cancel')).slice(1).sort(), [second.requestId, third.requestId].sort())
  // 已经交出去的那段拿原来的请求号接着等，镜头上还是「生成中」，卡片上也没有「生成剩下的」。
  await page.waitForFunction(() => window.videoStudioPage.pendingResumes().length === 1)
  assert.deepEqual(await studioCalls(page, 'resume'), [second.requestId])
  await page.getByTestId('video-shot-1').getByText('生成中').waitFor()
  await page.getByTestId('video-shot-2').getByText('还没生成').waitFor()
  assert.equal(await page.getByTestId('video-shot-2').getByRole('alert').count(), 0, 'a clip stopped on purpose shows no error')
  assert.equal(await page.getByTestId('video-generate-all').count(), 0, 'nothing to pay for again while the billed clip is still coming')

  // 再点一次停止：接着等的那段停不下来，不再去停它。
  await page.getByTestId('video-notice').getByRole('button', { name: '关闭' }).click()
  await page.getByTestId('video-generate-stop').click()
  await page.getByTestId('video-notice').getByText(/其中 1 段已经交给服务端/).waitFor()
  assert.equal((await studioCalls(page, 'cancel')).length, 3)

  await page.evaluate((requestId) => window.videoStudioPage.finishResume(requestId, '#ff8800'), second.requestId)
  await page.getByTestId('video-shot-1').getByText('已生成').waitFor()
  assert.equal(await page.getByTestId('video-generate-all').textContent(), '生成剩下的 2 段')
  assert.equal((await studioCalls(page, 'generate')).length, 3)
  assert.equal(await page.getByTestId('video-error').count(), 0)

  // 一镜没写描述就一段都不发。
  await page.getByTestId('video-shot-prompt-2').fill('  ')
  await page.getByTestId('video-generate-all').click()
  await page.getByTestId('video-confirm').getByRole('button', { name: '开始生成' }).click()
  await page.getByTestId('video-error').getByText('第 3 个镜头还没写画面描述').waitFor()
  assert.equal((await studioCalls(page, 'generate')).length, 3)
  assert.deepEqual(errors, [])
  await page.close()
})

// #1406 P1-1：停下时刚交出去、主进程拿不到结果的那一段，按主进程那句报错算失败，不悄悄变回「还没生成」。
test('marks a clip stopped mid-submission as failed when nothing comes back', async () => {
  const { page, errors } = await openStudio()
  await writeStoryboard(page, '山间小路', { title: '小路', shots: [{ prompt: '晨雾' }] })
  await page.getByTestId('video-generate-all').click()
  await page.getByTestId('video-confirm').getByRole('button', { name: '开始生成' }).click()
  await page.waitForFunction(() => window.videoStudioPage.pendingClips().length === 1)
  const [clip] = await page.evaluate(() => window.videoStudioPage.pendingClips())
  await page.getByTestId('video-generate-stop').click()
  await page.waitForFunction(() => window.videoStudioPage.pendingResumes().length === 1)
  await page.evaluate((requestId) => window.videoStudioPage.dropResume(requestId), clip.requestId)
  await page.getByTestId('video-shot-0').getByText('没生成出来').waitFor()
  await page.getByTestId('video-shot-0').getByText('视频提交结果不明确，服务端可能已创建任务，请勿立即重复提交').waitFor()
  assert.equal((await studioCalls(page, 'generate')).length, 1)
  assert.deepEqual(errors, [])
  await page.close()
})

// 主进程那句「提交结果不明确」（electron/ai-video-submission.ts）：交出去了、没拿到任务号，钱可能扣了，片段接不回来。
const unclear = '视频提交结果不明确，服务端可能已创建任务，请勿立即重复提交'

// #1489 N2：提交没收到答复的那一段，关掉重开以后不能变回「还没生成」，「生成剩下的」再付一次钱之前要客户自己点头。
test('keeps a clip whose submission went unanswered flagged after reopening, and asks before paying for it again', async () => {
  const { page, errors } = await openStudio()
  await writeStoryboard(page, '海边', { title: '海边', shots: [{ prompt: '浪花' }, { prompt: '海鸥' }, { prompt: '灯塔' }] })
  await page.getByTestId('video-generate-all').click()
  await page.getByTestId('video-confirm').getByRole('button', { name: '开始生成' }).click()
  await page.waitForFunction(() => window.videoStudioPage.pendingClips().length === 3)
  const [first, second, third] = await page.evaluate(() => window.videoStudioPage.pendingClips())
  await page.evaluate(([requestId, message]) => window.videoStudioPage.failClip(requestId, message), [first.requestId, unclear])
  await page.evaluate((requestId) => window.videoStudioPage.finishClip(requestId, '#0088ff'), second.requestId)
  await page.getByTestId('video-shot-0').getByText(unclear).waitFor()
  await page.getByTestId('video-shot-1').getByText('已生成').waitFor()

  // 第三段还在提交时关掉软件。重开以后只接第三段；第一段没有任务号可接，照样是失败加那句提醒。
  await page.reload()
  await page.waitForFunction(() => window.videoStudioPage.pendingResumes().length === 1)
  assert.deepEqual([...new Set(await studioCalls(page, 'resume'))], [third.requestId])
  await page.getByTestId('video-shot-0').getByText('没生成出来').waitFor()
  await page.getByTestId('video-shot-0').getByText(unclear).waitFor()
  // 主进程说第三段也是交出去了、没拿到任务号：同样提醒，不变回「还没生成」。
  await page.evaluate(([requestId, message]) => window.videoStudioPage.failResume(requestId, message), [third.requestId, unclear])
  await page.getByTestId('video-shot-2').getByText(unclear).waitFor()
  assert.deepEqual(await studioCalls(page, 'generate'), [])

  // 再打开一次：两段都还是那句提醒，不去接，也不发生成。
  await page.reload()
  for (const index of [0, 2]) await page.getByTestId(`video-shot-${index}`).getByText(unclear).waitFor()
  assert.deepEqual(await studioCalls(page, 'resume'), [])
  assert.equal(await page.getByTestId('video-generate-all').textContent(), '生成剩下的 2 段')

  // 「生成剩下的 2 段」：确认框另外说清可能多扣一次，先勾「我已了解影响」才能点。
  await page.getByTestId('video-generate-all').click()
  const confirm = page.getByTestId('video-confirm')
  await confirm.getByTestId('video-confirm-unconfirmed').getByText('这几段上次提交时没收到服务端答复：钱可能已经扣了，片段却拿不回来。再生成会重新计费，可能多扣一次。').waitFor()
  assert.equal(await confirm.getByRole('button', { name: '开始生成' }).isDisabled(), true)
  await confirm.getByRole('button', { name: '取消' }).click()
  await confirm.waitFor({ state: 'detached' })

  // 单独重新生成第一段：确认后沿用原来的请求号重新提交（MiniMax 拿它去重），不去接。
  await page.getByTestId('video-shot-generate-0').click()
  await confirm.getByTestId('video-confirm-unconfirmed').getByText(/^这一段上次提交时没收到服务端答复/).waitFor()
  await confirm.getByRole('checkbox').check()
  await confirm.getByRole('button', { name: '开始生成' }).click()
  await page.waitForFunction(() => window.videoStudioPage.pendingClips().length === 1)
  const [again] = await page.evaluate(() => window.videoStudioPage.pendingClips())
  assert.equal(again.requestId, first.requestId)
  assert.equal(again.prompt, '浪花')
  assert.deepEqual(await studioCalls(page, 'resume'), [])
  await page.getByTestId('video-shot-0').getByText('生成中').waitFor()
  await page.evaluate((requestId) => window.videoStudioPage.finishClip(requestId, '#00ff88'), first.requestId)
  await page.getByTestId('video-shot-0').getByText('已生成').waitFor()

  // 跟一段新加的一起生成：只点名那一段，没问题的那段照常。
  await page.getByTestId('video-shot-add').click()
  await page.getByTestId('video-shot-prompt-3').fill('日出')
  await page.getByTestId('video-generate-all').click()
  await confirm.getByTestId('video-confirm-unconfirmed').getByText(/^其中第 3 段上次提交时没收到服务端答复/).waitFor()
  await confirm.getByRole('button', { name: '取消' }).click()
  // 生成好的那一段重开以后不再提醒。
  await page.reload()
  await page.getByTestId('video-shot-0').getByText('已生成').waitFor()
  await page.getByTestId('video-shot-2').getByText(unclear).waitFor()
  assert.equal(await page.getByTestId('video-shot-0').getByRole('alert').count(), 0)
  assert.deepEqual(errors, [])
  await page.close()
})

// #1489 N2 同页那条路：「暂时查不到进度」的那一镜点重新生成，接回时主进程说它其实没拿到任务号，就停下提醒，不换新请求号再付一次。
test('stops and warns when picking a clip back up turns out the submission went unanswered', async () => {
  const { page, errors } = await openStudio()
  await writeStoryboard(page, '雪山', { title: '雪山', shots: [{ prompt: '山顶' }] })
  await page.getByTestId('video-generate-all').click()
  await page.getByTestId('video-confirm').getByRole('button', { name: '开始生成' }).click()
  await page.waitForFunction(() => window.videoStudioPage.pendingClips().length === 1)
  const [clip] = await page.evaluate(() => window.videoStudioPage.pendingClips())
  await page.evaluate((requestId) => window.videoStudioPage.failClip(requestId, '暂时查不到视频进度，服务端可能仍在生成，请勿重复提交；下次启动会继续查询（任务 task_1）。'), clip.requestId)
  await page.getByTestId('video-shot-0').getByText('没生成出来').waitFor()
  await page.getByTestId('video-shot-generate-0').click()
  assert.equal(await page.getByTestId('video-confirm-unconfirmed').count(), 0, 'nothing says it was unanswered yet')
  await page.getByTestId('video-confirm').getByRole('button', { name: '开始生成' }).click()
  await page.waitForFunction((requestId) => window.videoStudioPage.pendingResumes().includes(requestId), clip.requestId)
  await page.evaluate(([requestId, message]) => window.videoStudioPage.failResume(requestId, message), [clip.requestId, unclear])
  await page.getByTestId('video-shot-0').getByText(unclear).waitFor()
  assert.equal((await studioCalls(page, 'generate')).length, 1)
  await page.getByTestId('video-shot-generate-0').click()
  await page.getByTestId('video-confirm-unconfirmed').waitFor()
  assert.deepEqual(errors, [])
  await page.close()
})

// #1489 N2：结果不明的那一段确认了再付一次，这一单却没交出去就停下了、或者被服务端拒了：上一次那一单照样可能扣了钱，提醒不能丢。
test('keeps the warning when paying again for an unanswered clip does not go through', async () => {
  const { page, errors } = await openStudio()
  await writeStoryboard(page, '森林', { title: '森林', shots: [{ prompt: '树影' }] })
  await page.getByTestId('video-generate-all').click()
  await page.getByTestId('video-confirm').getByRole('button', { name: '开始生成' }).click()
  await page.waitForFunction(() => window.videoStudioPage.pendingClips().length === 1)
  const [clip] = await page.evaluate(() => window.videoStudioPage.pendingClips())
  await page.evaluate(([requestId, message]) => window.videoStudioPage.failClip(requestId, message), [clip.requestId, unclear])
  await page.getByTestId('video-shot-0').getByText(unclear).waitFor()
  const confirm = page.getByTestId('video-confirm')
  async function payAgain() {
    await page.getByTestId('video-shot-generate-0').click()
    await confirm.getByTestId('video-confirm-unconfirmed').waitFor()
    await confirm.getByRole('checkbox').check()
    await confirm.getByRole('button', { name: '开始生成' }).click()
    await page.waitForFunction((requestId) => window.videoStudioPage.pendingClips().some((pending) => pending.requestId === requestId), clip.requestId)
  }

  // 还没交给服务端就点了停止：回到失败加那句提醒，不是「还没生成」。
  await payAgain()
  await page.evaluate((requestId) => window.videoStudioPage.unsent(requestId), clip.requestId)
  await page.getByTestId('video-generate-stop').click()
  await page.getByTestId('video-shot-0').getByText(unclear).waitFor()
  await page.getByTestId('video-shot-0').getByText('没生成出来').waitFor()

  // 这回被服务端拒了：上屏的是这一回的原因，再生成时确认框照样提醒可能多扣。
  await payAgain()
  await page.evaluate((requestId) => window.videoStudioPage.failClip(requestId, '这次的描述没通过安全审核，换个说法再试'), clip.requestId)
  await page.getByTestId('video-shot-0').getByText('这次的描述没通过安全审核，换个说法再试').waitFor()
  await page.reload()
  await page.getByTestId('video-shot-0').getByText(unclear).waitFor()
  assert.deepEqual(await studioCalls(page, 'resume'), [])
  await page.getByTestId('video-shot-generate-0').click()
  await confirm.getByTestId('video-confirm-unconfirmed').waitFor()
  assert.deepEqual(errors, [])
  await page.close()
})

// #1489 R28-4：模型表还没读完就点了生成，读完以后记着的模型换成了默认的；排在后面的那一段照客户确认时的模型出，不悄悄换。
test('makes every queued clip with the model the person confirmed, even if the model list settles on another one meanwhile', async () => {
  const { page, errors } = await openStudio()
  await writeStoryboard(page, '城市', { title: '城市', shots: [{ prompt: '一' }, { prompt: '二' }, { prompt: '三' }, { prompt: '四' }] })
  await page.evaluate(() => {
    const key = 'xingmang-ui-v2:video-studio:xm-account:7'
    const stored = JSON.parse(localStorage.getItem(key))
    stored.settings.videoModel = 'grok-imagine-video'
    localStorage.setItem(key, JSON.stringify(stored))
  })
  await page.goto(`${base}/src/renderer-v2/features/video-studio/page-fixture.html?models=held`)
  await page.locator('[data-testid="video-video-model"][data-model="grok-imagine-video"]').waitFor()
  await page.getByTestId('video-generate-all').click()
  await page.getByTestId('video-confirm').getByText('用「grok-imagine-video」生成 4 段、每段 6 秒，每段单独计费。').waitFor()
  await page.getByTestId('video-confirm').getByRole('button', { name: '开始生成' }).click()
  await page.waitForFunction(() => window.videoStudioPage.pendingClips().length === 3)

  await page.evaluate(() => window.videoStudioPage.releaseModels())
  await page.locator('[data-testid="video-video-model"][data-model="grok-imagine-video-1.5"]').waitFor()
  const [first] = await page.evaluate(() => window.videoStudioPage.pendingClips())
  await page.evaluate((requestId) => window.videoStudioPage.finishClip(requestId, '#123456'), first.requestId)
  await page.waitForFunction(() => window.videoStudioPage.calls.filter((call) => call.method === 'generate').length === 4)
  const generated = await studioCalls(page, 'generate')
  assert.deepEqual(generated.map((input) => [input.prompt, input.model, input.seconds]), [['一', 'grok-imagine-video', '6'], ['二', 'grok-imagine-video', '6'], ['三', 'grok-imagine-video', '6'], ['四', 'grok-imagine-video', '6']])
  assert.deepEqual(errors, [])
  await page.close()
})

// #1406 P2-1：确认框「每段单独计费」后面报当前余额（yoyo 回「余额改」）。读不到余额不写这句；仓库里的余额是别的账号的（换账号那一下）也不写。
test('tells the current balance when confirming clips, and leaves it out when there is none for this account', async () => {
  const plain = '用「grok-imagine-video-1.5」生成 2 段、每段 6 秒，每段单独计费。'
  for (const [search, sentence] of [['?balance=1234.5', `${plain}当前余额 $1,234.50。`], ['', plain], ['?balance=1234.5&balanceScope=xm-account:8', plain]]) {
    const { page, errors } = await openStudio(search)
    // 仓库读回来以后再看确认框，别让「还没读到」把「别的账号的不报」那一种蒙混过去。
    if (search) await page.waitForFunction(() => window.videoStudioPage.balance() === 1234.5)
    await writeStoryboard(page, '咖啡馆', { title: '咖啡', shots: [{ prompt: '拉花' }, { prompt: '窗外' }] })
    await page.getByTestId('video-generate-all').click()
    const confirm = page.getByTestId('video-confirm')
    await confirm.getByText(sentence, { exact: true }).waitFor()
    assert.equal(await confirm.getByText('当前余额').count(), sentence === plain ? 0 : 1, search)
    assert.deepEqual(errors, [])
    await page.close()
  }
})

// 审查清单 严重-1 后半：「暂时查不到进度」这类失败时服务端多半还在出，点重新生成先拿原来的请求号接回，接不回来才再花钱。
test('retrying a clip that failed while the server may still be working picks the old one up before paying again', async () => {
  const { page, errors } = await openStudio()
  await writeStoryboard(page, '咖啡馆', { title: '咖啡', shots: [{ prompt: '拉花' }, { prompt: '窗外' }] })
  await page.getByTestId('video-generate-all').click()
  await page.getByTestId('video-confirm').getByRole('button', { name: '开始生成' }).click()
  await page.waitForFunction(() => window.videoStudioPage.pendingClips().length === 2)
  const [first, second] = await page.evaluate(() => window.videoStudioPage.pendingClips())
  await page.evaluate((requestId) => window.videoStudioPage.failClip(requestId, '暂时查不到视频进度，服务端可能仍在生成，请勿重复提交；下次启动会继续查询（任务 task_1）。'), first.requestId)
  await page.evaluate((requestId) => window.videoStudioPage.failClip(requestId, '这次的描述没通过安全审核，换个说法再试'), second.requestId)
  for (const index of [0, 1]) await page.getByTestId(`video-shot-${index}`).getByText('没生成出来').waitFor()

  // 第一镜：服务端其实出好了，接回来就是，不再提交。
  await page.getByTestId('video-shot-generate-0').click()
  await page.getByTestId('video-confirm').getByRole('button', { name: '开始生成' }).click()
  await page.waitForFunction(() => window.videoStudioPage.pendingResumes().length === 1)
  assert.deepEqual(await studioCalls(page, 'resume'), [first.requestId])
  await page.getByTestId('video-shot-0').getByText('生成中').waitFor()
  assert.equal(await page.getByTestId('video-shot-0').getByRole('alert').count(), 0, 'the old error goes away while it is being picked up')
  await page.evaluate((requestId) => window.videoStudioPage.finishResume(requestId, '#884400'), first.requestId)
  await page.getByTestId('video-shot-0').getByText('已生成').waitFor()
  assert.equal((await studioCalls(page, 'generate')).length, 2)

  // 第二镜：主进程那边没有这一单（提交时就被拒了），这才重新提交。
  await page.getByTestId('video-shot-generate-1').click()
  await page.getByTestId('video-confirm').getByRole('button', { name: '开始生成' }).click()
  await page.waitForFunction((requestId) => window.videoStudioPage.pendingResumes().includes(requestId), second.requestId)
  await page.evaluate((requestId) => window.videoStudioPage.dropResume(requestId), second.requestId)
  await page.waitForFunction(() => window.videoStudioPage.pendingClips().length === 1)
  const [third] = await page.evaluate(() => window.videoStudioPage.pendingClips())
  assert.notEqual(third.requestId, second.requestId)
  assert.equal(third.prompt, '窗外')
  assert.equal((await studioCalls(page, 'generate')).length, 3)

  // 这一单又没等到结果；再点重新生成，接回的时候点了停止，主进程又说没有这一单：停下了就不再花钱。
  await page.evaluate((requestId) => window.videoStudioPage.failClip(requestId, '暂时查不到视频进度，服务端可能仍在生成，请勿重复提交；下次启动会继续查询（任务 task_3）。'), third.requestId)
  await page.getByTestId('video-shot-1').getByText('没生成出来').waitFor()
  await page.getByTestId('video-shot-generate-1').click()
  await page.getByTestId('video-confirm').getByRole('button', { name: '开始生成' }).click()
  await page.waitForFunction((requestId) => window.videoStudioPage.pendingResumes().includes(requestId), third.requestId)
  await page.getByTestId('video-generate-stop').click()
  await page.getByTestId('video-notice').waitFor()
  assert.equal((await studioCalls(page, 'cancel')).length, 0)
  await page.evaluate((requestId) => window.videoStudioPage.dropResume(requestId), third.requestId)
  await page.getByTestId('video-shot-1').getByText('还没生成').waitFor()
  assert.equal((await studioCalls(page, 'generate')).length, 3)
  assert.equal(await page.getByTestId('video-error').count(), 0)
  assert.deepEqual(errors, [])
  await page.close()
})

// 提示里说到「AI 作品文件夹」，旁边就能直接打开它；主进程说打不开时按失败说一句，提示留着好再试。
// #1406 小项：粘进看不见的控制字符，主进程会拒掉整句、报对不上原因的「想法要写 1 到 2000 个字」。发之前先去掉。
test('drops invisible control characters pasted into the idea before asking for a storyboard', async () => {
  const { page, errors } = await openStudio()
  await page.getByTestId('video-idea-input').fill('一只橘猫\u000b在雨夜\u0001找回家的路\n最后到家')
  await page.getByTestId('video-plan').click()
  await page.getByTestId('video-plan-stop').waitFor()
  const [plan] = await studioCalls(page, 'plan')
  assert.equal(plan.idea, '一只橘猫在雨夜找回家的路\n最后到家')
  await page.evaluate(() => window.videoStudioPage.failPlan('已停止写分镜'))
  await page.getByTestId('video-plan').waitFor()
  assert.equal(await page.getByTestId('video-error').count(), 0)
  assert.deepEqual(errors, [])
  await page.close()
})

test('opens the AI output folder from a notice that mentions it', async () => {
  const { page, errors } = await openStudio()
  await writeStoryboard(page, '一盏灯', { title: '灯', shots: [{ prompt: '亮起来', caption: '' }] })
  await page.getByTestId('video-generate-all').click()
  await page.getByTestId('video-confirm').getByRole('button', { name: '开始生成' }).click()
  await page.waitForFunction(() => window.videoStudioPage.pendingClips().length === 1)
  const [clip] = await page.evaluate(() => window.videoStudioPage.pendingClips())
  await page.evaluate((requestId) => window.videoStudioPage.finishClip(requestId, '#ffffff', true), clip.requestId)
  await page.getByTestId('video-shot-0').getByText('已生成').waitFor()
  await page.getByTestId('video-compose').click()
  await page.getByTestId('video-result').waitFor({ timeout: fixtureReadyTimeoutMs })
  await page.getByTestId('video-notice').getByText('拼好了，成片已经存进 AI 作品文件夹。').waitFor()

  await page.getByTestId('video-notice-folder').click()
  await page.waitForFunction(() => window.videoStudioPage.calls.some((call) => call.method === 'folder'))
  assert.deepEqual(await studioCalls(page, 'folder'), ['ai-output'])
  assert.equal(await page.getByTestId('video-error').count(), 0)
  await page.evaluate(() => window.videoStudioPage.folderOpens(false))
  await page.getByTestId('video-notice-folder').click()
  await page.getByTestId('video-error').getByText('这个文件夹现在打不开，重新打开本软件后再试一次。').waitFor()
  assert.equal(await page.getByTestId('video-notice-folder').count(), 1, 'the notice stays so the folder can be tried again')
  assert.deepEqual(errors, [])
  await page.close()
})

// 「用一张图开头」（yoyo 2026-11-09「图开头改」）：选图走对话页那条通道，选几张就按顺序给几个镜头，生成时带上这张图，重开页面还在。
test('starts shots from pictures picked on the computer and keeps them after reopening', async () => {
  const { page, errors } = await openStudio()
  await writeStoryboard(page, '新款水杯', { title: '水杯', shots: [{ prompt: '水杯在桌上' }, { prompt: '倒水' }, { prompt: '拿起水杯' }] })
  const [first, second] = ['m', 'n'].map((letter) => letter.repeat(43))
  assert.equal(await page.getByTestId('video-shot-image-0').getAttribute('title'), '生成时从这张图动起来，适合商品图、人物照片')

  // 在对话框里点了取消：什么都不变。
  await page.getByTestId('video-shot-image-0').click()
  await page.waitForFunction(() => window.videoStudioPage.calls.some((call) => call.method === 'pick-images'))
  assert.equal(await page.getByTestId('video-shot-image-thumb-0').count(), 0)

  // 一次选两张：第一镜一张，第二镜一张，第三镜还是空的。
  await page.evaluate((ids) => window.videoStudioPage.pickImages(ids), [first, second])
  await page.getByTestId('video-shot-image-0').click()
  await page.getByTestId('video-shot-image-thumb-1').waitFor()
  assert.deepEqual(await studioCalls(page, 'pick-images'), [4, 4])
  assert.equal(await page.getByTestId('video-shot-image-thumb-0').count(), 1)
  assert.equal(await page.getByTestId('video-shot-image-2').textContent(), '用一张图开头')
  for (const index of [0, 1]) {
    const row = page.getByTestId(`video-shot-${index}`)
    assert.equal(await row.getByTestId(`video-shot-image-change-${index}`).textContent(), '换一张')
    assert.equal(await row.getByTestId(`video-shot-image-remove-${index}`).textContent(), '不用这张图')
  }

  // 第二镜不用了，回到「用一张图开头」。
  await page.getByTestId('video-shot-image-remove-1').click()
  await page.getByTestId('video-shot-image-1').waitFor()
  assert.equal(await page.getByTestId('video-shot-image-thumb-1').count(), 0)

  await page.getByTestId('video-generate-all').click()
  await page.getByTestId('video-confirm').getByRole('button', { name: '开始生成' }).click()
  await page.waitForFunction(() => window.videoStudioPage.pendingClips().length === 3)
  const requests = await studioCalls(page, 'generate')
  assert.deepEqual(requests.map((input) => input.imageAssetIds ?? null), [[first], null, null])
  // 生成的时候换不了图，免得出来的片段和镜头上的图对不上。
  assert.equal(await page.getByTestId('video-shot-image-change-0').isDisabled(), true)

  await page.evaluate((requestId) => window.videoStudioPage.finishClip(requestId, '#ff0000'), requests[0].requestId)
  await page.getByTestId('video-shot-0').getByText('已生成').waitFor()
  // 有了片段左边就是片段，选的图留一张小的在按钮旁边。
  await page.getByTestId('video-shot-image-preview-0').waitFor()
  assert.equal(await page.getByTestId('video-shot-image-thumb-0').count(), 0)

  // 重开页面：第一镜的图还在。
  await page.reload()
  await page.getByTestId('video-shot-image-preview-0').waitFor()
  assert.equal(await page.getByTestId('video-shot-image-1').textContent(), '用一张图开头')
  assert.deepEqual(errors, [])
  await page.close()
})

// 「让 AI 画一张」：走对话页出图那条（这里是假的桥），画好的图和自己选的图一样当这一镜的开头；停下、没画出来、余额不够各有去处。
test('draws a shot picture with AI before paying for the clip, and starts the clip from it', async () => {
  const { page, errors } = await openStudio('?balance=12.5')
  await page.locator('[data-testid="video-image-model"][data-model="gpt-image-2"]').waitFor()
  await page.waitForFunction(() => window.videoStudioPage.balance() === 12.5)
  await writeStoryboard(page, '新款水杯', { title: '水杯', shots: [{ prompt: '水杯在桌上' }, { prompt: '倒水' }] })
  const [first, second] = ['d', 'e'].map((letter) => letter.repeat(43))
  const draw = page.getByTestId('video-shot-draw-0')
  assert.equal(await draw.textContent(), '让 AI 画一张')
  assert.equal(await draw.getAttribute('title'), '按这一镜的画面描述先画一张图，满意了再拿它生成视频；画图单独计费')

  await draw.click()
  const confirm = page.getByTestId('video-confirm')
  await confirm.getByText('画一张镜头图？').waitFor()
  await confirm.getByText('用「gpt-image-2」按第 1 个镜头的画面描述画一张图，单独计费。当前余额 $12.50。', { exact: true }).waitFor()
  await confirm.getByText('中途停下的话，已经交给服务端的这一张照样扣费。', { exact: true }).waitFor()
  await confirm.getByRole('button', { name: '开始画' }).click()
  await page.waitForFunction(() => window.videoStudioPage.pendingDrawings().length === 1)
  const [request] = await studioCalls(page, 'image')
  // 竖屏 9:16 按 720p 出图；画质不写，用模型缺省最便宜的那一档。
  assert.deepEqual({ ...request, requestId: typeof request.requestId }, { requestId: 'string', group: '图片模型', model: 'gpt-image-2', prompt: '水杯在桌上', size: '720x1280' })

  // 画着的时候：这一镜的描述、出视频、删都不让动，也不能整批生成；别的镜头照样能画。
  const row = page.getByTestId('video-shot-0')
  await row.getByText('正在画图').waitFor()
  assert.equal(await page.getByTestId('video-shot-draw-stop-0').textContent(), '停止画图')
  for (const id of ['video-shot-prompt-0', 'video-shot-generate-0', 'video-shot-remove-0', 'video-generate-all', 'video-plan']) assert.equal(await page.getByTestId(id).isDisabled(), true, id)
  assert.equal(await page.getByTestId('video-shot-image-0').count(), 0)

  await page.evaluate(([requestId, assetId]) => window.videoStudioPage.finishDrawing(requestId, assetId), [request.requestId, first])
  // 假桥里的作品库地址打不开，缩略图会退成底色；换上的是哪一张，最后出视频时看请求。
  await page.getByTestId('video-shot-image-thumb-0').waitFor()
  assert.equal(await row.getByText('正在画图').count(), 0)
  assert.equal(await draw.textContent(), '再画一张')

  // 再画一张，中途停下：已经画好的那张留着，不报错。
  await draw.click()
  await confirm.getByText('再画一张？').waitFor()
  await confirm.getByText('会再扣一次费，新图画好以后换掉现在这一张；旧的那张还在 AI 作品文件夹里。', { exact: true }).waitFor()
  await confirm.getByRole('button', { name: '再画一张' }).click()
  await page.getByTestId('video-shot-draw-stop-0').click()
  await draw.waitFor()
  assert.equal((await studioCalls(page, 'cancel-image')).length, 1)
  assert.equal(await page.getByTestId('video-shot-image-thumb-0').count(), 1)
  assert.equal(await page.getByTestId('video-shot-draw-error-0').count(), 0)
  assert.equal(await page.getByTestId('video-error').count(), 0)

  // 第二镜没画出来：原因写在这一镜下面，再画一次就清掉。
  await page.getByTestId('video-shot-draw-1').click()
  await confirm.getByRole('button', { name: '开始画' }).click()
  await page.waitForFunction(() => window.videoStudioPage.pendingDrawings().length === 1)
  let [pending] = await page.evaluate(() => window.videoStudioPage.pendingDrawings())
  assert.equal(pending.prompt, '倒水')
  await page.evaluate((requestId) => window.videoStudioPage.failDrawing(requestId, '图片没画出来：描述里有不能画的内容'), pending.requestId)
  assert.equal(await page.getByTestId('video-shot-draw-error-1').textContent(), '图片没画出来：描述里有不能画的内容')

  // 余额不够：照页面顶上那条说，带「去充值」，这一镜下面不另写。
  await page.getByTestId('video-shot-draw-1').click()
  await confirm.getByRole('button', { name: '开始画' }).click()
  await page.waitForFunction(() => window.videoStudioPage.pendingDrawings().length === 1)
  assert.equal(await page.getByTestId('video-shot-draw-error-1').count(), 0)
  pending = (await page.evaluate(() => window.videoStudioPage.pendingDrawings()))[0]
  await page.evaluate((requestId) => window.videoStudioPage.failDrawing(requestId, '当前账号余额不足，充值后再试就行，不用重新登录，也不用重写密钥'), pending.requestId)
  await page.getByTestId('video-error').getByRole('button', { name: '去充值' }).waitFor()
  assert.equal(await page.getByTestId('video-shot-draw-error-1').count(), 0)

  await page.getByTestId('video-shot-draw-1').click()
  await confirm.getByRole('button', { name: '开始画' }).click()
  await page.waitForFunction(() => window.videoStudioPage.pendingDrawings().length === 1)
  pending = (await page.evaluate(() => window.videoStudioPage.pendingDrawings()))[0]
  await page.evaluate(([requestId, assetId]) => window.videoStudioPage.finishDrawing(requestId, assetId), [pending.requestId, second])
  await page.getByTestId('video-shot-image-thumb-1').waitFor()

  // 重开页面画好的图还在，拿去出视频就从这两张图开头。
  await page.reload()
  await page.getByTestId('video-shot-image-thumb-0').waitFor()
  await page.locator('[data-testid="video-video-model"][data-model="grok-imagine-video-1.5"]').waitFor()
  await page.getByTestId('video-generate-all').click()
  await confirm.getByRole('button', { name: '开始生成' }).click()
  await page.waitForFunction(() => window.videoStudioPage.pendingClips().length === 2)
  assert.deepEqual((await studioCalls(page, 'generate')).map((input) => input.imageAssetIds), [[first], [second]])
  assert.deepEqual(errors, [])
  await page.close()
})

// 剪头剪尾：每段开头、结尾按档剪掉几秒，拼出来的成片跟着短；换上新片段时清掉，重开页面还在。
test('trims the start and end of each clip into the joined film, forgets the trim with a new clip and keeps it after reopening', async () => {
  const { page, errors } = await openStudio()
  await writeStoryboard(page, '早餐', { title: '早餐', shots: [{ prompt: '煎蛋' }, { prompt: '咖啡' }] })
  assert.equal(await page.getByTestId('video-shot-trim-start-0').count(), 0)
  await page.getByTestId('video-generate-all').click()
  await page.getByTestId('video-confirm').getByRole('button', { name: '开始生成' }).click()
  await page.waitForFunction(() => window.videoStudioPage.pendingClips().length === 2)
  const requests = await studioCalls(page, 'generate')
  await page.evaluate(([red, blue]) => Promise.all([window.videoStudioPage.finishClip(red, '#ff0000', false, 3), window.videoStudioPage.finishClip(blue, '#0000ff', false, 3)]), requests.map((input) => input.requestId))
  await page.getByTestId('video-shot-trim-start-1').waitFor()
  // 三秒的片段剪完至少留一秒：一头最多剪 2 秒，另一头剪了以后跟着少。
  assert.deepEqual(await page.getByTestId('video-shot-trim-start-0').locator('option').allTextContents(), ['不剪', '0.5 秒', '1 秒', '1.5 秒', '2 秒'])
  await page.getByTestId('video-shot-trim-start-0').selectOption('1')
  await page.getByTestId('video-shot-trim-end-1').selectOption('0.5')
  assert.deepEqual(await page.getByTestId('video-shot-trim-end-0').locator('option').allTextContents(), ['不剪', '0.5 秒', '1 秒'])
  await page.getByText('共约 11 秒').waitFor()

  await page.getByTestId('video-compose').click()
  await page.getByTestId('video-result').waitFor({ timeout: fixtureReadyTimeoutMs })
  const inspected = await page.evaluate(() => window.videoStudioHarness.inspect(window.videoStudioPage.exported(), { colors: [{ time: 1.5, x: 360, y: 640 }, { time: 3, x: 360, y: 640 }] }))
  near(inspected.videoDuration, 4.5, 0.1, 'trimmed film duration')
  closeColor(inspected.colors[0], [255, 0, 0], 'first shot keeps its last two seconds')
  closeColor(inspected.colors[1], [0, 0, 255], 'second shot follows')

  // 剪的长短一变，成片就对不上了，不再挂着。
  await page.getByTestId('video-shot-trim-end-1').selectOption('0')
  assert.equal(await page.getByTestId('video-result').count(), 0)

  // 重开页面剪掉的还在。
  await page.reload()
  await page.locator('[data-testid="video-shot-trim-start-0"]').waitFor()
  assert.equal(await page.getByTestId('video-shot-trim-start-0').inputValue(), '1')
  assert.equal(await page.getByTestId('video-shot-trim-end-1').inputValue(), '0')

  // 重新生成第一段：新片段从头用起，剪掉的清零。
  await page.locator('[data-testid="video-video-model"][data-model="grok-imagine-video-1.5"]').waitFor()
  await page.getByTestId('video-shot-generate-0').click()
  await page.getByTestId('video-confirm').getByRole('button', { name: '重新生成' }).click()
  await page.waitForFunction(() => window.videoStudioPage.pendingClips().length === 1)
  // 重新生成的时候还是旧片段，剪不了。
  assert.equal(await page.getByTestId('video-shot-trim-start-0').isDisabled(), true)
  const [again] = await page.evaluate(() => window.videoStudioPage.pendingClips())
  await page.evaluate((requestId) => window.videoStudioPage.finishClip(requestId, '#00ff00', false, 3), again.requestId)
  await page.waitForFunction(() => document.querySelector('[data-testid="video-shot-trim-start-0"]')?.value === '0')
  assert.deepEqual(errors, [])
  await page.close()
})

// 镜头之间淡入淡出、结尾淡出：缺省直接切、不淡；选了以后拼出来的成片跟着淡，重开页面还在。
test('fades between shots and at the end of the joined film once chosen, and keeps the choice after reopening', async () => {
  const { page, errors } = await openStudio()
  await writeStoryboard(page, '日落', { title: '日落', shots: [{ prompt: '太阳' }, { prompt: '海面' }] })
  await page.getByTestId('video-generate-all').click()
  await page.getByTestId('video-confirm').getByRole('button', { name: '开始生成' }).click()
  await page.waitForFunction(() => window.videoStudioPage.pendingClips().length === 2)
  const requests = await studioCalls(page, 'generate')
  await page.evaluate(([red, blue]) => Promise.all([window.videoStudioPage.finishClip(red, '#ff0000'), window.videoStudioPage.finishClip(blue, '#0000ff')]), requests.map((input) => input.requestId))
  assert.equal(await page.getByTestId('video-transition').inputValue(), 'cut')
  assert.equal(await page.getByTestId('video-fade-out').getByRole('switch').getAttribute('aria-checked'), 'false')
  await page.getByTestId('video-transition').selectOption('fade')
  await page.getByTestId('video-fade-out').getByRole('switch').click()

  await page.getByTestId('video-compose').click()
  await page.getByTestId('video-result').waitFor({ timeout: fixtureReadyTimeoutMs })
  const inspected = await page.evaluate(() => window.videoStudioHarness.inspect(window.videoStudioPage.exported(), { colors: [{ time: 0.3, x: 360, y: 640 }, { time: 0.98, x: 360, y: 640 }, { time: 1.98, x: 360, y: 640 }] }))
  closeColor(inspected.colors[0], [255, 0, 0], 'first shot in full')
  closeColor(inspected.colors[1], [0, 0, 0], 'dips to black before the second shot')
  closeColor(inspected.colors[2], [0, 0, 0], 'fades out at the end')

  await page.reload()
  await page.getByTestId('video-transition').waitFor()
  assert.equal(await page.getByTestId('video-transition').inputValue(), 'fade')
  assert.equal(await page.getByTestId('video-fade-out').getByRole('switch').getAttribute('aria-checked'), 'true')
  assert.deepEqual(errors, [])
  await page.close()
})

// 「加配乐」：歌由主进程的系统对话框选、存进作品库（这里是假的桥），拼片时按编号读回来混进去；重开页面还在。
test('lays a picked song under the joined film, with the clip sound turned down by default, and keeps it after reopening', async () => {
  const { page, errors } = await openStudio()
  await writeStoryboard(page, '海边散步', { title: '海边', shots: [{ prompt: '海浪' }, { prompt: '沙滩' }] })
  await page.getByTestId('video-generate-all').click()
  await page.getByTestId('video-confirm').getByRole('button', { name: '开始生成' }).click()
  await page.waitForFunction(() => window.videoStudioPage.pendingClips().length === 2)
  const requests = await studioCalls(page, 'generate')
  for (const input of requests) await page.evaluate((requestId) => window.videoStudioPage.finishClip(requestId, '#0000ff'), input.requestId)
  for (const index of [0, 1]) await page.getByTestId(`video-shot-${index}`).getByText('已生成').waitFor()

  const add = page.getByTestId('video-music-add')
  assert.equal(await add.getAttribute('title'), '从电脑里选一首歌当背景音乐，支持 MP3、M4A、WAV、OGG')
  assert.equal(await add.textContent(), '加配乐')
  // 在对话框里点了取消：什么都不变。
  await add.click()
  await page.waitForFunction(() => window.videoStudioPage.calls.some((call) => call.method === 'pick-music'))
  assert.equal(await page.getByTestId('video-music-name').count(), 0)
  // 主进程认不出这个文件：页面上照那一句说。
  await page.evaluate(() => window.videoStudioPage.pickSong('unreadable'))
  await add.click()
  await page.getByTestId('video-error').getByText('这首歌读不出来，换一首试试（支持 MP3、M4A、WAV、OGG）').waitFor()

  await page.evaluate(() => window.videoStudioPage.pickSong({ name: '海风', seconds: 0.8, frequency: 660 }))
  await add.click()
  await page.getByTestId('video-music-name').getByText('海风').waitFor()
  assert.equal(await page.getByTestId('video-music-change').textContent(), '换一首')
  assert.equal(await page.getByTestId('video-music-remove').textContent(), '不用配乐')
  assert.equal(await page.getByTestId('video-clip-sound').inputValue(), 'quiet')
  assert.deepEqual(await page.getByTestId('video-clip-sound').locator('option').allTextContents(), ['照常', '调小', '关掉'])

  await page.getByTestId('video-compose').click()
  await page.getByTestId('video-result').waitFor({ timeout: fixtureReadyTimeoutMs })
  const [songId] = await studioCalls(page, 'read-music')
  assert.match(songId, /^v+\d+$/)
  const inspected = await page.evaluate(() => window.videoStudioHarness.inspect(window.videoStudioPage.exported(), { loudness: [{ from: 0.1, to: 0.7 }, { from: 0.9, to: 1.4 }] }))
  assert.ok(['aac', 'opus'].includes(inspected.audioCodec), 'clips without sound get a sound track from the song')
  const [first, again] = inspected.loudness
  assert.ok(first > 0.1, `the song plays under the film (${first})`)
  assert.ok(again > 0.1, `the song starts over once it runs out (${again})`)
  assert.equal(await page.getByTestId('video-error').count(), 0)

  // 换个原声音量，上一次的成片就跟现在对不上了，不再挂着。
  await page.getByTestId('video-clip-sound').selectOption('off')
  await page.waitForFunction(() => !document.querySelector('[data-testid="video-result"]'))

  // 重开页面：歌和原声那一项都还在；不用配乐就回到「加配乐」。
  await page.reload()
  await page.getByTestId('video-music-name').getByText('海风').waitFor()
  assert.equal(await page.getByTestId('video-clip-sound').inputValue(), 'off')
  await page.getByTestId('video-music-remove').click()
  await page.getByTestId('video-music-add').waitFor()
  assert.deepEqual(errors, [])
  await page.close()
})
