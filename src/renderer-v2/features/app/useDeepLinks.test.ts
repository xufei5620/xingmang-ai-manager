import { describe, expect, it } from 'vitest'
import type { ToastAction, Tone } from '../../ui'
import { showSignedInInvite } from './useDeepLinks'

interface ShownToast { text: string; tone?: Tone; action?: ToastAction }

function recorder() {
  const shown: ShownToast[] = []
  return { shown, toast: { show(text: string, tone?: Tone, action?: ToastAction) { shown.push({ text, tone, action }) } } }
}

// The copy settles on a microtask after the click; one macrotask is enough for both branches.
function settle() { return new Promise((resolve) => setTimeout(resolve, 0)) }

describe('showSignedInInvite', () => {
  it('tells a signed-in user the invite code in a plain toast rather than an error dialog (D69)', () => {
    const { shown, toast } = recorder()
    showSignedInInvite(toast, 'XM-7K2Q', () => ({ writeText: async () => undefined }))
    expect(shown).toHaveLength(1)
    expect(shown[0].text).toBe('你已经登录了。邀请码 XM-7K2Q 要退出当前账号、注册新账号时才能用。')
    expect(shown[0].tone).toBe('neutral')
    expect(shown[0].action?.label).toBe('复制邀请码')
  })

  it('copies only the code, closes the toast and confirms once the clipboard took it', async () => {
    const { shown, toast } = recorder()
    const copied: string[] = []
    let dismissed = 0
    showSignedInInvite(toast, 'XM-7K2Q', () => ({ writeText: async (text) => { copied.push(text) } }))
    shown[0].action?.onSelect(() => { dismissed += 1 })
    await settle()
    expect(copied).toEqual(['XM-7K2Q'])
    expect(dismissed).toBe(1)
    expect(shown.slice(1)).toEqual([{ text: '邀请码已复制', tone: 'ok', action: undefined }])
  })

  it('keeps the toast up so the code can be selected by hand when the copy fails', async () => {
    for (const clipboard of [{ writeText: async () => { throw new Error('denied') } }, undefined]) {
      const { shown, toast } = recorder()
      let dismissed = 0
      showSignedInInvite(toast, 'XM-7K2Q', () => clipboard)
      shown[0].action?.onSelect(() => { dismissed += 1 })
      await settle()
      expect(dismissed).toBe(0)
      expect(shown.slice(1)).toEqual([{ text: '没复制上，请手动选中这行文字复制。', tone: 'warn', action: undefined }])
    }
  })
})
