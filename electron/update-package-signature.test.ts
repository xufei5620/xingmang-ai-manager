import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  UPDATE_SIGNATURE_FIELD,
  buildUpdateSignaturePayload,
  updateSigningPublicKeys,
  verifyUpdateEntrySignature,
} from './update-package-signature'

function keyPair(): { privateKey: KeyObject, publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { privateKey, publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }
}

const entry = { url: 'XingMang-AI-Manager-0.2.11-Setup.exe', sha512: `${'A'.repeat(86)}==` }

function signed(privateKey: KeyObject, version = '0.2.11', target = entry): Record<string, string> {
  const payload = buildUpdateSignaturePayload(version, target)
  if (payload === null) throw new Error('payload')
  return { ...target, [UPDATE_SIGNATURE_FIELD]: sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64') }
}

describe('update package signature', () => {
  it('builds exactly the text scripts/update-manifest-signature.cjs signs', () => {
    // 与 scripts/update-manifest-signature.test.cjs 的同名断言逐字一致；改一边必须改另一边。
    expect(buildUpdateSignaturePayload('0.2.11', { url: 'a.exe', sha512: 'abc==' }))
      .toBe('xingmang-update-signature/v1\nversion=0.2.11\nurl=a.exe\nsha512=abc==\n')
    expect(buildUpdateSignaturePayload('0.2.11', { url: 'a.exe\nsha512=x', sha512: 'abc==' })).toBeNull()
  })

  it('accepts an entry signed by a pinned key', () => {
    const { privateKey, publicKey } = keyPair()
    expect(verifyUpdateEntrySignature('0.2.11', signed(privateKey), [publicKey])).toEqual({ ok: true })
  })

  it('accepts a signature from any pinned key so a replacement key can be rolled in', () => {
    const current = keyPair()
    const next = keyPair()
    expect(verifyUpdateEntrySignature('0.2.11', signed(next.privateKey), [current.publicKey, next.publicKey])).toEqual({ ok: true })
  })

  it('rejects a missing signature instead of letting it through', () => {
    const { publicKey } = keyPair()
    expect(verifyUpdateEntrySignature('0.2.11', { ...entry }, [publicKey])).toMatchObject({ ok: false, code: 'UPDATE_SIGNATURE_MISSING' })
  })

  it('rejects a signature from a key the client does not pin', () => {
    const attacker = keyPair()
    const { publicKey } = keyPair()
    expect(verifyUpdateEntrySignature('0.2.11', signed(attacker.privateKey), [publicKey])).toMatchObject({ ok: false, code: 'UPDATE_SIGNATURE_INVALID' })
  })

  it('rejects a genuine signature moved onto another package or version', () => {
    const { privateKey, publicKey } = keyPair()
    const genuine = signed(privateKey)
    expect(verifyUpdateEntrySignature('0.2.11', { ...genuine, sha512: `${'B'.repeat(86)}==` }, [publicKey]))
      .toMatchObject({ ok: false, code: 'UPDATE_SIGNATURE_INVALID' })
    expect(verifyUpdateEntrySignature('0.2.12', genuine, [publicKey])).toMatchObject({ ok: false, code: 'UPDATE_SIGNATURE_INVALID' })
  })

  it('rejects a malformed signature value', () => {
    const { publicKey } = keyPair()
    expect(verifyUpdateEntrySignature('0.2.11', { ...entry, [UPDATE_SIGNATURE_FIELD]: 'not-base64' }, [publicKey]))
      .toMatchObject({ ok: false, code: 'UPDATE_SIGNATURE_INVALID' })
    expect(verifyUpdateEntrySignature('0.2.11', { ...entry, [UPDATE_SIGNATURE_FIELD]: 42 }, [publicKey]))
      .toMatchObject({ ok: false, code: 'UPDATE_SIGNATURE_INVALID' })
  })

  it('refuses everything when no usable key is configured', () => {
    const { privateKey } = keyPair()
    const { privateKey: rsa } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const rsaPublic = rsa.export({ format: 'der', type: 'pkcs8' }).toString('base64')
    expect(verifyUpdateEntrySignature('0.2.11', signed(privateKey), [])).toMatchObject({ ok: false, code: 'UPDATE_SIGNATURE_UNCONFIGURED' })
    expect(verifyUpdateEntrySignature('0.2.11', signed(privateKey), ['garbage', rsaPublic])).toMatchObject({ ok: false, code: 'UPDATE_SIGNATURE_UNCONFIGURED' })
  })

  it('pins only well-formed Ed25519 keys', () => {
    for (const key of updateSigningPublicKeys) {
      // Every Ed25519 SPKI DER key starts with the same 12-byte header.
      expect(key).toMatch(/^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$/)
    }
  })
})
