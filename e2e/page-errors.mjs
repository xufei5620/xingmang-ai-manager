import assert from 'node:assert/strict'

// An uncaught exception or an unhandled rejection inside a fixture is invisible
// to a suite that only asserts on the handful of elements it touches: React
// keeps whatever it had already committed on screen, every locator still
// resolves, and the run stays green while a page the user would see as broken
// went past. Recording `pageerror` and failing on it is the only thing that
// catches a break outside the assertions' reach, so every browser suite in this
// directory collects into one of these and empties it before it finishes.
export function createPageErrorCollector() {
  const errors = []
  return {
    /** Returns the page it was given so a fixture helper can wrap `newPage()` in one expression. */
    watch(page) {
      page.on('pageerror', (error) => errors.push(`${page.url()}: ${error.message}`))
      return page
    },
    assertNone() {
      assert.deepEqual(errors, [])
    },
  }
}
