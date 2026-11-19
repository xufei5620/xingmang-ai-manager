import { describe, expect, it, vi } from 'vitest'
import { createRendererRelease, rendererReleaseDelayMs, rendererReleaseRecheckMs, type RendererReleaseLogEvent } from './renderer-release'

function fixture(options: { hidden?: boolean; blocker?: string | null; releases?: boolean } = {}) {
  let clock = 1_000_000
  let hidden = options.hidden ?? true
  let blocker = options.blocker ?? null
  const timers: { callback: () => void; ms: number }[] = []
  const logged: { event: RendererReleaseLogEvent; detail?: Record<string, unknown> }[] = []
  const release = vi.fn(() => options.releases ?? true)
  const reload = vi.fn()
  const onReleased = vi.fn()
  const onRestoring = vi.fn()
  const onError = vi.fn()
  const controller = createRendererRelease({
    hiddenInTray: () => hidden,
    mainBlocker: () => blocker,
    release, reload, onReleased, onRestoring, onError,
    log: (event, detail) => { logged.push(detail ? { event, detail } : { event }) },
    now: () => clock,
    setTimer: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer },
    clearTimer: (timer) => { const index = timers.indexOf(timer as typeof timers[number]); if (index >= 0) timers.splice(index, 1) },
  })
  return {
    controller, release, reload, onReleased, onRestoring, onError, logged, timers,
    setHidden: (value: boolean) => { hidden = value },
    setBlocker: (value: string | null) => { blocker = value },
    advance: (ms: number) => { clock += ms },
    // Runs the one pending timer, the way the real clock would after its delay.
    fire: () => {
      const timer = timers.shift()
      if (!timer) throw new Error('no pending timer')
      timer.callback()
      return timer.ms
    },
  }
}

