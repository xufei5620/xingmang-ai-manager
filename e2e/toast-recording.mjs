import assert from 'node:assert/strict'

// Short toasts delete themselves 2400ms after they appear (toastDurationMs in
// src/renderer-v2/ui/feedback.tsx; a long sentence gets a little longer), so a
// locator that only starts looking after that deadline waits out its whole
// budget on an element that is never coming back. A slow Windows runner hit
// exactly that between the save click and the toast assertion: the grok
// configuration cases in app-check timed out at 30s while their faster siblings
// passed in a couple of seconds (#198). The account, settings, records and
// chat suites still waited on the live toast the same way; making every short
// toast expire after 1ms failed fourteen of their tests and none of app-check's.
//
// So every renderer-v2 suite records each toast as it is inserted and asserts
// against the recording, which cannot expire. A toast is only ever removed a
// whole task later, so the observer callback always runs while the node is
// still in the document. Install it before the page loads:
// page.addInitScript(recordToasts).
export function recordToasts() {
  const log = { entries: [], consumed: 0 }
  const seen = new WeakSet()
  window.__v2Toasts = log
  function collect() {
    for (const toast of document.querySelectorAll('.xm-toasts .xm-toast')) {
      if (seen.has(toast)) continue
      seen.add(toast)
      log.entries.push({ text: toast.textContent ?? '', role: toast.getAttribute('role') ?? '' })
    }
  }
  new MutationObserver(collect).observe(document, { childList: true, subtree: true })
}

// `consumed` marks how far the recording has been read, so a second save cannot
// be satisfied by the toast the first save left behind.
export async function waitForToast(page, text) {
  await page.waitForFunction((expected) => {
    const log = window.__v2Toasts
    const index = log.entries.findIndex((entry, position) => position >= log.consumed && entry.role === 'status' && entry.text === expected)
    if (index < 0) return false
    log.consumed = index + 1
    return true
  }, text)
}

export async function assertNoToast(page, text) {
  const shown = await page.evaluate((expected) => window.__v2Toasts.entries.slice(window.__v2Toasts.consumed).filter((entry) => entry.text === expected).length, text)
  assert.equal(shown, 0, `不应出现「${text}」提示`)
}
