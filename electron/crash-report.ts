import { randomUUID } from 'node:crypto'
import { redactHomeDirectory } from './startup-log'

/**
 * Sentry ingest endpoint for the desktop client's crash reports. This is a
 * DSN public key, not a secret: it only authorizes *writing* events into one
 * project, which is why it ships as an ordinary constant rather than a build
 * secret. Rotating it means editing this line and releasing.
 */
export const crashReportDsn = 'https://6c08296eec4f5104b41bf192f9c4ddbe@o4512110916009984.ingest.us.sentry.io/4512110923350016'

/** Sentry's ingest hosts. A DSN pointing anywhere else is refused (I10/I12). */
const allowedIngestHostSuffix = '.ingest.sentry.io'
const allowedIngestRegionHostSuffix = /\.ingest\.[a-z0-9-]+\.sentry\.io$/

export interface CrashReportEndpoint {
  /** Full envelope URL including the ingest authentication query. */
  envelopeUrl: string
  /** Origin the response must still be on; a redirect elsewhere is refused. */
  origin: string
  projectId: string
}

export interface CrashReportFrame {
  filename: string
  function?: string
  lineno?: number
  colno?: number
  in_app: boolean
}

export interface CrashReportEvent {
  event_id: string
  timestamp: number
  platform: 'node'
  level: 'fatal' | 'error'
  logger: string
  release: string
  environment: string
  tags: Record<string, string>
  contexts: Record<string, Record<string, string | number>>
  exception: { values: [{ type: string; value: string; mechanism: { type: string; handled: boolean }; stacktrace?: { frames: CrashReportFrame[] } }] }
  extra?: Record<string, string>
}

export interface CrashReportInput {
  /** Which process and hook produced this, e.g. `main.uncaught-exception`. */
  mechanism: string
  source: 'main' | 'renderer'
  error: unknown
  level?: 'fatal' | 'error'
  /** Short free-text marker (a component stack, a renderer route). */
  context?: string
}

export interface CrashReportEnvironment {
  release: string
  environment: string
  homeDirectory: string
  appVersion: string
  electronVersion: string
  nodeVersion: string
  osPlatform: string
  osRelease: string
  arch: string
}

const MAX_MESSAGE_LENGTH = 2_048
const MAX_CONTEXT_LENGTH = 1_024
const MAX_FRAMES = 60

/**
 * Everything leaving this process goes through here first. The three classes
 * of payload we must never ship are credentials (a relay key in an error
 * message is a paid key someone else can spend), the account's own identity,
 * and the local account name that every absolute path carries. The patterns
 * intentionally duplicate `redactCommandText` rather than importing it:
 * `command-runner` drags the whole Windows path-resolution graph in, and a
 * crash reporter must keep working when that graph is what crashed.
 */
