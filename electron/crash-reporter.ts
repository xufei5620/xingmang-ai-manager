import { readBoundedResponseText } from './bounded-response'
import {
  buildCrashReportEnvelope,
  buildCrashReportEvent,
  crashReportSignature,
  parseCrashReportDsn,
  type CrashReportEndpoint,
  type CrashReportEnvironment,
  type CrashReportInput,
} from './crash-report'

export interface CrashReporterOptions {
  dsn: string
  runtime: CrashReportEnvironment
  /** Re-read on every report so turning the switch off takes effect at once. */
  isEnabled: () => boolean
  /** Narrower than `typeof fetch` on purpose: this module only ever posts to
   *  one absolute https URL, so the host can hand over net.fetch without any
   *  Request/URL overload juggling. */
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>
  clientName: string
  now?: () => Date
  /** Send failures are recorded locally; they are never retried or surfaced. */
  onSendFailure?: (error: unknown) => void
  maxEventsPerSession?: number
  timeoutMs?: number
}

export interface CrashReporter {
  /** False when the DSN is unusable; the switch is consulted per report. */
  readonly configured: boolean
  report(input: CrashReportInput): void
  /** Resolves once every queued send has settled. Used by tests and shutdown. */
  flush(): Promise<void>
}

const DEFAULT_MAX_EVENTS = 20
const DEFAULT_TIMEOUT_MS = 8_000
const MAX_RESPONSE_BYTES = 16 * 1024
const redirectStatuses = new Set([301, 302, 303, 307, 308])

export function inactiveCrashReporter(): CrashReporter {
  return { configured: false, report: () => undefined, flush: () => Promise.resolve() }
}

async function postEnvelope(
  endpoint: CrashReportEndpoint,
  body: string,
  options: CrashReporterOptions,
): Promise<'sent' | 'stop'> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  timeout.unref?.()
  try {
    const response = await options.fetchImpl(endpoint.envelopeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-sentry-envelope' },
      body,
      // The ingest endpoint never sets cookies we want, and the Electron
      // session jar holds the account's own refresh cookie (I3).
      credentials: 'omit',
      // A redirect would carry the stack trace to a host the DSN never named.
      redirect: 'manual',
      signal: controller.signal,
    })
    if (redirectStatuses.has(response.status)) return 'stop'
    if (response.url) {
      let responseOrigin = ''
      try {
        responseOrigin = new URL(response.url).origin
      } catch {
        return 'stop'
      }
      if (responseOrigin !== endpoint.origin) return 'stop'
    }
    // Read the body so the connection can close, but never act on it: nothing
    // the ingest endpoint answers changes what this process does next.
    await readBoundedResponseText(response, MAX_RESPONSE_BYTES, '崩溃上报').catch(() => '')
    // 429 (rate limited) and 413 (too large) mean the project is refusing this
    // client for a while. Retrying inside a crash loop only makes it worse.
    return response.status === 429 || response.status === 413 ? 'stop' : 'sent'
  } finally {
    clearTimeout(timeout)
  }
}

export function createCrashReporter(options: CrashReporterOptions): CrashReporter {
  const endpoint = parseCrashReportDsn(options.dsn, options.clientName)
  if (!endpoint) return inactiveCrashReporter()

  const now = options.now ?? (() => new Date())
  const maxEvents = options.maxEventsPerSession ?? DEFAULT_MAX_EVENTS
  const seen = new Set<string>()
  let sent = 0
  let stopped = false
  let queue: Promise<void> = Promise.resolve()

  return {
    configured: true,
    report(input: CrashReportInput): void {
      if (stopped || sent >= maxEvents || !options.isEnabled()) return
      let body: string
      let signature: string
      try {
        const event = buildCrashReportEvent(input, options.runtime, now())
        signature = crashReportSignature(event)
        if (seen.has(signature)) return
        body = buildCrashReportEnvelope(event, now())
      } catch (error) {
        options.onSendFailure?.(error)
        return
      }
      seen.add(signature)
      sent += 1
      queue = queue.then(async () => {
        // Re-checked inside the queued slot: the user may have switched the
        // reporter off while an earlier envelope was still in flight.
        if (stopped || !options.isEnabled()) return
        try {
          if (await postEnvelope(endpoint, body, options) === 'stop') stopped = true
        } catch (error) {
          options.onSendFailure?.(error)
        }
      })
    },
    flush(): Promise<void> {
      return queue.then(() => undefined, () => undefined)
    },
  }
}
