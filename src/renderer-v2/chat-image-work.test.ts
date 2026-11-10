import { afterEach, describe, expect, it } from 'vitest'
import { chatImageSwitchWarning, chatImageWorkActive, logoutChatImageNote, markChatImageWork } from './chat-image-work'

const tokens: symbol[] = []
function token(label: string) { const created = Symbol(label); tokens.push(created); return created }

afterEach(() => {
  for (const created of tokens.splice(0)) markChatImageWork(created, false)
})

describe('chat image work registry', () => {
  it('stays active until every chat page that registered an image in flight has let go (D44)', () => {
    expect(chatImageWorkActive()).toBe(false)
    const first = token('first')
    const second = token('second')
    markChatImageWork(first, true)
    markChatImageWork(second, true)
    markChatImageWork(first, true)
    expect(chatImageWorkActive()).toBe(true)
    markChatImageWork(first, false)
    expect(chatImageWorkActive()).toBe(true)
    markChatImageWork(second, false)
    expect(chatImageWorkActive()).toBe(false)
  })
  it('ignores letting go of something that was never registered', () => {
    markChatImageWork(token('stray'), false)
    expect(chatImageWorkActive()).toBe(false)
  })
  it('asks with the approved sentence word for word (D44)', () => {
    expect(chatImageSwitchWarning).toBe('对话还在出图，换账号会停掉这张图，可能已经扣费。')
  })
  it('adds the same sentence to the logout prompt only while an image is in flight', () => {
    expect(logoutChatImageNote()).toBe('')
    const drawing = token('drawing')
    markChatImageWork(drawing, true)
    expect(logoutChatImageNote()).toBe(chatImageSwitchWarning)
    markChatImageWork(drawing, false)
    expect(logoutChatImageNote()).toBe('')
  })
})
