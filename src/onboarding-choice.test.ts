import { describe, expect, it } from 'vitest'
import { readStartChoice, rememberStartChoice } from './onboarding-choice'

describe('completed start choices', () => {
  it('isolates each choice by site and account without requiring Codex setup', () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    expect(rememberStartChoice(storage, 'solov', 1, 'chat')).toBe(true)
    expect(rememberStartChoice(storage, 'solov', 2, 'claude')).toBe(true)
    expect(readStartChoice(storage, 'solov', 1)).toBe('chat')
    expect(readStartChoice(storage, 'solov', 2)).toBe('claude')
    expect(readStartChoice(storage, 'other', 1)).toBeNull()
  })

  it('treats invalid data and unavailable storage as an incomplete guide', () => {
    expect(readStartChoice({ getItem: () => 'unknown' }, 'solov', 1)).toBeNull()
    expect(readStartChoice({ getItem: () => { throw new Error('denied') } }, 'solov', 1)).toBeNull()
    expect(rememberStartChoice({ setItem: () => { throw new Error('full') } }, 'solov', 1, 'chat')).toBe(false)
    expect(readStartChoice({ getItem: () => 'chat' }, 'solov', NaN)).toBeNull()
  })
})
