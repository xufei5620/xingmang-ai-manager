import { describe, expect, it } from 'vitest'
import type { ExternalClientStatus } from '../../../../electron/ipc-contract'
import { guideJobProgress, planConfigRefresh, shouldRecheckWorkBuddy, withExternalRunning, withExternalStatus, workBuddyFocusRecheckMs } from './useToolbox'

describe('post key-sync refresh plan', () => {
  it('only re-reads the config once a snapshot is on screen', () => {
    expect(planConfigRefresh({ hasSnapshot: true, scansInFlight: false })).toBe('config-only')
  })

  it('only re-reads the config while the first-paint scan is still running', () => {
    // 那遍扫描落地时会顶替掉它开跑前读到的旧配置（useToolbox 里的 configAtStart），
    // 所以这里不该再开第二遍扫描来抢它。
    expect(planConfigRefresh({ hasSnapshot: false, scansInFlight: true })).toBe('config-only')
  })

  it('falls back to a scan only when the first-paint scan failed and left nothing', () => {
    expect(planConfigRefresh({ hasSnapshot: false, scansInFlight: false })).toBe('rescan')
  })
})

describe('guide progress while installing', () => {
  it('shows nothing until some job reports a number', () => {
    expect(guideJobProgress({})).toBeUndefined()
    expect(guideJobProgress({ claude: { label: '正在准备 Node.js 运行环境（1/2）', log: [] } })).toBeUndefined()
  })

  it('keeps the stage wording of the tool job and borrows the runtime download percent', () => {
    expect(guideJobProgress({
      claude: { label: '正在准备 Node.js 运行环境（1/2）', log: [] },
      node: { label: '正在下载 Node.js', percent: 40, log: [] },
    })).toEqual({ label: '正在准备 Node.js 运行环境（1/2）', percent: 40 })
  })
})

// 第三十一批 C：打开客户端以后先把那一行写成「运行中」，不等后台那次重扫。
describe('desktop client marked running after it was opened', () => {
  const client = (tool: ExternalClientStatus['tool'], running = false): ExternalClientStatus => ({
    tool, installed: true, version: '1.2.3', path: `C:\\Fixture\\${tool}.exe`, installDirectory: 'C:\\Fixture', running,
    installSupported: true, launchSupported: true, detectionError: null, installHint: null,
    configured: true, model: 'fixture-model', configurationSource: 'xingmang', configurationError: null,
  })

  it('marks only the client that was opened', () => {
    const statuses = [client('workbuddy'), client('claudeDesktop'), client('opencode')]
    const next = withExternalRunning(statuses, 'claudeDesktop')
    expect(next.map((entry) => [entry.tool, entry.running])).toEqual([['workbuddy', false], ['claudeDesktop', true], ['opencode', false]])
    expect(next[0]).toBe(statuses[0])
    expect(statuses[1].running).toBe(false)
  })

  it('keeps the same list when that client already reads as running or is not listed', () => {
    const statuses = [client('workbuddy', true), client('opencode')]
    expect(withExternalRunning(statuses, 'workbuddy')).toBe(statuses)
    expect(withExternalRunning(statuses, 'claudeDesktop')).toBe(statuses)
  })
})

// yoyo 2026-11-18「改」：客户照着「装好后回来」做了却没点「重新检测」，回到星芒窗口就悄悄只看一眼 WorkBuddy。
describe('WorkBuddy looked at again when the window comes back', () => {
  const row = (tool: ExternalClientStatus['tool'], patch: Partial<ExternalClientStatus> = {}): ExternalClientStatus => ({
    tool, installed: false, version: null, path: null, installDirectory: null, running: false,
    installSupported: false, launchSupported: false, detectionError: null, installHint: null,
    configured: false, model: null, configurationSource: 'missing', configurationError: null, ...patch,
  })
  const now = 10_000_000

  it('looks again only for a real missing row, two minutes after the last scan and when nothing else is scanning', () => {
    const missing = [row('workbuddy'), row('opencode', { installed: true })]
    expect(shouldRecheckWorkBuddy(missing, now - workBuddyFocusRecheckMs, now, false)).toBe(true)
    expect(shouldRecheckWorkBuddy(missing, now - workBuddyFocusRecheckMs + 1, now, false)).toBe(false)
    expect(shouldRecheckWorkBuddy(missing, now - workBuddyFocusRecheckMs, now, true)).toBe(false)
    expect(shouldRecheckWorkBuddy(missing, null, now, false)).toBe(false)
    for (const patch of [{ installed: true }, { detectionError: '客户端检测超时' }, { cachedAt: '2026-11-18T00:00:00.000Z' }]) {
      expect(shouldRecheckWorkBuddy([row('workbuddy', patch)], 0, now, false), JSON.stringify(patch)).toBe(false)
    }
    expect(shouldRecheckWorkBuddy([row('opencode')], 0, now, false)).toBe(false)
  })

  it('swaps in the row it looked at and leaves the others and a startup snapshot alone', () => {
    const statuses = [row('workbuddy'), row('claudeDesktop', { installed: true })]
    const found = row('workbuddy', { installed: true, path: 'C:\\WorkBuddy\\WorkBuddy.exe', pristine: true })
    const next = withExternalStatus(statuses, found)
    expect(next).toEqual([found, statuses[1]])
    expect(next[1]).toBe(statuses[1])
    const cached = statuses.map((entry) => ({ ...entry, cachedAt: '2026-11-18T00:00:00.000Z' }))
    expect(withExternalStatus(cached, found)).toBe(cached)
    expect(withExternalStatus([row('opencode')], found)).toEqual([row('opencode')])
  })
})
