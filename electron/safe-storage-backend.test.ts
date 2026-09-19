import { describe, expect, it } from 'vitest'
import {
  inspectSafeStorageBackend,
  isSafeStorageUsable,
  safeStoragePlaintextMessage,
  type SafeStorageBackendLike,
} from './safe-storage-backend'

function cipher(overrides: Partial<SafeStorageBackendLike> = {}): SafeStorageBackendLike {
  return { isEncryptionAvailable: () => true, ...overrides }
}

describe('safe storage backend inspection', () => {
  it('accepts an OS-backed cipher that reports no backend at all', () => {
    expect(inspectSafeStorageBackend(cipher())).toBe('ok')
    expect(isSafeStorageUsable(cipher())).toBe(true)
  })

  it('accepts every named backend that is actually key-derived', () => {
    for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6', 'unknown']) {
      expect(inspectSafeStorageBackend(cipher({ getSelectedStorageBackend: () => backend }))).toBe('ok')
    }
  })

  it('rejects basic_text, whose key ships inside every build', () => {
    const plaintext = cipher({ getSelectedStorageBackend: () => 'basic_text' })
    expect(inspectSafeStorageBackend(plaintext)).toBe('plaintext')
    expect(isSafeStorageUsable(plaintext)).toBe(false)
  })

  it('reports unavailability ahead of the backend, which is then unreadable anyway', () => {
    const unavailable = cipher({
      isEncryptionAvailable: () => false,
      getSelectedStorageBackend: () => 'basic_text',
    })
    expect(inspectSafeStorageBackend(unavailable)).toBe('unavailable')
    expect(isSafeStorageUsable(unavailable)).toBe(false)
  })

  it('names the refused data in a message a user can act on', () => {
    const message = safeStoragePlaintextMessage('托管 API Key')
    expect(message).toContain('托管 API Key')
    expect(message).toContain('明文')
    expect(message).not.toMatch(/basic_text|safeStorage/)
  })
})
