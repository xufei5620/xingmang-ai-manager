import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { InstallCancelledError } from './install-cancellation'
import { createRelayEndpointRoutingSnapshot } from './relay-sites'
import {
  addUsageEvent,
  buildUsageStatsPath,
  emptyUsageStatsState,
  isMainProcessStall,
  parseUsageCounters,
  parseUsageStatsState,
  resolveUsageOs,
  resolveUsageUpdateState,
  serializeUsageStatsState,
  shouldSendUsageStats,
  subtractUsageCounters,
  usageAccountKind,
  usageCounterCap,
  usageCounterMaxAgeMs,
  usageEventForOperation,
  usageEventForUpdate,
  usageFailureCategory,
  usageRouteChoice,
  usageStatsDay,
  usageStatsOrigins,
  usageToolInventory,
  withoutExpiredCounters,
  type UsageStatsCounters,
  type UsageStatsEvent,
  type UsageStatsSnapshot,
} from './usage-stats'

// The workflow decodes the same sample (scripts/update-feed-stats.test.cjs), so a code
// renamed on one side only turns one of the two tests red.
const sharedSample = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'fixtures', 'usage-stats-path.txt'), 'utf8').trim()

function snapshot(overrides: Partial<UsageStatsSnapshot> = {}): UsageStatsSnapshot {
  return {
    appVersion: '0.2.22',
    os: 'w11',
    arch: 'x64',
    account: 'xm',
    route: { preference: 'auto', line: 'direct' },
    autoUpdate: true,
    update: { state: 'downloaded', version: '0.2.23' },
    tools: {
      clis: { claude: '2.1.310', codex: null },
      gemini: true,
      desktops: { codexDesktop: false, claudeDesktop: true, opencode: false },
    },
    ...overrides,
  }
}

function countersOf(...events: UsageStatsEvent[]): UsageStatsCounters {
  return events.reduce<UsageStatsCounters>((counters, event) => addUsageEvent(counters, event), {})
}

const sampleCounters = countersOf(
  { kind: 'install', target: 'claude', category: 'network' },
  { kind: 'install', target: 'claude', category: 'network' },
  { kind: 'install', target: 'node', category: 'machine' },
  { kind: 'update', step: 'download', category: 'network' },
  { kind: 'hang', hang: 'stall' },
  { kind: 'hang', hang: 'stall' },
  { kind: 'hang', hang: 'stall' },
  { kind: 'hang', hang: 'unresponsive' },
)

describe('usage stats path', () => {
  it('builds the shared sample the workflow decodes', () => {
    expect(buildUsageStatsPath('20261027', snapshot(), sampleCounters)).toBe(sharedSample)
  })

  it('only ever sends to the two fixed origins over https', () => {
    expect(usageStatsOrigins).toEqual(['https://updatesnew.shenfengwl.fun', 'https://xm-direct.solov.cc'])
  })

  it('turns anything outside the closed vocabulary into a placeholder instead of free text', () => {
    const built = buildUsageStatsPath('20261027', snapshot({
      appVersion: 'C:\\Users\\yoyo\\星芒',
      os: 'Windows 11 Pro',
      arch: 'mips',
      route: null,
      tools: { clis: { claude: 'sk-abc/../../etc', codex: '', grok: '1.0.70' }, gemini: null, desktops: {} },
      update: { state: 'install-failed', version: '0.2.23 ; rm -rf' },
    }), { 'i~cc~net': 3, 'C:\\secret': 5, 'h~w': 1.5 })
    expect(built).toBe('/xingmang-manager/stats/v1/d-20261027/a-x/o-x/c-x/k-xm/r-x/u-1/s-ff~x'
      + '/t-cc~v_cx~v_gk~1.0.70_gm~x_cdx~x_cd~x_wb~x_oc~x/i-cc~net~3/f-0/h-0')
    expect(built).toMatch(/^[A-Za-z0-9/._~-]+$/)
  })

  it('writes nothing counted and nothing detected as such, and refuses a malformed day', () => {
    expect(buildUsageStatsPath('20261027', snapshot({
      account: 'none',
      autoUpdate: false,
      update: { state: 'current' },
      route: { preference: 'primary', line: 'primary' },
      tools: { clis: {}, gemini: null, desktops: {} },
    }), {})).toBe('/xingmang-manager/stats/v1/d-20261027/a-0.2.22/o-w11/c-x64/k-no/r-m1/u-0/s-ok'
      + '/t-cc~x_cx~x_gk~x_gm~x_cdx~x_cd~x_wb~x_oc~x/i-0/f-0/h-0')
    expect(buildUsageStatsPath('2026-10-27', snapshot(), {})).toBeNull()
  })

  it('keeps the path short even with every counter at its cap', () => {
    let counters: UsageStatsCounters = {}
    const targets = ['claude', 'codex', 'grok', 'codexDesktop', 'claudeDesktop', 'workbuddy', 'opencode', 'node', 'git', 'python'] as const
    const categories = ['machine', 'certificate', 'network', 'source', 'other'] as const
    for (let round = 0; round < 120; round += 1) {
      for (const target of targets) for (const category of categories) counters = addUsageEvent(counters, { kind: 'install', target, category })
    }
    expect(Object.values(counters).every((count) => count === usageCounterCap)).toBe(true)
    const built = buildUsageStatsPath('20261027', snapshot(), counters)
    expect(built).not.toBeNull()
    expect(built!.length).toBeLessThanOrEqual(1500)
  })
})

