import { describe, expect, it } from 'vitest'
import {
  inspectSafeStorageBackend,
  isSafeStorageUsable,
  resolveCredentialPersistence,
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

  it('names the refused data in plain words, without keyring jargon', () => {
    const message = safeStoragePlaintextMessage('托管 API Key')
    expect(message).toContain('托管 API Key')
    expect(message).toContain('已拒绝写入托管 API Key')
    expect(message).not.toMatch(/basic_text|safeStorage|密钥环|凭据服务|明文/)
  })
})

describe('credential persistence for this run', () => {
  it('signs in for this run only on Linux without a usable keyring', () => {
    expect(resolveCredentialPersistence('linux', 'unavailable')).toBe('session-only')
    expect(resolveCredentialPersistence('linux', 'plaintext')).toBe('session-only')
    expect(resolveCredentialPersistence('linux', 'ok')).toBe('durable')
  })

  it('keeps Windows and macOS on the durable path, which still refuses to sign in', () => {
    for (const platform of ['win32', 'darwin']) {
      for (const backend of ['ok', 'unavailable', 'plaintext'] as const) {
        expect(resolveCredentialPersistence(platform, backend)).toBe('durable')
      }
    }
  })
})
