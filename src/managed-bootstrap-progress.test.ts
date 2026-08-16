import { describe, expect, it } from 'vitest'
import {
  createManagedBootstrapProgress,
  updateManagedBootstrapProgress,
} from './managed-bootstrap-progress'

describe('managed bootstrap progress', () => {
  it('starts with ten pending steps and no active action', () => {
    const progress = createManagedBootstrapProgress()
    expect(progress.steps).toHaveLength(10)
    expect(progress.steps.every((step) => step.status === 'pending')).toBe(true)
    expect(progress.percent).toBe(0)
    expect(progress.activeStep).toBeNull()
  })

  it('completes earlier steps when the flow advances and exposes the current action', () => {
    let progress = createManagedBootstrapProgress()
    progress = updateManagedBootstrapProgress(progress, {
      id: 'prepare-codex-cli',
      status: 'active',
      message: '正在安装 Codex CLI',
    })
    expect(progress.steps.slice(0, 4).every((step) => step.status === 'completed')).toBe(true)
    expect(progress.activeStep).toMatchObject({
      id: 'prepare-codex-cli',
      status: 'active',
      message: '正在安装 Codex CLI',
    })
    expect(progress.percent).toBe(40)
  })

  it('keeps a failed step visible without marking later work complete', () => {
    const progress = updateManagedBootstrapProgress(createManagedBootstrapProgress(), {
      id: 'sync-keys',
      status: 'failed',
      message: 'Key 同步失败',
    })
    expect(progress.percent).toBe(0)
    expect(progress.activeStep).toMatchObject({ status: 'failed', message: 'Key 同步失败' })
    expect(progress.steps.slice(1).every((step) => step.status === 'pending')).toBe(true)
  })

  it('reaches one hundred percent only after the dashboard step completes', () => {
    const progress = updateManagedBootstrapProgress(createManagedBootstrapProgress(), {
      id: 'enter-dashboard',
      status: 'completed',
    })
    expect(progress.percent).toBe(100)
    expect(progress.activeStep).toBeNull()
    expect(progress.steps.every((step) => step.status === 'completed')).toBe(true)
  })
})
