/**
 * Resolve once per method invocation. A method that awaits disk/network work
 * stays bound to its original instance; changing the selected realm never
 * changes its roots or transport halfway through that method.
 */
export function createRealmServiceDispatch<T extends object>(resolve: () => T): T {
  return new Proxy({} as T, {
    get(_target, property) {
      if (Object.hasOwn(_target, property)) return Reflect.get(_target, property)
      const instance = resolve()
      const value: unknown = Reflect.get(instance, property)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        const current = resolve()
        const method: unknown = Reflect.get(current, property)
        if (typeof method !== 'function') throw new Error('当前站点服务不可用')
        return Reflect.apply(method, current, args)
      }
    },
  })
}
