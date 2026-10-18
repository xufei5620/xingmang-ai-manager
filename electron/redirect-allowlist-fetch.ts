export interface RedirectAllowlist {
  /**
   * Parses one URL the download is about to touch and throws unless it may: the first URL,
   * every Location, and the URL a response reports it came from. A policy that pins every
   * hop to one resource captures the first URL in a closure.
   */
  validate: (candidate: string) => URL
  /** Hops followed after the first request; one more redirect than this is refused. */
  maximumRedirects: number
  /** Subject of every error this helper raises, such as 'Node.js 下载' or '下载'. */
  label: string
  /**
   * Wording a caller's customers already read, kept as it was when that caller moved onto this
   * helper. Whatever is left out reads `${label}…`.
   */
  messages?: Partial<RedirectAllowlistMessages>
  /**
   * What a redirect past `maximumRedirects` gets: refused (the default), or handed back
   * unfollowed, body untouched, for the caller to judge. A resumed download asks with no
   * redirects left and 'return', so it never follows an entry point that has meanwhile moved
   * on to a newer file than the one it started.
   */
  beyondLimit?: 'refuse' | 'return'
}

/** The errors this helper raises itself; the allow-list's own come from `validate`. */
export interface RedirectAllowlistMessages {
  loop: string
  bypass: string
  tooMany: string
  missingLocation: string
}

export interface RedirectAllowlistLanding {
  response: Response
  /**
   * The hop that answered. `response.url` cannot stand in for it: the Chromium fetch the
   * downloads run on leaves it empty (manual-redirect-fetch.ts).
   */
  url: URL
}

const redirectStatuses = new Set([301, 302, 303, 307, 308])

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

/**
 * Follows redirects one hop at a time so that every hop is held to the allow-list (I10), and
 * says which hop answered.
 *
 * The fetch is always told `redirect: 'manual'`, whatever the caller passed: a fetch that
 * followed redirects on its own would decide the host before any check ran. For the same
 * reason a response whose own URL is not exactly the hop that was requested is refused,
 * even when that URL would be allowed. A hop seen twice is a loop. Non-redirect responses,
 * error statuses included, go back to the caller, who judges them.
 */
export async function fetchLandingWithRedirectAllowlist(
  url: string,
  init: RequestInit,
  fetchImplementation: typeof globalThis.fetch,
  allowlist: RedirectAllowlist,
): Promise<RedirectAllowlistLanding> {
  const { validate, maximumRedirects, label, messages = {}, beyondLimit = 'refuse' } = allowlist
  // NaN would never compare as reached, leaving only the loop check between an allow-list
  // that admits endless distinct URLs and an endless chain of requests.
  if (!Number.isSafeInteger(maximumRedirects) || maximumRedirects < 0) {
    throw new Error(`${label}重定向上限无效`)
  }
  let current = validate(url)
  const visited = new Set<string>()
  for (let redirects = 0; ; redirects += 1) {
    if (visited.has(current.href)) throw new Error(messages.loop ?? `${label}发生了循环重定向`)
    visited.add(current.href)
    const response = await fetchImplementation(current.href, { ...init, redirect: 'manual' })
    let next: URL
    try {
      if (response.url && validate(response.url).href !== current.href) {
        throw new Error(messages.bypass ?? `${label}绕过了受限的重定向策略`)
      }
      if (!redirectStatuses.has(response.status)) return { response, url: current }
      if (redirects >= maximumRedirects) {
        if (beyondLimit === 'return') return { response, url: current }
        throw new Error(messages.tooMany ?? `${label}重定向次数过多`)
      }
      const location = response.headers.get('location')
      if (!location) throw new Error(messages.missingLocation ?? `${label}重定向缺少 Location`)
      next = validate(new URL(location, current).href)
    } catch (error) {
      await discardBody(response)
      throw error
    }
    await discardBody(response)
    current = next
  }
}

/** `fetchLandingWithRedirectAllowlist` for callers that only need the response. */
export async function fetchWithRedirectAllowlist(
  url: string,
  init: RequestInit,
  fetchImplementation: typeof globalThis.fetch,
  allowlist: RedirectAllowlist,
): Promise<Response> {
  return (await fetchLandingWithRedirectAllowlist(url, init, fetchImplementation, allowlist)).response
}