describe('renderer release', () => {
  it('releases a renderer that reported idle after the window sat in the tray for the full delay', () => {
    const h = fixture()
    h.controller.reportActivity(false)
    h.controller.noteHidden()
    expect(h.timers.map((timer) => timer.ms)).toEqual([rendererReleaseDelayMs])
    h.fire()
    expect(h.release).toHaveBeenCalledOnce()
    expect(h.controller.state).toBe('released')
    expect(h.onReleased).toHaveBeenCalledOnce()
    expect(h.logged).toEqual([{ event: 'release.done' }])
  })

  it('never releases a renderer that has not reported, which keeps the frozen legacy UI loaded', () => {
    const h = fixture()
    h.controller.noteHidden()
    h.fire()
    expect(h.release).not.toHaveBeenCalled()
    expect(h.logged).toEqual([{ event: 'release.deferred', detail: { reason: 'renderer-silent' } }])
    expect(h.timers.map((timer) => timer.ms)).toEqual([rendererReleaseRecheckMs])
  })

  it('waits while the renderer or the main process still has work, logging each reason once', () => {
    const h = fixture({ blocker: 'installing' })
    h.controller.reportActivity(true)
    h.controller.noteHidden()
    h.fire()
    h.fire()
    h.controller.reportActivity(false)
    h.fire()
    h.fire()
    expect(h.release).not.toHaveBeenCalled()
    expect(h.logged).toEqual([
      { event: 'release.deferred', detail: { reason: 'renderer-busy' } },
      { event: 'release.deferred', detail: { reason: 'installing' } },
    ])
    h.setBlocker(null)
    h.fire()
    expect(h.release).toHaveBeenCalledOnce()
    expect(h.controller.state).toBe('released')
  })

  it('does not release a window that came back or was minimized before the timer fired', () => {
    const h = fixture()
    h.controller.reportActivity(false)
    h.controller.noteHidden()
    h.setHidden(false)
    h.fire()
    expect(h.release).not.toHaveBeenCalled()
    expect(h.timers).toEqual([])
  })

  it('cancels the countdown when the window is shown again', () => {
    const h = fixture()
    h.controller.reportActivity(false)
    h.controller.noteHidden()
    h.controller.noteShown()
    expect(h.timers).toEqual([])
    expect(h.reload).not.toHaveBeenCalled()
  })

  it('stays loaded when the process cannot be released alone', () => {
    const h = fixture({ releases: false })
    h.controller.reportActivity(false)
    h.controller.noteHidden()
    h.fire()
    expect(h.controller.state).toBe('live')
    expect(h.controller.consumeExpectedExit()).toBe(false)
    expect(h.onReleased).not.toHaveBeenCalled()
    expect(h.logged).toEqual([{ event: 'release.skipped' }])
  })

  it('tells the crash handler that the exit it is about to see was intentional, once', () => {
    const h = fixture()
    h.controller.reportActivity(false)
    h.controller.noteHidden()
    h.fire()
    expect(h.controller.consumeExpectedExit()).toBe(true)
    expect(h.controller.consumeExpectedExit()).toBe(false)
  })

  it('reloads when the window is shown and holds deliveries until the new renderer reports', () => {
    const h = fixture()
    h.controller.noteShown()
    h.controller.reportActivity(false)
    h.controller.noteHidden()
    h.fire()
    const navigate = vi.fn()
    const launch = vi.fn()
    h.setHidden(false)
    h.controller.noteShown()
    expect(h.reload).toHaveBeenCalledOnce()
    expect(h.onRestoring).toHaveBeenCalledOnce()
    expect(h.controller.state).toBe('restoring')
    expect(h.controller.restoredBoot).toBe(true)
    h.controller.deliver('onNavigate', () => navigate('home'))
    h.controller.deliver('onLaunchTool', launch)
    h.controller.deliver('onNavigate', () => navigate('topup'))
    expect(navigate).not.toHaveBeenCalled()
    h.advance(300)
    h.controller.reportActivity(false)
    expect(h.controller.state).toBe('live')
    expect(launch).toHaveBeenCalledOnce()
    // Only the latest navigation of the same kind is worth sending.
    expect(navigate.mock.calls).toEqual([['topup']])
    expect(h.logged).toEqual([
      { event: 'release.done' },
      { event: 'restore.started', detail: { reason: 'show' } },
      { event: 'restore.ready', detail: { ms: 300 } },
    ])
    // A visible window does not start counting again.
    expect(h.timers).toEqual([])
  })

  it('exposes the latest busy report and clears it once the renderer is gone', () => {
    const h = fixture()
    expect(h.controller.rendererBusy).toBe(false)
    h.controller.reportActivity(true)
    expect(h.controller.rendererBusy).toBe(true)
    h.controller.reportActivity(false)
    h.controller.noteHidden()
    h.fire()
    expect(h.controller.state).toBe('released')
    expect(h.controller.rendererBusy).toBe(false)
  })

  it('keeps the work named in the latest report for the update restart question and forgets it with the renderer', () => {
    const h = fixture()
    expect(h.controller.rendererWork).toEqual([])
    h.controller.reportActivity(true, ['chat', 'video-compose'])
    expect(h.controller.rendererWork).toEqual(['chat', 'video-compose'])
    // A report that names nothing means nothing is running any more.
    h.controller.reportActivity(true)
    expect(h.controller.rendererWork).toEqual([])
    // Only the stale-report case can reach a release with work still named; it must not outlive the renderer.
    h.controller.reportActivity(false, ['chat'])
    h.controller.noteHidden()
    h.fire()
    expect(h.controller.state).toBe('released')
    expect(h.controller.rendererWork).toEqual([])
    h.controller.reportActivity(true, ['chat'])
    expect(h.controller.rendererWork).toEqual([])
  })

  it('sends deliveries straight through while the renderer is live', () => {
    const h = fixture()
    const send = vi.fn()
    h.controller.deliver('onNavigate', send)
    expect(send).toHaveBeenCalledOnce()
  })

  it('does not reload twice when the window is shown again during a restore', () => {
    const h = fixture()
    h.controller.reportActivity(false)
    h.controller.noteHidden()
    h.fire()
    h.controller.noteShown()
    expect(h.controller.restore('show')).toBe(true)
    h.controller.noteShown()
    expect(h.reload).toHaveBeenCalledOnce()
  })

  it('loads again on the next show after a restore load fails, and delivers what waited exactly once', async () => {
    // 11-18 复核 U05：重新加载那一下失败了，状态一直停在「正在重新加载」，再怎么叫出窗口都不再加载。
    const h = fixture()
    h.controller.noteShown()
    h.controller.reportActivity(false)
    h.controller.noteHidden()
    h.fire()
    const failure = new Error('ERR_FILE_NOT_FOUND')
    h.reload.mockReturnValueOnce(Promise.reject(failure))
    h.controller.noteShown()
    const navigate = vi.fn()
    h.controller.deliver('onNavigate', navigate)
    await Promise.resolve()
    await Promise.resolve()
    expect(h.controller.state).toBe('restoring')
    expect(h.onError).toHaveBeenCalledWith(failure)
    h.advance(500)
    h.controller.noteShown()
    expect(h.reload).toHaveBeenCalledTimes(2)
    // Another focus while the retry is loading does not start a third load.
    h.controller.noteShown()
    expect(h.reload).toHaveBeenCalledTimes(2)
    h.advance(200)
    h.controller.reportActivity(false)
    expect(h.controller.state).toBe('live')
    expect(navigate).toHaveBeenCalledOnce()
    // The prompts shown before the release stay shown; the retry is the same restore.
    expect(h.controller.restoredBoot).toBe(true)
    expect(h.logged).toEqual([
      { event: 'release.done' },
      { event: 'restore.started', detail: { reason: 'show' } },
      { event: 'restore.failed', detail: { cause: 'load' } },
      { event: 'restore.started', detail: { reason: 'show', retry: true } },
      { event: 'restore.ready', detail: { ms: 200 } },
    ])
  })

  it('loads again after a reload that throws before it starts', () => {
    const h = fixture()
    h.controller.reportActivity(false)
    h.controller.noteHidden()
    h.fire()
    const failure = new Error('window is gone')
    h.reload.mockImplementationOnce(() => { throw failure })
    expect(h.controller.restore('show')).toBe(true)
    expect(h.onError).toHaveBeenCalledWith(failure)
    expect(h.controller.restore('show')).toBe(true)
    expect(h.reload).toHaveBeenCalledTimes(2)
  })

  it('ignores a late failure from a load that a newer restore already replaced', async () => {
    const h = fixture()
    h.controller.reportActivity(false)
    h.controller.noteHidden()
    h.fire()
    expect(h.controller.consumeExpectedExit()).toBe(true)
    let rejectFirst: (error: unknown) => void = () => undefined
    h.reload.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectFirst = reject }))
    h.reload.mockReturnValueOnce(new Promise(() => undefined))
    h.controller.restore('show')
    // The first load's renderer dies; the next show starts a second load.
    h.controller.consumeExpectedExit()
    h.controller.restore('show')
    expect(h.reload).toHaveBeenCalledTimes(2)
    // Electron settles the first load only now. It must not undo the second one.
    rejectFirst(new Error('ERR_FAILED'))
    await Promise.resolve()
    await Promise.resolve()
    expect(h.controller.restore('show')).toBe(true)
    expect(h.reload).toHaveBeenCalledTimes(2)
    expect(h.onError).not.toHaveBeenCalled()
    expect(h.logged.filter((entry) => entry.event === 'restore.failed')).toEqual([
      { event: 'restore.failed', detail: { cause: 'renderer-gone' } },
    ])
  })

  it('ignores a failure that arrives after the restored renderer already reported', async () => {
    const h = fixture()
    h.controller.reportActivity(false)
    h.controller.noteHidden()
    h.fire()
    let rejectLoad: (error: unknown) => void = () => undefined
    h.reload.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectLoad = reject }))
    h.controller.restore('show')
    h.controller.reportActivity(false)
    rejectLoad(new Error('ERR_ABORTED'))
    await Promise.resolve()
    await Promise.resolve()
    expect(h.controller.state).toBe('live')
    expect(h.controller.restore('show')).toBe(false)
    expect(h.reload).toHaveBeenCalledOnce()
  })

  it('loads again on the next show when the renderer dies while it is being restored', () => {
    // 重新加载到一半界面进程没了，崩溃恢复问过一次、用户选了「先不管」：下次叫出窗口还得能载回来。
    const h = fixture()
    h.controller.reportActivity(false)
    h.controller.noteHidden()
    h.fire()
    expect(h.controller.consumeExpectedExit()).toBe(true)
    h.controller.restore('show')
    expect(h.controller.consumeExpectedExit()).toBe(false)
    expect(h.controller.state).toBe('restoring')
    expect(h.controller.restore('show')).toBe(true)
    expect(h.reload).toHaveBeenCalledTimes(2)
    expect(h.logged).toContainEqual({ event: 'restore.failed', detail: { cause: 'renderer-gone' } })
  })

  it('neither retries nor delivers after a failed restore once disposed', async () => {
    const h = fixture()
    h.controller.reportActivity(false)
    h.controller.noteHidden()
    h.fire()
    let rejectLoad: (error: unknown) => void = () => undefined
    h.reload.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectLoad = reject }))
    h.controller.restore('show')
    const send = vi.fn()
    h.controller.deliver('onNavigate', send)
    h.controller.dispose()
    rejectLoad(new Error('late'))
    await Promise.resolve()
    await Promise.resolve()
    expect(h.controller.restore('show')).toBe(false)
    h.controller.reportActivity(false)
    expect(h.reload).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalled()
    expect(h.onError).not.toHaveBeenCalled()
  })

  it('leaves a live renderer to the crash recovery', () => {
    const h = fixture()
    expect(h.controller.restore('show')).toBe(false)
    expect(h.reload).not.toHaveBeenCalled()
  })

  it('treats a renderer released before the window was ever shown as a first launch', () => {
    const h = fixture()
    h.controller.reportActivity(false)
    h.controller.noteHidden()
    h.fire()
    h.controller.noteShown()
    expect(h.controller.restoredBoot).toBe(false)
  })

  it('counts down again after a background wake while the window stays hidden', () => {
    const h = fixture()
    h.controller.noteShown()
    h.controller.reportActivity(false)
    h.controller.noteHidden()
    h.fire()
    expect(h.controller.restore('wake')).toBe(true)
    h.controller.reportActivity(false)
    expect(h.controller.state).toBe('live')
    expect(h.timers.map((timer) => timer.ms)).toEqual([rendererReleaseDelayMs])
    h.fire()
    expect(h.release).toHaveBeenCalledTimes(2)
  })

  it('ignores reports from the renderer that is already gone', () => {
    const h = fixture()
    h.controller.reportActivity(false)
    h.controller.noteHidden()
    h.fire()
    h.controller.reportActivity(false)
    expect(h.controller.state).toBe('released')
    expect(h.logged).toEqual([{ event: 'release.done' }])
  })

  it('forgets an unconsumed intentional exit once the reload is ready, so a later crash is still a crash', () => {
    const h = fixture()
    h.controller.reportActivity(false)
    h.controller.noteHidden()
    h.fire()
    h.controller.noteShown()
    h.controller.reportActivity(false)
    expect(h.controller.consumeExpectedExit()).toBe(false)
  })

  it('reports a throwing host callback instead of throwing out of a timer', () => {
    const h = fixture()
    const failure = new Error('boom')
    const controller = createRendererRelease({
      hiddenInTray: () => { throw failure },
      mainBlocker: () => null,
      release: () => true,
      reload: () => undefined,
      log: () => undefined,
      onError: h.onError,
      setTimer: (callback) => { callback(); return null },
      clearTimer: () => undefined,
    })
    controller.reportActivity(false)
    expect(() => controller.noteHidden()).not.toThrow()
    expect(h.onError).toHaveBeenCalledWith(failure)
    expect(controller.state).toBe('live')
  })

  it('stops everything once disposed', () => {
    const h = fixture()
    h.controller.reportActivity(false)
    h.controller.noteHidden()
    h.controller.dispose()
    expect(h.timers).toEqual([])
    const send = vi.fn()
    h.controller.deliver('onNavigate', send)
    expect(send).not.toHaveBeenCalled()
  })
})
