import { describe, expect, it } from 'vitest'
import {
  createManagedBootstrapProgress,
  updateManagedBootstrapProgress,
} from './managed-bootstrap-progress'

describe('managed bootstrap progress', () => {
  it('starts with eight pending steps and no active action', () => {
    const progress = createManagedBootstrapProgress()
    expect(progress.steps).toHaveLength(8)
    expect(progress.steps.every((step) => step.status === 'pending')).toBe(true)
    expect(progress.percent).toBe(0)
    expect(progress.activeStep).toBeNull()
  })

  it('completes earlier steps when the flow advances and exposes the current action', () => {
    let progress = createManagedBootstrapProgress()
    progress = updateManagedBootstrapProgress(progress, {
      id: 'prepare-codex-desktop',
      status: 'active',
      message: '正在安装 Codex Desktop',
    })
    expect(progress.steps.slice(0, 3).every((step) => step.status === 'completed')).toBe(true)
    expect(progress.activeStep).toMatchObject({
      id: 'prepare-codex-desktop',
      status: 'active',
      message: '正在安装 Codex Desktop',
    })
    expect(progress.percent).toBe(38)
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
