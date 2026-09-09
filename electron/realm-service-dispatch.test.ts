import { describe, expect, it } from 'vitest'
import { createRealmServiceDispatch } from './realm-service-dispatch'

describe('realm service dispatch', () => {
  it('keeps an asynchronous operation bound to its original data root after switching', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    class Store {
      constructor(readonly root: string) {}
      async read() { await blocked; return this.root }
    }
    let active = new Store('xm')
    const dispatch = createRealmServiceDispatch(() => active)
    const read = dispatch.read
    const old = read()
    active = new Store('api')
    const current = read()
    release()
    expect(await old).toBe('xm')
    expect(await current).toBe('api')
  })
})
