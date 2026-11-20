import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { after, before, test } from 'node:test'
import { formatClickStallEvidence, isStalledClick, takeClickStallEvidence } from './click-stall.mjs'
import { openFixturePage } from './fixture-readiness.mjs'
import { createBrowserFixture } from './harness.mjs'

// The evidence in click-stall.mjs only ever runs on the rare red run it exists
// for, so nothing else would notice it breaking. This makes a click stall for
// real, the way the Windows ones did (mouse events sent, nothing back), through
// a page the harness handed out, and checks the evidence arrives on the error
// without the probes hanging the test.

const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-click-stall-'))
const stall = createBrowserFixture({
  cacheDir: 'node_modules/.vite-click-stall',
  clickStall: { probeTimeoutMs: 1_500, artifactsDir },
})
before(async () => {
  await stall.start()
})
after(async () => {
  await stall.stop()
  await fs.rm(artifactsDir, { recursive: true, force: true })
  stall.assertNoPageErrors()
})

// The page holds its main thread for a while on the first mouse move over the
// button, so the click's own move is never acknowledged before the click's
// timeout: exactly the call log the Windows runs ended on. Listening on the
// button rather than the window keeps Chromium's synthetic moves at the
// page's corner from setting it off before the click.
const busyOnMouseMove = `<!doctype html><button style="position:fixed;left:40px;top:40px;width:200px;height:80px">更换头像</button>
<script>
  document.querySelector('button').addEventListener('mousemove', () => { const until = Date.now() + 4500; while (Date.now() < until) {} }, { once: true })
</script>`

test('a click that stalls after its mouse events went out carries the evidence on its error', async () => {
  const page = await stall.newPage()
  try {
    await openFixturePage(page, `data:text/html;charset=utf-8,${encodeURIComponent(busyOnMouseMove)}`, (timeout) => page.getByRole('button').waitFor({ timeout }), { label: 'click stall fixture' })
    const started = Date.now()
    const error = await page.getByRole('button', { name: '更换头像', exact: true }).click({ timeout: 1_000 }).then(() => null, (failure) => failure)
    assert.ok(error, 'the click was meant to stall')
    const marker = error.message.indexOf('\nclick stall evidence')
    assert.ok(marker > 0, `the stalled click should carry the evidence:\n${error.message}`)
    // What Playwright wrote is untouched and still reads as a stall; the
    // evidence follows it.
    assert.equal(isStalledClick(Object.assign(new Error(error.message.slice(0, marker)), { name: error.name })), true)
    const evidence = error.message.slice(marker + 1)
    // The page is still inside its busy loop, so nothing that needs its main
    // thread answers, while an unrelated page in the same browser still takes a
    // click: the reading that says "this page", not "this browser".
    assert.match(evidence, /- page\.evaluate on the stuck page: no answer within 1500ms/)
    assert.match(evidence, /- next animation frame on the stuck page: no answer within 1500ms/)
    assert.match(evidence, /- a new mouse move sent to the stuck page: no answer within 1500ms/)
    assert.match(evidence, /- screenshot of the stuck page: (no answer within 1500ms|\S+\.png \(\d+ms\))/)
    assert.match(evidence, /- a fresh page in the same browser: opened in \d+ms, clicked in \d+ms, click landed/)
    assert.match(evidence, /- Node event loop: longest delay \d+ms while the click waited/)
    assert.match(evidence, /- runner CPU: (\d+% busy over 500ms|not measured)/)
    // Probes run side by side. One after another, the four that cannot answer
    // here would take the click's timeout plus four probe waits (7s); side by
    // side it is the timeout plus one wait, with room to spare on a slow runner.
    assert.ok(Date.now() - started < 1_000 + 1_500 * 3, `the evidence took ${Date.now() - started}ms`)
  } finally {
    await page.close()
  }
})

test('on a page that is not stuck every probe answers and the screenshot is saved', async () => {
  const page = await stall.newPage()
  try {
    await openFixturePage(page, `data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><dialog open>更换头像</dialog>')}`, (timeout) => page.locator('dialog').waitFor({ timeout }), { label: 'healthy page' })
    const evidence = await takeClickStallEvidence(page, performance.now(), { probeTimeoutMs: 3_000, artifactsDir })
    assert.match(evidence, /- page\.evaluate on the stuck page: answered in \d+ms \(open dialogs 1, focused yes, visible, active element body\)/)
    assert.match(evidence, /- next animation frame on the stuck page: drawn in \d+ms/)
    assert.match(evidence, /- a new mouse move sent to the stuck page: acknowledged in \d+ms/)
    assert.match(evidence, /- a fresh page in the same browser: opened in \d+ms, clicked in \d+ms, click landed/)
    const shot = evidence.match(/- screenshot of the stuck page: (\S+\.png) \(\d+ms\)/)
    assert.ok(shot, evidence)
    const bytes = await fs.readFile(path.join(artifactsDir, path.basename(shot[1])))
    assert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG')
  } finally {
    await page.close()
  }
})

