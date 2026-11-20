import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

// The Windows renderer-v2-e2e shard has failed a click whose call log ends at
// "performing click action" four times: two MCP tests in a row on 2026-11-11
// (#1756, quality run 42992280184) and the first avatar test three times on
// 2026-11-20 within about an hour, on different runners (#1949, run
// 44741601202; #2003, run 44742552348; #2011, run 44753304773). Each time the
// element was found, visible, enabled and stable, the mouse events went out,
// and nothing came back for the whole action timeout; the next test's fresh
// page stalled or ran slow as well, and about ten seconds after the first
// click everything was fine again. What those logs cannot say is which half
// stopped: either the mouse events never reached the page, or the click landed
// and the page stopped answering after it. The two point at different
// machinery (the browser's input pipeline or frame production, against
// whatever the click set off in the page), and only something taken while the
// stall is still going on can tell them apart. So a click that stalls this way
// takes that evidence itself and appends it to its own error, where the red
// run already shows it.

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Where the screenshot of a stuck page goes; the Windows job uploads it on failure. */
export const clickStallArtifactsDir = path.join(projectRoot, 'artifacts', 'click-stall')

/**
 * How long each probe may wait. The stalls on record lasted about ten seconds,
 * so three keeps every probe inside the stall it is describing, and they run
 * side by side so the whole report costs one wait.
 */
export const clickStallProbeTimeoutMs = 3_000

/** How long the runner's CPU is sampled for, alongside the other probes. */
export const clickStallCpuSampleMs = 500

// Playwright wraps each call-log line in a dim/reset pair; the comparison below
// has to see the bare text.
const ansiEscape = /\u001b\[[0-9;]*m/g

/**
 * True when a click timed out after the mouse events were sent: the call log's
 * last line is Playwright's "performing click action". A click that timed out
 * earlier (never visible, never stable, covered by another element) ends on a
 * different line and is an ordinary failure of the test.
 */
export function isStalledClick(error) {
  if (error?.name !== 'TimeoutError') return false
  const lines = String(error.message ?? '').replace(ansiEscape, '').split('\n').map((line) => line.trim()).filter(Boolean)
  return lines.at(-1) === '- performing click action'
}

class ProbeTimeout extends Error {}

/**
 * Runs one probe with a deadline and reports how it went instead of throwing.
 * A probe that loses the race keeps running; Promise.race has already
 * subscribed to it, so its eventual rejection (the page closing under it) is
 * handled rather than reported as unhandled.
 */
async function bounded(work, timeoutMs) {
  const started = performance.now()
  let timer
  try {
    const value = await Promise.race([
      Promise.resolve().then(work),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new ProbeTimeout()), timeoutMs) }),
    ])
    return { outcome: 'answered', ms: Math.round(performance.now() - started), value }
  } catch (error) {
    if (error instanceof ProbeTimeout) return { outcome: 'timeout', ms: timeoutMs }
    return { outcome: 'failed', ms: Math.round(performance.now() - started), reason: String(error?.message ?? error).split('\n')[0] }
  } finally {
    clearTimeout(timer)
  }
}

// Evaluated in the stuck page, so it may not close over anything here. Whether
// a dialog is open says whether the click landed for the two tests on record,
// both of which click a button that opens one.
function readStuckPageState() {
  return {
    openDialogs: document.querySelectorAll('dialog[open]').length,
    focused: document.hasFocus(),
    visibility: document.visibilityState,
    active: document.activeElement?.tagName.toLowerCase() ?? null,
  }
}

// A page with Playwright's clock installed has requestAnimationFrame frozen,
// and a frame that never comes there says nothing about the browser.
const nextFrameExpression = `'__pwClock' in globalThis ? 'clock installed' : new Promise((resolve) => requestAnimationFrame(() => resolve('drawn')))`

/**
 * Opens an unrelated page in the same browser and clicks it with raw mouse
 * events, which go through the same Input.dispatchMouseEvent as the stuck
 * click. `progress.stage` survives a timeout, so the report can say how far
 * the page got. Raw mouse events rather than a locator click keep this probe
 * out of the wrapper that called it.
 */
async function clickFreshPage(page, progress) {
  const browser = page.context().browser()
  if (!browser) return null
  const started = performance.now()
  progress.stage = 'opening'
  const fresh = await browser.newPage()
  try {
    await fresh.setContent('<button style="position:fixed;left:0;top:0;width:200px;height:100px" onclick="document.title=\'clicked\'">probe</button>')
    progress.openedMs = Math.round(performance.now() - started)
    progress.stage = 'clicking'
    const clicking = performance.now()
    await fresh.mouse.click(100, 50)
    progress.clickedMs = Math.round(performance.now() - clicking)
    progress.stage = 'reading'
    return (await fresh.title()) === 'clicked' ? 'landed' : 'did not land'
  } finally {
    fresh.close().catch(() => {})
  }
}

async function sampleRunnerCpu(ms) {
  const before = os.cpus()
  await new Promise((resolve) => setTimeout(resolve, ms))
  const after = os.cpus()
  let idle = 0
  let total = 0
  after.forEach((cpu, index) => {
    const earlier = before[index]?.times
    if (!earlier) return
    for (const [kind, value] of Object.entries(cpu.times)) total += value - (earlier[kind] ?? 0)
    idle += cpu.times.idle - earlier.idle
  })
  return total > 0 ? Math.round(100 * (1 - idle / total)) : null
}

function describeProbe(result, answered) {
  if (result.outcome === 'timeout') return `no answer within ${result.ms}ms`
  if (result.outcome === 'failed') return `failed after ${result.ms}ms: ${result.reason}`
  return answered(result)
}

/**
 * Pure: turns what the probes found into the lines appended to the error.
 * Each line names what was tried, so the report reads without this file open.
 */
