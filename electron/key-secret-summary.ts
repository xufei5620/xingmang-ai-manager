import { createHash } from 'node:crypto'

/** Main-only metadata. Fingerprints must never be sent through IPC. */
export interface KeySecretSummary {
  maskedKey: string
  keyFingerprint?: string
}

const mask = '••••••••'

/** Derive a bounded display without retaining plaintext or inventing a prefix. */
export function summarizeKeySecret(value: unknown): KeySecretSummary {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(value)) {
    return { maskedKey: mask }
  }
  const prefix = value.startsWith('sk-') ? 'sk-' : ''
  const body = prefix ? value.slice(prefix.length) : value
  if (/[*•…]/.test(body)) {
    // A masked upstream value cannot identify a key. Retain only the suffix
    // already explicitly exposed, never hash the mask or expose its head.
    const suffix = /^[A-Za-z0-9_-]*[*•…]+([A-Za-z0-9_-]{0,4})$/.exec(body)?.[1] ?? ''
    return { maskedKey: `${prefix}${mask}${suffix}` }
  }
  if (!/^[A-Za-z0-9_-]+$/.test(body)) return { maskedKey: mask }
  return {
    maskedKey: body.length > 8 ? `${prefix}${mask}${body.slice(-4)}` : mask,
    keyFingerprint: createHash('sha256').update(value, 'utf8').digest('hex'),
  }
}
