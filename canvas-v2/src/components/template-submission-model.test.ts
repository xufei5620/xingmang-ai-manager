import { describe, expect, it, vi } from 'vitest'
import { createTemplateSubmissionController } from './template-submission-model'

function deferred() {
  let resolve!: () => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<void>((complete, fail) => { resolve = complete; reject = fail })
  return { promise, resolve, reject }
}

function callbacks() {
  return { onStart: vi.fn(), onSuccess: vi.fn(), onError: vi.fn(), onFinish: vi.fn() }
}

describe('template confirmed submission', () => {
  it('waits for one creation before closing and ignores a second click', async () => {
    const controller = createTemplateSubmissionController()
    const request = deferred()
    const create = vi.fn(() => request.promise)
    const events = callbacks()
    const first = controller.submit(create, events)
    expect(controller.active()).toBe(true)
    expect(events.onStart).toHaveBeenCalledOnce()
    expect(events.onSuccess).not.toHaveBeenCalled()
    expect(await controller.submit(create, events)).toBe(false)
    expect(create).toHaveBeenCalledOnce()
    request.resolve()
    expect(await first).toBe(true)
    expect(controller.active()).toBe(false)
    expect(events.onSuccess).toHaveBeenCalledOnce()
    expect(events.onFinish).toHaveBeenCalledOnce()
  })

  it('keeps the configured draft and exposes the original error after a rejected creation', async () => {
    const controller = createTemplateSubmissionController()
    let fields: Record<string, string> = { prompt: '用户已填写的长剧本', reference: 'A'.repeat(43) }
    const failure = new Error('工程创建未确认，请保留当前配置并核对原操作。')
    const events = callbacks()
    events.onSuccess.mockImplementation(() => { fields = {} })
    expect(await controller.submit(() => Promise.reject(failure), events)).toBe(false)
    expect(events.onError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(events.onSuccess).not.toHaveBeenCalled()
    expect(controller.active()).toBe(false)
    expect(fields).toEqual({ prompt: '用户已填写的长剧本', reference: 'A'.repeat(43) })
    expect(await controller.submit(() => undefined, events)).toBe(true)
    expect(events.onSuccess).toHaveBeenCalledOnce()
    expect(fields).toEqual({})
  })

  it('supports the synchronous existing-project insertion and reports synchronous failures', async () => {
    const controller = createTemplateSubmissionController()
    const events = callbacks()
    expect(await controller.submit(() => undefined, events)).toBe(true)
    const failure = new Error('当前画布不能插入该模板。')
    expect(await controller.submit(() => { throw failure }, events)).toBe(false)
    expect(events.onError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(events.onSuccess).toHaveBeenCalledOnce()
  })

  it.each(['success', 'failure'] as const)('ignores a late %s from a closed dialog without unlocking the next submission', async (result) => {
    const controller = createTemplateSubmissionController()
    const old = deferred()
    const fresh = deferred()
    const oldEvents = callbacks()
    const newEvents = callbacks()
    const oldRequest = controller.submit(() => old.promise, oldEvents)
    controller.invalidate()
    const newRequest = controller.submit(() => fresh.promise, newEvents)
    if (result === 'success') old.resolve()
    else old.reject(new Error('旧工程创建失败'))
    expect(await oldRequest).toBe(false)
    expect(oldEvents.onSuccess).not.toHaveBeenCalled()
    expect(oldEvents.onError).not.toHaveBeenCalled()
    expect(oldEvents.onFinish).not.toHaveBeenCalled()
    expect(controller.active()).toBe(true)
    fresh.resolve()
    expect(await newRequest).toBe(true)
    expect(newEvents.onSuccess).toHaveBeenCalledOnce()
    expect(controller.active()).toBe(false)
  })
})
