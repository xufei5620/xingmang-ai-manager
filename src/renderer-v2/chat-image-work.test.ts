import { afterEach, describe, expect, it } from 'vitest'
import { chatImageWorkActive, markChatImageWork } from './chat-image-work'

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
})
