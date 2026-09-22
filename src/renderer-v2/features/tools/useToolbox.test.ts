import { describe, expect, it } from 'vitest'
import { planConfigRefresh } from './useToolbox'

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