describe('usage stats counters and state', () => {
  it('subtracts what was sent and keeps what arrived meanwhile', () => {
    expect(subtractUsageCounters({ 'h~w': 3, 'h~s': 1, 'i~cc~net': 2 }, { 'h~w': 2, 'h~s': 1 })).toEqual({ 'h~w': 1, 'i~cc~net': 2 })
  })

  it('reads back only known keys with positive whole counts, capped', () => {
    expect(parseUsageCounters({ 'h~w': 2, 'h~s': 500, 'i~cc~net': 0, 'i~zz~net': 1, 'f~dl~net': 1.5, 'f~chk~oth': '3', 'h~e': -1 })).toEqual({ 'h~w': 2, 'h~s': usageCounterCap })
    expect(parseUsageCounters(['h~w'])).toEqual({})
    expect(parseUsageCounters(null)).toEqual({})
  })

  it('round-trips the local state and treats anything unexpected as a fresh start', () => {
    const state = { lastSentDay: '20261026', attemptDay: '20261027', attempts: 2, counters: { 'h~w': 1 }, countersSince: 1_700_000_000_000 }
    expect(parseUsageStatsState(serializeUsageStatsState(state))).toEqual(state)
    expect(parseUsageStatsState('{')).toEqual(emptyUsageStatsState())
    expect(parseUsageStatsState(JSON.stringify({ ...state, version: 2 }))).toEqual(emptyUsageStatsState())
    expect(parseUsageStatsState(JSON.stringify({ version: 1, lastSentDay: '../../x', attempts: 40, counters: {}, countersSince: 5 }))).toEqual({
      lastSentDay: null, attemptDay: null, attempts: 3, counters: {}, countersSince: null,
    })
  })

  it('drops a batch of counters older than a week', () => {
    const since = Date.parse('2026-10-01T00:00:00Z')
    const state = { ...emptyUsageStatsState(), counters: { 'h~w': 1 }, countersSince: since }
    expect(withoutExpiredCounters(state, since + usageCounterMaxAgeMs)).toBe(state)
    expect(withoutExpiredCounters(state, since + usageCounterMaxAgeMs + 1)).toEqual({ ...state, counters: {}, countersSince: null })
  })

  it('splits days by UTC, as Cloudflare does', () => {
    expect(usageStatsDay(new Date('2026-10-27T07:59:00+08:00'))).toBe('20261026')
    expect(usageStatsDay(new Date('2026-10-27T08:00:00+08:00'))).toBe('20261027')
  })
})

describe('usage stats switch', () => {
  const packaged = { packaged: true, localBuild: false, env: {} }

  it('is on unless the customer turned it off, and only in a packaged release', () => {
    expect(shouldSendUsageStats({ ...packaged, preference: undefined })).toBe(true)
    expect(shouldSendUsageStats({ ...packaged, preference: true })).toBe(true)
    expect(shouldSendUsageStats({ ...packaged, preference: false })).toBe(false)
    expect(shouldSendUsageStats({ ...packaged, packaged: false, preference: true })).toBe(false)
    expect(shouldSendUsageStats({ ...packaged, localBuild: true, preference: true })).toBe(false)
    expect(shouldSendUsageStats({ ...packaged, env: { CI: 'true' }, preference: true })).toBe(false)
    expect(shouldSendUsageStats({ ...packaged, env: { XINGMANG_DISABLE_USAGE_STATS: '1' }, preference: true })).toBe(false)
  })
})

