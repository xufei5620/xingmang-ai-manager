import { parseWorkflowFile } from '../model'
import { utf8ByteLength } from './canvas-limits'
import { projectSnapshotLimits } from './project-snapshot-contract'

const credentialField = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|secret|password)/i

/** Inspect the exact saved bytes before returning a private workflow snapshot.
 * Parsed workflows deliberately discard unknown fields; that normalization
 * cannot prove that the original document is free of private credentials. */
export function assertProjectSnapshotContent(content: unknown, unavailable: () => never): asserts content is string {
  if (typeof content !== 'string' || !content || utf8ByteLength(content) > projectSnapshotLimits.contentBytes) unavailable()
  let raw: unknown
  try { raw = JSON.parse(content) } catch { unavailable() }
  function inspect(value: unknown, depth: number): void {
    if (depth > 32) unavailable()
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const item of value) inspect(item, depth + 1); return }
    for (const [key, item] of Object.entries(value)) {
      if (credentialField.test(key)) unavailable()
      inspect(item, depth + 1)
    }
  }
  inspect(raw, 0)
  if (!parseWorkflowFile(content)) unavailable()
}
