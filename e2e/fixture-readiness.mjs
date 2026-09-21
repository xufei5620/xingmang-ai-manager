// Waiting for a browser fixture to finish mounting is not what any of these
// suites assert, so it gets a budget of its own instead of silently borrowing
// Playwright's 30s action default.
//
// A cold page open is far slower on a Windows runner than anywhere else: every
// browser.newPage() is a fresh context with an empty cache, so the whole module
// graph is re-requested from the Vite dev server, behind Defender, at the end of
// a twenty minute job. Quality run #264 measured one such open at over 30s in
// e2e/maintenance-pages-interactions.test.mjs while both of its warm siblings
// finished in under a second, and run #284 measured 30s for the first
// parameterised app-check case against 2.3s for the four that reused the warm
// fixture. What failed there was the mount, reported as though the assertion
// after it had failed.
//
// Only the mount wait gets this budget. Every assertion that follows keeps the
// default, so a genuine regression still fails in 30s.
export const fixtureReadyTimeoutMs = Number(process.env.XINGMANG_FIXTURE_READY_TIMEOUT_MS ?? 90_000)

// The other side of the same problem, for the Electron smokes: Playwright drives
// ElectronApplication.evaluate through the main process's Node inspector, and V8
// can collect the inspector's promise wrapper while that process is busy (#124,
// #128, #139). The replay that covers it used to wait a flat 500ms three times,
// so on a Windows runner all three landed inside a single Defender stall — run
// #236 spent the whole allowance between 131.0s and 132.0s and took the packaging
// job down with it. Backing off spreads the replays across the stall instead, and
// the parameters live here so a run that needs more patience widens without any
// suite restating a number of its own.
export const collectedPromiseAttempts = Number(process.env.XINGMANG_COLLECTED_PROMISE_ATTEMPTS ?? 4)
export const collectedPromiseBackoffMs = Number(process.env.XINGMANG_COLLECTED_PROMISE_BACKOFF_MS ?? 500)
// Four attempts back off 500/1000/2000; the cap only bites once the attempt
// count is widened, and keeps a single replay from outlasting the step budget.
export const collectedPromiseBackoffCapMs = Number(process.env.XINGMANG_COLLECTED_PROMISE_BACKOFF_CAP_MS ?? 4_000)

// Exponential with a ceiling, expressed once so the smoke and its gate agree.
export function collectedPromiseBackoffFor(attempt) {
  return Math.min(collectedPromiseBackoffCapMs, collectedPromiseBackoffMs * 2 ** (attempt - 1))
}

// page.goto resolves on `load`, which says nothing about a Vite fixture: the
// module graph is transformed on demand and the page is reloaded outright once
// a dependency has to be pre-bundled. A suite that starts asserting there finds
// an empty document, and whichever locator it starts with absorbs the whole
// cold start inside its own 30s budget - then reports the element it was
// waiting for rather than the mount that never happened. Every fixture mounts
// into #root, so a first commit there is the one signal they all share.
//
// Poll from Node rather than with Playwright's in-page polling, because a page
// opened with an installed clock has its timers and requestAnimationFrame
// paused (src/renderer-v2/features/acceleration/browser-check.mjs freezes both
// before it navigates).
export async function waitForFixtureMount(page, { ready = firstCommit, timeout = fixtureReadyTimeoutMs, what = 'the browser fixture' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    // A reload mid-evaluation destroys the execution context; the next poll
    // runs against the page the reload produced.
    const mounted = await page.evaluate(ready).catch(() => false)
    if (mounted) return
    if (Date.now() >= deadline) throw new Error(`${what} did not finish installing within ${timeout}ms`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

// Evaluated in the page, so it may not close over anything here.
function firstCommit() {
  return (document.getElementById('root')?.childElementCount ?? 0) > 0
}