describe('usage stats snapshot pieces', () => {
  it('names the operating system without its build or edition', () => {
    expect(resolveUsageOs({ platform: 'win32', release: '10.0.19045' })).toBe('w10')
    expect(resolveUsageOs({ platform: 'win32', release: '10.0.22631' })).toBe('w11')
    expect(resolveUsageOs({ platform: 'win32', release: '6.1.7601' })).toBe('wx')
    expect(resolveUsageOs({ platform: 'darwin', release: '24.1.0', systemVersion: '15.1' })).toBe('m15')
    expect(resolveUsageOs({ platform: 'darwin', release: '24.1.0', systemVersion: '' })).toBe('mx')
    expect(resolveUsageOs({ platform: 'linux', release: '6.8.0' })).toBe('lx')
    expect(resolveUsageOs({ platform: 'freebsd', release: '14.0' })).toBe('x')
  })

  it('tells only which kind of account is signed in', () => {
    expect(usageAccountKind('solov', true)).toBe('xm')
    expect(usageAccountKind('solov-api', true)).toBe('api')
    expect(usageAccountKind('solov', false)).toBe('none')
  })

  it('reports the line preference and the line in use', () => {
    const routing = createRelayEndpointRoutingSnapshot({ solov: 'auto', 'solov-api': 'primary' }, () => ({ solov: { line: 'direct', settled: true } }))
    expect(usageRouteChoice(routing, 'solov')).toEqual({ preference: 'auto', line: 'direct' })
    expect(usageRouteChoice(routing, 'solov-api')).toEqual({ preference: 'primary', line: 'primary' })
  })

  it('tells a downloaded update still waiting from one that was tried and did not take', () => {
    const none = { downloadedVersion: null, attemptedVersion: null }
    expect(resolveUsageUpdateState(none, '0.2.22')).toEqual({ state: 'current' })
    expect(resolveUsageUpdateState({ downloadedVersion: '0.2.23', attemptedVersion: null }, '0.2.22')).toEqual({ state: 'downloaded', version: '0.2.23' })
    expect(resolveUsageUpdateState({ downloadedVersion: '0.2.23', attemptedVersion: '0.2.23' }, '0.2.22')).toEqual({ state: 'install-failed', version: '0.2.23' })
    expect(resolveUsageUpdateState({ downloadedVersion: '0.2.23', attemptedVersion: null, quitAttemptedVersion: '0.2.23' }, '0.2.22')).toEqual({ state: 'install-failed', version: '0.2.23' })
    expect(resolveUsageUpdateState({ downloadedVersion: '0.2.23', attemptedVersion: '0.2.21', backgroundInstall: { version: '0.2.23' } }, '0.2.22')).toEqual({ state: 'install-failed', version: '0.2.23' })
    // Installed already, or an older record left behind.
    expect(resolveUsageUpdateState({ downloadedVersion: '0.2.23', attemptedVersion: '0.2.23' }, '0.2.23')).toEqual({ state: 'current' })
    expect(resolveUsageUpdateState({ downloadedVersion: '0.2.21', attemptedVersion: null }, '0.2.22')).toEqual({ state: 'current' })
  })

  it('takes tools from the last detection and counts a failed probe as not detected', () => {
    expect(usageToolInventory({
      clis: {
        claude: { installed: true, version: '2.1.310' },
        codex: { installed: false, version: null },
        grok: { installed: false, version: null, detectionFailed: true },
        gemini: { installed: true, version: '0.9.0' },
      },
      desktopApps: { codex: { installed: true, version: null } },
    }, [
      { tool: 'workbuddy', installed: true, detectionError: null },
      { tool: 'opencode', installed: false, detectionError: '读不到安装位置' },
      { tool: 'somethingElse', installed: true },
    ])).toEqual({
      clis: { claude: '2.1.310', codex: null },
      gemini: true,
      desktops: { codexDesktop: true, workbuddy: true },
    })
    expect(usageToolInventory(null, null)).toEqual({ clis: {}, gemini: null, desktops: {} })
  })
})