export function redactCrashText(value: string, homeDirectory: string): string {
  return redactHomeDirectory(value, homeDirectory)
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED]')
    // The optional quote after the key name is what `redactCommandText` lacks:
    // a stack trace carrying a serialized payload spells it `"api_key":"..."`.
    .replace(/((?:api[_-]?key|authorization|token|secret|password|cookie|credential)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;)\]}]+)/gi, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|token|key)=)[^&\s]+/gi, '$1[REDACTED]')
    // Other users' profiles, and this user's own when the home directory is
    // spelled differently than os.homedir() reports it (a junction, a mapped
    // drive, a UNC path). `redactHomeDirectory` only knows the one spelling.
    .replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/:*?"<>|\r\n]+/gi, '$1%USER%')
    .replace(/(\/Users\/)[^/\s:"'\\]+/g, '$1%USER%')
    .replace(/(\/home\/)[^/\s:"'\\]+/g, '$1%USER%')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]')
}

/**
 * Rejects anything that is not an https Sentry ingest DSN. The DSN is a
 * constant today, but the parse is what guarantees a future edit cannot point
 * the reporter at an arbitrary host carrying our users' stack traces.
 */
export function parseCrashReportDsn(dsn: string, clientName: string): CrashReportEndpoint | null {
  let url: URL
  try {
    url = new URL(dsn)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.port || url.password || url.search || url.hash) return null
  const host = url.hostname.toLowerCase()
  if (!host.endsWith(allowedIngestHostSuffix) && !allowedIngestRegionHostSuffix.test(host)) return null
  const publicKey = url.username
  if (!/^[A-Za-z0-9]{8,64}$/.test(publicKey)) return null
  const projectId = url.pathname.replace(/^\/+/, '')
  if (!/^[0-9]{1,20}$/.test(projectId)) return null
  const envelope = new URL(`https://${host}/api/${projectId}/envelope/`)
  envelope.searchParams.set('sentry_version', '7')
  envelope.searchParams.set('sentry_client', clientName)
  envelope.searchParams.set('sentry_key', publicKey)
  return { envelopeUrl: envelope.href, origin: envelope.origin, projectId }
}

function describeError(error: unknown): { type: string; value: string; stack: string } {
  if (error instanceof Error) {
    return {
      type: error.name || 'Error',
      value: error.message || '未知错误',
      stack: typeof error.stack === 'string' ? error.stack : '',
    }
  }
  if (typeof error === 'string') return { type: 'Error', value: error || '未知错误', stack: '' }
  let value: string
  try {
    value = JSON.stringify(error) ?? String(error)
  } catch {
    value = String(error)
  }
  return { type: 'Error', value: value || '未知错误', stack: '' }
}

const framePattern = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/

/**
 * Sentry orders frames oldest first, which is the reverse of a V8 stack. Lines
 * that do not parse are dropped rather than guessed at: a half-parsed frame
 * points reviewers at the wrong line, which is worse than one fewer frame.
 */
export function parseCrashStackFrames(stack: string, homeDirectory: string): CrashReportFrame[] {
  const frames: CrashReportFrame[] = []
  for (const line of stack.split('\n')) {
    const match = framePattern.exec(line)
    if (!match) continue
    const rawFilename = match[2]
    const filename = redactCrashText(rawFilename, homeDirectory)
    frames.push({
      filename,
      ...(match[1] ? { function: redactCrashText(match[1], homeDirectory).slice(0, 200) } : {}),
      lineno: Number(match[3]),
      colno: Number(match[4]),
      // node_modules and Electron internals are not ours to fix; marking them
      // out of app is what makes Sentry group on our own frame.
      in_app: !rawFilename.includes('node_modules') && !rawFilename.startsWith('node:'),
    })
    if (frames.length >= MAX_FRAMES) break
  }
  return frames.reverse()
}

export function buildCrashReportEvent(
  input: CrashReportInput,
  runtime: CrashReportEnvironment,
  now: Date,
  eventId = randomUUID().replaceAll('-', ''),
): CrashReportEvent {
  const described = describeError(input.error)
  const frames = parseCrashStackFrames(described.stack, runtime.homeDirectory)
  const context = input.context
    ? redactCrashText(input.context, runtime.homeDirectory).slice(0, MAX_CONTEXT_LENGTH)
    : ''
  return {
    event_id: eventId,
    timestamp: Math.floor(now.getTime() / 1000),
    platform: 'node',
    level: input.level ?? 'error',
    logger: input.source,
    release: runtime.release,
    environment: runtime.environment,
    tags: {
      process: input.source,
      mechanism: input.mechanism,
      'app.version': runtime.appVersion,
      'os.platform': runtime.osPlatform,
      'os.arch': runtime.arch,
    },
    contexts: {
      app: { app_version: runtime.appVersion },
      os: { name: runtime.osPlatform, version: runtime.osRelease },
      runtime: { name: 'electron', version: runtime.electronVersion },
      device: { arch: runtime.arch },
    },
    exception: {
      values: [{
        type: redactCrashText(described.type, runtime.homeDirectory).slice(0, 200),
        value: redactCrashText(described.value, runtime.homeDirectory).slice(0, MAX_MESSAGE_LENGTH),
        mechanism: { type: input.mechanism, handled: false },
        ...(frames.length ? { stacktrace: { frames } } : {}),
      }],
    },
    ...(context ? { extra: { context } } : {}),
  }
}

/**
 * Serializes one event as a Sentry envelope. Deliberately the only shape this
 * module can produce: no breadcrumbs, no sessions, no attachments, no user or
 * request item — the payload is exactly the event built above.
 */
export function buildCrashReportEnvelope(event: CrashReportEvent, sentAt: Date): string {
  const payload = JSON.stringify(event)
  const header = JSON.stringify({ event_id: event.event_id, sent_at: sentAt.toISOString() })
  const itemHeader = JSON.stringify({
    type: 'event',
    content_type: 'application/json',
    length: Buffer.byteLength(payload, 'utf8'),
  })
  return `${header}\n${itemHeader}\n${payload}\n`
}

/**
 * Two crashes with the same signature within one session are the same bug;
 * a crash loop must not turn into hundreds of identical events.
 */
export function crashReportSignature(event: CrashReportEvent): string {
  const value = event.exception.values[0]
  const top = value.stacktrace?.frames.at(-1)
  return [
    value.type,
    value.value,
    event.tags.mechanism,
    top ? `${top.filename}:${top.lineno ?? 0}:${top.colno ?? 0}` : '',
  ].join('|')
}

/**
 * Set to '1' to silence the reporter regardless of the stored preference.
 * Exists for packaged smoke runs and for support to tell a user "turn it off
 * for one launch" without touching their settings file.
 */
export const crashReportingDisableEnvironmentKey = 'XINGMANG_DISABLE_CRASH_REPORTING'

/**
 * Set to '1' to send one synthetic event at startup. The only way to confirm
 * end to end that a *packaged* build reaches the dashboard without waiting for
 * a real crash; it obeys the preference and the packaged check like any other
 * report.
 */
export const crashReportSelfTestEnvironmentKey = 'XINGMANG_CRASH_REPORT_TEST'

export function shouldReportCrashes(input: {
  packaged: boolean
  crashReporting?: boolean
  env?: NodeJS.ProcessEnv
}): boolean {
  // Development builds crash constantly and on purpose; their stacks would
  // bury the releases that matter.
  if (!input.packaged) return false
  if (input.env?.[crashReportingDisableEnvironmentKey] === '1') return false
  // Absent = 开启。Only an explicit false is an opt-out (see app-settings.ts).
  return input.crashReporting !== false
}
