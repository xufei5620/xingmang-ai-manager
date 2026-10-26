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

async function openStudio() {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/*', async (route) => { if (new URL(route.request().url()).hostname !== '127.0.0.1') return route.abort(); await route.continue() })
  await openFixturePage(page, `${base}/src/renderer-v2/features/video-studio/page-fixture.html`,
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

  await page.getByTestId('video-compose').click()
  // 真的在后台线程里拼三段，慢机器上要好一会儿；用和冷启动同一份的宽限，不另写一个数。
  await page.getByTestId('video-result').waitFor({ timeout: fixtureReadyTimeoutMs })
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

test('stops a storyboard and the clips still running, and says which ones may still be billed', async () => {
  const { page, errors } = await openStudio()
  await page.getByTestId('video-idea-input').fill('海边日落')
  await page.getByTestId('video-plan').click()
  await page.getByTestId('video-plan-stop').click()
  await page.getByTestId('video-plan').waitFor()
  assert.equal((await studioCalls(page, 'cancel')).length, 1)
  assert.equal(await page.getByTestId('video-error').count(), 0, 'stopping on purpose is not an error')

  await writeStoryboard(page, '海边日落', { title: '日落', shots: [{ prompt: '海浪' }, { prompt: '夕阳' }] })
  await page.getByTestId('video-generate-all').click()
  await page.getByTestId('video-confirm').getByRole('button', { name: '开始生成' }).click()
  await page.waitForFunction(() => window.videoStudioPage.pendingClips().length === 2)
  const [first] = await page.evaluate(() => window.videoStudioPage.pendingClips())
  await page.evaluate((requestId) => window.videoStudioPage.failClip(requestId, '这次的描述没通过安全审核，换个说法再试'), first.requestId)
  await page.getByTestId('video-shot-0').getByText('这次的描述没通过安全审核，换个说法再试').waitFor()
  await page.getByTestId('video-shot-0').getByText('没生成出来').waitFor()

  await page.getByTestId('video-generate-stop').click()
  await page.getByTestId('video-notice').getByText(/其中 1 段已经交给服务端，会照样生成、照样扣费/).waitFor()
  // 提示说好了会存进 AI 作品文件夹，旁边就能直接打开它；主进程说打不开时按失败说一句。
  await page.getByTestId('video-notice-folder').click()
  await page.waitForFunction(() => window.videoStudioPage.calls.some((call) => call.method === 'folder'))
  assert.deepEqual(await studioCalls(page, 'folder'), ['ai-output'])
  assert.equal(await page.getByTestId('video-error').count(), 0)
  await page.evaluate(() => window.videoStudioPage.folderOpens(false))
  await page.getByTestId('video-notice-folder').click()
  await page.getByTestId('video-error').getByText('这个文件夹现在打不开，重新打开本软件后再试一次。').waitFor()
  assert.equal(await page.getByTestId('video-notice-folder').count(), 1, 'the notice stays so the folder can be tried again')
  await page.getByTestId('video-shot-1').getByText('还没生成').waitFor()
  assert.equal(await page.getByTestId('video-shot-1').getByRole('alert').count(), 0, 'a clip stopped on purpose shows no error')
  assert.equal(await page.getByTestId('video-generate-all').textContent(), '生成全部 2 段')

  // 一镜没写描述就一段都不发。
  await page.getByTestId('video-shot-prompt-1').fill('  ')
  await page.getByTestId('video-generate-all').click()
  await page.getByTestId('video-confirm').getByRole('button', { name: '开始生成' }).click()
  await page.getByTestId('video-error').getByText('第 2 个镜头还没写画面描述').waitFor()
  assert.equal((await studioCalls(page, 'generate')).length, 2)
  assert.deepEqual(errors, [])
  await page.close()
})
