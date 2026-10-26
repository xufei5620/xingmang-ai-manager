import { describe, expect, it, vi } from 'vitest'
import { backgroundWorkActive, markBackgroundWork, subscribeBackgroundWork } from './background-work'

describe('background work registry', () => {
  it('is active while any registered work is running', () => {
    const chat = Symbol('chat')
    const video = Symbol('video')
    expect(backgroundWorkActive()).toBe(false)
    markBackgroundWork(chat, true)
    markBackgroundWork(video, true)
    markBackgroundWork(chat, false)
    expect(backgroundWorkActive()).toBe(true)
    markBackgroundWork(video, false)
    expect(backgroundWorkActive()).toBe(false)
  })

  it('tells listeners only about real changes', () => {
    const token = Symbol('jobs')
    const listener = vi.fn()
    const unsubscribe = subscribeBackgroundWork(listener)
    markBackgroundWork(token, false)
    markBackgroundWork(token, true)
    markBackgroundWork(token, true)
    markBackgroundWork(token, false)
    unsubscribe()
    markBackgroundWork(token, true)
    markBackgroundWork(token, false)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