export function formatClickStallEvidence({ afterMs, probeTimeoutMs, page, frame, mouse, screenshot, fresh, eventLoopMaxMs, cpuBusyPercent }) {
  const pageLine = describeProbe(page, ({ ms, value }) => `answered in ${ms}ms (open dialogs ${value.openDialogs}, focused ${value.focused ? 'yes' : 'no'}, ${value.visibility}, active element ${value.active ?? 'none'})`)
  const frameLine = describeProbe(frame, ({ ms, value }) => value === 'drawn' ? `drawn in ${ms}ms` : `not measured: ${value}`)
  const mouseLine = describeProbe(mouse, ({ ms }) => `acknowledged in ${ms}ms`)
  const screenshotLine = describeProbe(screenshot, ({ ms, value }) => `${value} (${ms}ms)`)
  const freshProgress = fresh.progress ?? {}
  const freshSteps = [
    freshProgress.openedMs === undefined ? null : `opened in ${freshProgress.openedMs}ms`,
    freshProgress.clickedMs === undefined ? null : `clicked in ${freshProgress.clickedMs}ms`,
  ].filter(Boolean)
  const freshLine = fresh.outcome === 'answered'
    ? (fresh.value === null ? 'not tried: the stuck page has no browser to open one in' : [...freshSteps, `click ${fresh.value}`].join(', '))
    : [...freshSteps, `${describeProbe(fresh)} while ${freshProgress.stage ?? 'starting'}`].join(', ')
  return [
    `click stall evidence, taken ${afterMs}ms after the click started (each probe waits at most ${probeTimeoutMs}ms):`,
    `- page.evaluate on the stuck page: ${pageLine}`,
    `- next animation frame on the stuck page: ${frameLine}`,
    `- a new mouse move sent to the stuck page: ${mouseLine}`,
    `- screenshot of the stuck page: ${screenshotLine}`,
    `- a fresh page in the same browser: ${freshLine}`,
    `- Node event loop: longest delay ${eventLoopMaxMs}ms while the click waited`,
    `- runner CPU: ${cpuBusyPercent === null ? 'not measured' : `${cpuBusyPercent}% busy over ${clickStallCpuSampleMs}ms`}`,
  ].join('\n')
}

const eventLoop = monitorEventLoopDelay({ resolution: 20 })

/**
 * Takes the evidence for a click on `page` that has stalled since
 * `clickStartedAt` (a performance.now() reading). Never throws: a probe that
 * fails is part of the evidence.
 */
export async function takeClickStallEvidence(page, clickStartedAt, { probeTimeoutMs = clickStallProbeTimeoutMs, artifactsDir = clickStallArtifactsDir } = {}) {
  const afterMs = Math.round(performance.now() - clickStartedAt)
  // The frame, mouse and screenshot probes go through a CDP session of their
  // own, so each says what the browser itself did rather than what Playwright's
  // machinery around it did. Page.captureScreenshot also skips page.screenshot()'s
  // in-page preparation (hiding the caret, waiting for fonts). It still needs a
  // fresh frame, so while the page's main thread is held it waits like the rest
  // (e2e/click-stall.test.mjs makes exactly that happen).
  // Attaching is part of each probe's wait rather than a step before them, so
  // the whole report still costs one wait when the browser is slow to attach.
  const session = Promise.resolve().then(() => page.context().newCDPSession(page))
  session.catch(() => {})
  const viaSession = (send) => bounded(async () => send(await session), probeTimeoutMs)
  const file = path.join(artifactsDir, `${Date.now()}-${process.pid}.png`)
  const freshProgress = {}
  const [pageResult, frame, mouse, screenshot, fresh, cpuBusyPercent] = await Promise.all([
    bounded(() => page.evaluate(readStuckPageState), probeTimeoutMs),
    viaSession(async (cdp) => (await cdp.send('Runtime.evaluate', { expression: nextFrameExpression, awaitPromise: true, returnByValue: true })).result.value),
    viaSession((cdp) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 })),
    viaSession(async (cdp) => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
      await fs.mkdir(artifactsDir, { recursive: true })
      await fs.writeFile(file, Buffer.from(data, 'base64'))
      return path.relative(projectRoot, file)
    }),
    bounded(() => clickFreshPage(page, freshProgress), probeTimeoutMs),
    sampleRunnerCpu(clickStallCpuSampleMs),
  ])
  session.then((cdp) => cdp.detach()).catch(() => {})
  return formatClickStallEvidence({
    afterMs,
    probeTimeoutMs,
    page: pageResult,
    frame,
    mouse,
    screenshot,
    fresh: { ...fresh, progress: freshProgress },
    eventLoopMaxMs: Math.round(eventLoop.max / 1e6),
    cpuBusyPercent,
  })
}

const watchedPrototypes = new WeakSet()

/**
 * Makes every locator click in this process take the evidence above when it
 * stalls. Locators are made fresh by every getBy…/locator call, so the click
 * is wrapped once on their shared prototype, reached through any page; the
 * wrapper only adds to an error that was already going to fail the test.
 * The options of the first call apply to the whole process. Returns the page
 * so a fixture helper can wrap `newPage()` in one expression.
 */
export function watchClickStalls(page, options = {}) {
  const prototype = Object.getPrototypeOf(page.locator(':root'))
  if (watchedPrototypes.has(prototype)) return page
  watchedPrototypes.add(prototype)
  eventLoop.enable()
  const click = prototype.click
  prototype.click = async function clickTakingStallEvidence(...args) {
    const started = performance.now()
    eventLoop.reset()
    try {
      return await click.apply(this, args)
    } catch (error) {
      if (isStalledClick(error)) error.message += `\n${await takeClickStallEvidence(this.page(), started, options)}`
      throw error
    }
  }
  return page
}
