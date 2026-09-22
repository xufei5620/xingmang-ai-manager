import { describe, expect, it } from 'vitest'
import { guideJobProgress, planConfigRefresh } from './useToolbox'

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
