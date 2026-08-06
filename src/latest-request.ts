export interface LatestRequestTracker<Key> {
  begin(key: Key): number
  isCurrent(key: Key, requestId: number): boolean
  invalidate(key: Key): void
  invalidateAll(): void
}

export function createLatestRequestTracker<Key>(): LatestRequestTracker<Key> {
  const sequences = new Map<Key, number>()
  return {
    begin(key) {
      const requestId = (sequences.get(key) ?? 0) + 1
      sequences.set(key, requestId)
      return requestId
    },
    isCurrent(key, requestId) {
      return sequences.get(key) === requestId
    },
    invalidate(key) {
      sequences.set(key, (sequences.get(key) ?? 0) + 1)
    },
    invalidateAll() {
      for (const key of sequences.keys()) {
        sequences.set(key, (sequences.get(key) ?? 0) + 1)
      }
    },
  }
}