describe('usage stats events', () => {
  it('reduces an error to one of five categories', () => {
    expect(usageFailureCategory(new Error('npm ERR! code ENOSPC: no space left on device, write C:\\Users\\yoyo\\a'))).toBe('machine')
    expect(usageFailureCategory(new Error('npm ERR! code ECONNRESET'))).toBe('network')
    expect(usageFailureCategory(new Error('npm ERR! code CERT_HAS_EXPIRED'))).toBe('certificate')
    expect(usageFailureCategory(new Error('npm ERR! code E503'))).toBe('source')
    expect(usageFailureCategory(new Error('something nobody has seen before'))).toBe('other')
    expect(usageFailureCategory(undefined)).toBe('other')
  })

  it('counts failed installs by target, never a cancel or a success', () => {
    const failed = { args: [], durationMs: 1000, failed: true, error: new Error('npm ERR! code ETIMEDOUT') }
    expect(usageEventForOperation({ ...failed, channel: 'cli:install', args: ['claude'] })).toEqual({ kind: 'install', target: 'claude', category: 'network' })
    expect(usageEventForOperation({ ...failed, channel: 'external-clients:install', args: ['workbuddy'] })).toEqual({ kind: 'install', target: 'workbuddy', category: 'network' })
    expect(usageEventForOperation({ ...failed, channel: 'runtime:install-node' })).toEqual({ kind: 'install', target: 'node', category: 'network' })
    expect(usageEventForOperation({ ...failed, channel: 'desktop:install-codex' })).toEqual({ kind: 'install', target: 'codexDesktop', category: 'network' })
    // The retired Gemini CLI, a cancel, a success, and channels that install nothing.
    expect(usageEventForOperation({ ...failed, channel: 'cli:install', args: ['gemini'] })).toBeNull()
    expect(usageEventForOperation({ ...failed, channel: 'cli:install', args: ['claude'], error: new InstallCancelledError() })).toBeNull()
    expect(usageEventForOperation({ ...failed, channel: 'cli:install', args: ['claude'], failed: false, error: undefined })).toBeNull()
    expect(usageEventForOperation({ ...failed, channel: 'config:save' })).toBeNull()
  })

  it('counts a payment page that did not open or took ten seconds or more', () => {
    const payment = { channel: 'account:create-topup-payment', args: [], error: undefined }
    expect(usageEventForOperation({ ...payment, durationMs: 300, failed: true })).toEqual({ kind: 'hang', hang: 'paymentFailed' })
    expect(usageEventForOperation({ ...payment, channel: 'account:create-subscription-payment', durationMs: 10_000, failed: false })).toEqual({ kind: 'hang', hang: 'paymentSlow' })
    expect(usageEventForOperation({ ...payment, durationMs: 9_999, failed: false })).toBeNull()
  })

  it('counts an update failure once, when it first appears, and skips the quiet automatic checks', () => {
    const download = { error: { code: 'UPDATE_DOWNLOAD_FAILED', message: 'net::ERR_CONNECTION_RESET' }, failedStep: 'download' as const }
    expect(usageEventForUpdate(null, download)).toEqual({ kind: 'update', step: 'download', category: 'network' })
    expect(usageEventForUpdate(download, { ...download })).toBeNull()
    expect(usageEventForUpdate(null, { error: { code: 'UPDATE_DOWNLOAD_STALLED', message: '下载没有进展' }, failedStep: 'download' })).toEqual({ kind: 'update', step: 'download', category: 'network' })
    expect(usageEventForUpdate(null, { error: { code: 'UPDATE_CHECK_FAILED', message: 'x', automatic: true }, failedStep: 'check' })).toBeNull()
    expect(usageEventForUpdate(null, { error: { code: 'UPDATE_CHECK_FAILED', message: 'x' }, failedStep: 'check' })).toEqual({ kind: 'update', step: 'check', category: 'other' })
    expect(usageEventForUpdate(null, { error: { code: 'UPDATE_PREVIOUS_AUTO_INSTALL_FAILED', message: 'x' }, failedStep: 'install' })).toBeNull()
    expect(usageEventForUpdate(null, { error: null })).toBeNull()
  })

  it('treats a two to thirty second late tick as a stall and a longer gap as sleep', () => {
    expect(isMainProcessStall(1000, 2999)).toBe(false)
    expect(isMainProcessStall(1000, 3000)).toBe(true)
    expect(isMainProcessStall(1000, 30_999)).toBe(true)
    expect(isMainProcessStall(1000, 31_000)).toBe(false)
  })
})
