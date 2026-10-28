const assetPattern = /^[A-Za-z0-9_-]{43}$/

/** Match import validation, including adopted/source IDs; arbitrary prompt text is not a reference. */
export function collectAssetReferenceIds(value: unknown, initialDepth = 0): string[] {
  const ids = new Set<string>()
  function visit(item: unknown, depth: number): void {
    if (depth > 32 || !item || typeof item !== 'object') return
    if (Array.isArray(item)) { for (const entry of item) visit(entry, depth + 1); return }
    for (const [key, entry] of Object.entries(item)) {
      if (/assetId$/i.test(key) && typeof entry === 'string' && assetPattern.test(entry)) ids.add(entry)
      else if (/assetIds$/i.test(key) && Array.isArray(entry)) {
        for (const id of entry) if (typeof id === 'string' && assetPattern.test(id)) ids.add(id)
      } else visit(entry, depth + 1)
    }
  }
  visit(value, initialDepth)
  return [...ids]
}

export function collectNodeAssetReferences(nodes: ReadonlyArray<{ id: string; data: unknown }>): Map<string, Set<string>> {
  const references = new Map<string, Set<string>>()
  for (const node of nodes) {
    for (const id of collectAssetReferenceIds(node.data)) {
      const nodeIds = references.get(id) ?? new Set<string>()
      nodeIds.add(node.id)
      references.set(id, nodeIds)
    }
  }
  return references
}