test('only a click that timed out after sending its events counts as stalled', () => {
  const callLog = (...lines) => Object.assign(new Error(['locator.click: Timeout 7000ms exceeded.', 'Call log:', ...lines.map((line) => `\u001b[2m  ${line}\u001b[22m`), ''].join('\n')), { name: 'TimeoutError' })
  const reachedTheClick = [
    "- waiting for getByRole('button', { name: '更换头像', exact: true })",
    '  - locator resolved to <button type="button" class="xm-btn xm-btn-secondary xm-btn-md">…</button>',
    '- attempting click action',
    '  - waiting for element to be visible, enabled and stable',
    '  - element is visible, enabled and stable',
    '  - scrolling into view if needed',
    '  - done scrolling',
    '  - performing click action',
  ]
  // The call log of 2026-11-20 (#2003), dim escapes and all.
  assert.equal(isStalledClick(callLog(...reachedTheClick)), true)
  // Covered, never visible or never stable is the test's own failure.
  assert.equal(isStalledClick(callLog(...reachedTheClick.slice(0, 4))), false)
  assert.equal(isStalledClick(callLog(...reachedTheClick, '  - <div class="xm-modal"> intercepts pointer events', '  - retrying click action')), false)
  // Only a timeout: a click that threw for another reason is not a stall.
  assert.equal(isStalledClick(Object.assign(callLog(...reachedTheClick), { name: 'Error' })), false)
  assert.equal(isStalledClick(undefined), false)
})

test('the evidence names what each probe tried and how it went', () => {
  const text = formatClickStallEvidence({
    afterMs: 7004,
    probeTimeoutMs: 3000,
    page: { outcome: 'answered', ms: 3, value: { openDialogs: 1, focused: true, visibility: 'visible', active: 'button' } },
    frame: { outcome: 'timeout', ms: 3000 },
    mouse: { outcome: 'failed', ms: 12, reason: 'Target closed' },
    screenshot: { outcome: 'answered', ms: 40, value: 'artifacts/click-stall/1-2.png' },
    fresh: { outcome: 'timeout', ms: 3000, progress: { stage: 'clicking', openedMs: 120 } },
    eventLoopMaxMs: 22,
    cpuBusyPercent: 97,
  })
  assert.equal(text, [
    'click stall evidence, taken 7004ms after the click started (each probe waits at most 3000ms):',
    '- page.evaluate on the stuck page: answered in 3ms (open dialogs 1, focused yes, visible, active element button)',
    '- next animation frame on the stuck page: no answer within 3000ms',
    '- a new mouse move sent to the stuck page: failed after 12ms: Target closed',
    '- screenshot of the stuck page: artifacts/click-stall/1-2.png (40ms)',
    '- a fresh page in the same browser: opened in 120ms, no answer within 3000ms while clicking',
    '- Node event loop: longest delay 22ms while the click waited',
    '- runner CPU: 97% busy over 500ms',
  ].join('\n'))
  // A page with Playwright's clock frozen says so instead of reporting a missing frame.
  const frozen = formatClickStallEvidence({
    afterMs: 5001,
    probeTimeoutMs: 3000,
    page: { outcome: 'timeout', ms: 3000 },
    frame: { outcome: 'answered', ms: 2, value: 'clock installed' },
    mouse: { outcome: 'failed', ms: 4, reason: 'Target page, context or browser has been closed' },
    screenshot: { outcome: 'timeout', ms: 3000 },
    fresh: { outcome: 'answered', ms: 200, value: 'landed', progress: { stage: 'reading', openedMs: 150, clickedMs: 30 } },
    eventLoopMaxMs: 0,
    cpuBusyPercent: null,
  })
  assert.match(frozen, /- page\.evaluate on the stuck page: no answer within 3000ms/)
  assert.match(frozen, /- next animation frame on the stuck page: not measured: clock installed/)
  assert.match(frozen, /- a new mouse move sent to the stuck page: failed after 4ms: Target page, context or browser has been closed/)
  assert.match(frozen, /- screenshot of the stuck page: no answer within 3000ms/)
  assert.match(frozen, /- a fresh page in the same browser: opened in 150ms, clicked in 30ms, click landed/)
  assert.match(frozen, /- runner CPU: not measured/)
})
