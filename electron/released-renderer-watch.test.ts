import { describe, expect, it, vi } from 'vitest'
import type { RelayNotice } from './relay-backend'
import { createReleasedRendererWatch, localDay, noticeFingerprint, noticeMentionsRecharge } from './released-renderer-watch'

function notice(entries: { id: string; title: string }[] = [], bulletins: { id: string; content: string }[] = []): RelayNotice {
  return {
    id: 'n1', text: '',
    entries: entries.map((entry) => ({ ...entry, text: '', read: false })),
    bulletins: bulletins.map((bulletin) => ({ ...bulletin, extra: '', publishedAt: '2026-10-26T00:00:00Z', type: 'default' as const })),
  }
}

async function settle() {
  await new Promise((resolve) => { setImmediate(resolve) })
}

function fixture(options: { notices: (RelayNotice | null)[]; seen?: string | null; signedIn?: boolean; day?: () => number }) {
  const timers: (() => void)[] = []
  const readBalance = vi.fn(async () => undefined)
  const notices = [...options.notices]
  const readNotice = vi.fn(async () => notices.length > 1 ? notices.shift()! : notices[0] ?? null)
  const wake = vi.fn()
  const watch = createReleasedRendererWatch({
    signedIn: () => options.signedIn ?? true,
    readBalance,
    readNotice,
    lastSeenNotice: () => options.seen === undefined ? noticeFingerprint(options.notices[0] ?? null) : options.seen,
    wake,
    now: options.day ?? (() => new Date(2026, 9, 26, 12).getTime()),
    setTimer: (callback) => { timers.push(callback); return callback },
    clearTimer: (timer) => { const index = timers.indexOf(timer as () => void); if (index >= 0) timers.splice(index, 1) },
  })
  async function tick() {
    const next = timers.shift()
    if (!next) throw new Error('no pending check')
    next()
    await settle()
  }
  return { watch, readBalance, readNotice, wake, timers, tick }
}

describe('notice fingerprint', () => {
  it('names the notice and every entry but not their read state', () => {
    expect(noticeFingerprint(null)).toBe('')
    expect(noticeFingerprint(notice([{ id: '3', title: 'a' }], [{ id: 'b1', content: 'x' }]))).toBe('n1\n3\nb1')
  })

  it('spots a recharge campaign in a title or a bulletin', () => {
    expect(noticeMentionsRecharge(notice([{ id: '1', title: '国庆充值送额度' }]))).toBe(true)
    expect(noticeMentionsRecharge(notice([], [{ id: 'b', content: '充值活动进行中' }]))).toBe(true)
    expect(noticeMentionsRecharge(notice([{ id: '1', title: '维护通知' }]))).toBe(false)
    expect(noticeMentionsRecharge(null)).toBe(false)
  })

  it('keys days by the local calendar', () => {
    expect(localDay(new Date(2026, 9, 26, 23, 59).getTime())).toBe('2026-10-26')
    expect(localDay(new Date(2026, 9, 27, 0, 1).getTime())).toBe('2026-10-27')
  })
})

describe('released renderer watch', () => {
  it('keeps the tray balance fresh on the background cadence without waking the renderer', async () => {
    const h = fixture({ notices: [notice([{ id: '1', title: '维护通知' }])] })
    h.watch.start()
    await h.tick()
    await h.tick()
    expect(h.readBalance).toHaveBeenCalledTimes(2)
    expect(h.wake).not.toHaveBeenCalled()
    expect(h.timers).toHaveLength(1)
  })

  it('wakes the renderer once for a notice it has not seen', async () => {
    const first = notice([{ id: '1', title: '维护通知' }])
    const second = notice([{ id: '1', title: '维护通知' }, { id: '2', title: '新模型上线' }])
    const h = fixture({ notices: [first, second], seen: noticeFingerprint(first) })
    h.watch.start()
    await h.tick()
    expect(h.wake).not.toHaveBeenCalled()
    await h.tick()
    expect(h.wake).toHaveBeenCalledWith('notice')
    // The renderer woke but did not read notices (for example the account cannot): do not wake it again for the same one.
    await h.tick()
    expect(h.wake).toHaveBeenCalledOnce()
  })

  it('does not compare against a renderer that never read notices', async () => {
    const h = fixture({ notices: [notice([{ id: '2', title: '新模型上线' }])], seen: null })
    h.watch.start()
    await h.tick()
    expect(h.wake).not.toHaveBeenCalled()
  })

  it('wakes once a day while a recharge campaign is running, but not on the day it was released', async () => {
    let clock = new Date(2026, 9, 26, 12).getTime()
    const campaign = notice([{ id: '5', title: '充值送额度' }])
    const h = fixture({ notices: [campaign], day: () => clock })
    h.watch.start()
    await h.tick()
    expect(h.wake).not.toHaveBeenCalled()
    clock = new Date(2026, 9, 27, 9).getTime()
    await h.tick()
    expect(h.wake).toHaveBeenCalledWith('daily-promo')
    await h.tick()
    expect(h.wake).toHaveBeenCalledOnce()
  })

  it('does nothing for a signed-out user except keep checking', async () => {
    const h = fixture({ notices: [], signedIn: false })
    h.watch.start()
    await h.tick()
    expect(h.readBalance).not.toHaveBeenCalled()
    expect(h.readNotice).not.toHaveBeenCalled()
    expect(h.timers).toHaveLength(1)
  })

  it('keeps going when a read fails', async () => {
    const h = fixture({ notices: [notice()] })
    h.readBalance.mockRejectedValueOnce(new Error('offline'))
    h.readNotice.mockRejectedValueOnce(new Error('offline'))
    h.watch.start()
    await h.tick()
    expect(h.wake).not.toHaveBeenCalled()
    expect(h.timers).toHaveLength(1)
  })

  it('drops a round that finishes after it was stopped', async () => {
    const h = fixture({ notices: [notice([{ id: '9', title: '新模型' }])], seen: 'something else' })
    let finish: () => void = () => undefined
    h.readBalance.mockImplementationOnce(() => new Promise<undefined>((resolve) => { finish = () => resolve(undefined) }))
    h.watch.start()
    const pending = h.timers.shift()!
    pending()
    h.watch.stop()
    finish()
    await settle()
    expect(h.readNotice).not.toHaveBeenCalled()
    expect(h.wake).not.toHaveBeenCalled()
    expect(h.timers).toHaveLength(0)
  })
})
