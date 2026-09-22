import { describe, expect, it, vi } from 'vitest'
import { createVaultRecoveryNotifier } from './vault-recovery-notice'

function notifier() {
  const log = vi.fn()
  const emit = vi.fn()
  return { log, emit, onRecovered: createVaultRecoveryNotifier({ log, emit }) }
}

describe('vault recovery notice', () => {
  it('says nothing while the account store loads normally', () => {
    const f = notifier()
    expect(f.log).not.toHaveBeenCalled()
    expect(f.emit).not.toHaveBeenCalled()
  })

  it('tells the interface once when the account store is rebuilt', () => {
    const f = notifier()
    f.onRecovered('realm-accounts-v2.dat.unreadable-1.bak')
    expect(f.log).toHaveBeenCalledWith('realm-accounts-v2.dat.unreadable-1.bak')
    expect(f.emit).toHaveBeenCalledTimes(1)
  })

  it('keeps the event free of the backup file name and of any account content', () => {
    const f = notifier()
    f.onRecovered('realm-accounts-v2.dat.unreadable-1.bak')
    expect(f.emit).toHaveBeenCalledWith()
  })

  it('still logs a second rebuild but does not raise the notice again', () => {
    const f = notifier()
    f.onRecovered('first.bak')
    f.onRecovered('second.bak')
    expect(f.log.mock.calls).toEqual([['first.bak'], ['second.bak']])
    expect(f.emit).toHaveBeenCalledTimes(1)
  })

  it('writes the log before the notice so a dead window cannot swallow it', () => {
    const order: string[] = []
    const onRecovered = createVaultRecoveryNotifier({
      log: () => { order.push('log') },
      emit: () => { order.push('emit'); throw new Error('window is gone') },
    })
    expect(() => onRecovered('backup.bak')).toThrow('window is gone')
    expect(order).toEqual(['log', 'emit'])
  })
})
