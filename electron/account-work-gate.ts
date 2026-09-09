/** Track complete host handlers, including their final local writes, while an account changes. */
export function createAccountWorkGate(options: { assertReady(): void; revision(): number }) {
  const pending = new Set<Promise<unknown>>()
  function run<T>(operation: () => T, resultOptions: { checkRevision?: boolean } = {}): T {
    options.assertReady()
    const revision = options.revision()
    function assertCurrent(): void {
      if (resultOptions.checkRevision === false) return
      if (options.revision() !== revision) throw new Error('账号上下文已变化，请重试')
    }
    const value = operation()
    if (value && typeof (value as { then?: unknown }).then === 'function') {
      const tracked = Promise.resolve(value).then((result) => {
        assertCurrent()
        return result
      }, (error: unknown) => {
        assertCurrent()
        throw error
      })
      pending.add(tracked)
      void tracked.then(() => pending.delete(tracked), () => pending.delete(tracked))
      return tracked as T
    }
    assertCurrent()
    return value
  }
  async function whenIdle(): Promise<void> {
    while (pending.size) await Promise.allSettled([...pending])
  }
  return { run, whenIdle }
}

export type AccountWorkGate = ReturnType<typeof createAccountWorkGate>
