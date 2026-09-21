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

// Widening the budget above was the right answer for a fixture that mounts
// slowly. It is the wrong answer for the failure the Windows browser shard
// actually produces, which is a fixture that never mounts at all.
//
// Measured over the 196 quality runs between 2026-09-19 and 2026-09-21: the
// renderer-v2-browser shard failed 14 of its 141 completed runs (9.9%), and
// every one of those failures is a single page that died on its own — a mount
// wait that spent the whole 90s, a locator that spent 30s on an empty
// document, or net::ERR_NO_BUFFER_SPACE thrown 69ms into page.goto. The tests
// on either side of it finished in one or two seconds. Ten green runs of the
// same shard over the same period contain no test slower than 22.4s, none over
// 30s, and no error marker at all, so there is no continuum here that a bigger
// number would cover: a mount either lands well inside a quarter of the budget
// or it never lands.
//
// What a lost navigation needs is a new navigation, not more patience. The
// budget therefore stays exactly where it was and is spent as several
// navigations instead of one long stare at a dead page. A fixture that is
// genuinely broken still fails at the same deadline, now saying how many
// navigations it took to get there.
export const fixtureMountAttempts = Number(process.env.XINGMANG_FIXTURE_MOUNT_ATTEMPTS ?? 3)

/** 每次导航分到的预算。三次 30 秒仍然合计 90 秒，比绿跑上限 22.4 秒宽出一截。 */
export function fixtureMountSliceMs(timeout = fixtureReadyTimeoutMs, attempts = fixtureMountAttempts) {
  return Math.max(1, Math.floor(timeout / Math.max(1, attempts)))
}

/**
 * 打开一个夹具页并等它挂载，失败就重新导航，**总预算仍然是 `timeout`**：
 * 每次导航（含它的挂载等待）最多分到 `timeout / attempts`，而且一律不越过总截止。
 * `mount` 收到这一次导航还剩的毫秒数，自己决定怎么等。
 */
export async function openFixturePage(page, url, mount, options = {}) {
  const timeout = options.timeout ?? fixtureReadyTimeoutMs
  const attempts = Math.max(1, options.attempts ?? fixtureMountAttempts)
  const slice = fixtureMountSliceMs(timeout, attempts)
  const label = options.label ?? 'fixture'
  const deadline = Date.now() + timeout
  let failure
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const attemptStarted = Date.now()
    const attemptDeadline = Math.min(attemptStarted + slice, deadline)
    // Never hand Playwright a zero: it reads that as "no timeout at all", which
    // is the one thing a budget this shape must not accidentally grant.
    const remaining = () => attemptDeadline - Date.now()
    if (remaining() <= 0) break
    try {
      await page.goto(url, { timeout: remaining() })
      const left = remaining()
      if (left <= 0) throw new Error(`${label} navigated but had no budget left to mount in`)
      await mount(left)
      return page
    } catch (error) {
      failure = error
    }
    // Printed rather than swallowed: the next person reading a red shard needs
    // to see that the navigation was retried and still lost, which is what
    // separates a stalled runner from a fixture this suite really did break.
    // The reason matters as much as the count — a slice spent waiting and a
    // goto that threw in 69ms are different machines misbehaving.
    if (attempt < attempts) {
      const reason = String(failure?.message ?? failure).split('\n')[0]
      process.stderr.write(`[fixture] ${label} lost navigation ${attempt}/${attempts} after ${Date.now() - attemptStarted}ms, navigating again: ${reason}\n`)
    }
  }
  throw new Error(`${label} did not finish installing within ${timeout}ms after ${attempts} navigations`, { cause: failure })
}
