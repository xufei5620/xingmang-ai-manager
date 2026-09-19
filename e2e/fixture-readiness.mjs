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
