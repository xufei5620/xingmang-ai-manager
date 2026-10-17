import { describe, expect, it } from 'vitest'
import { NativeCliPublisherMismatchError, parseNativeCliSignature, validateNativeCliSignature } from './trusted-native-cli'

// What Windows PowerShell prints for the two certificates xAI has signed grok.exe
// with: X.AI LLC up to 1.0.53, X Corp. from 1.0.54 (read from the official
// 1.0.52 and 1.0.62 binaries).
const xaiLlcSubject = 'OID.1.3.6.1.4.1.311.60.2.1.3=US, OID.1.3.6.1.4.1.311.60.2.1.2=Nevada, OID.2.5.4.15=Private Organization, CN=X.AI LLC, SERIALNUMBER=NV20243235882, O=X.AI LLC, L=Palo Alto, S=California, C=US'
const xaiLlcIssuer = 'CN=SSL.com EV Code Signing Intermediate CA RSA R3, O=SSL Corp, L=Houston, S=Texas, C=US'
const xCorpSubject = 'CN=X Corp., O=X Corp., L=Bastrop, S=Texas, C=US'
const xCorpIssuer = 'CN=GlobalSign GCC R45 CodeSigning CA 2020, O=GlobalSign nv-sa, C=BE'

describe('trusted native CLI publishers', () => {
  it('normalizes Windows PowerShell 5.1/7 Authenticode enum JSON shapes', () => {
    expect(parseNativeCliSignature({ Status: 0, Subject: 'CN=X.AI LLC, O=X.AI LLC' }))
      .toEqual({ status: 'Valid', subject: 'CN=X.AI LLC, O=X.AI LLC', issuer: null })
    expect(parseNativeCliSignature({ status: 'NotSigned', subject: null }))
      .toEqual({ status: 'NotSigned', subject: null, issuer: null })
  })

  it('reads the issuing CA next to the signer', () => {
    expect(parseNativeCliSignature({ Status: 'Valid', Subject: ` ${xCorpSubject} `, Issuer: ` ${xCorpIssuer} ` }))
      .toEqual({ status: 'Valid', subject: xCorpSubject, issuer: xCorpIssuer })
    expect(parseNativeCliSignature({ Status: 'NotSigned', Subject: '', Issuer: '' }))
      .toEqual({ status: 'NotSigned', subject: null, issuer: null })
  })

  it('accepts the official OpenAI, Anthropic and xAI Authenticode subjects', () => {
    expect(() => validateNativeCliSignature('codex', {
      status: 'Valid',
      subject: 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", C=US',
    })).not.toThrow()
    expect(() => validateNativeCliSignature('claude', {
      status: 'Valid',
      subject: 'CN="Anthropic, PBC", O="Anthropic, PBC", C=US',
    })).not.toThrow()
    expect(() => validateNativeCliSignature('grok', {
      status: 'Valid',
      subject: xaiLlcSubject,
      issuer: xaiLlcIssuer,
    })).not.toThrow()
  })

  it('accepts the X Corp. certificate xAI signs Grok with from 1.0.54', () => {
    expect(() => validateNativeCliSignature('grok', {
      status: 'Valid',
      subject: xCorpSubject,
      issuer: xCorpIssuer,
    })).not.toThrow()
    // Same name printed with the RFC 4514 state label.
    expect(() => validateNativeCliSignature('grok', {
      status: 'Valid',
      subject: 'CN=X Corp., O=X Corp., L=Bastrop, ST=Texas, C=US',
      issuer: xCorpIssuer,
    })).not.toThrow()
  })

  it('rejects an xAI signer name issued by a CA other than the one it is pinned to', () => {
    for (const signature of [
      { subject: xCorpSubject, issuer: xaiLlcIssuer },
      { subject: xaiLlcSubject, issuer: xCorpIssuer },
      { subject: xCorpSubject, issuer: 'CN=Other Code Signing CA, O=Other CA, C=US' },
      { subject: xaiLlcSubject, issuer: 'CN=Other Code Signing CA, O=Other CA, C=US' },
      { subject: xCorpSubject, issuer: 'CN=GlobalSign GCC R45 CodeSigning CA 2020, O=Not GlobalSign, C=BE' },
      { subject: xCorpSubject, issuer: null },
      { subject: xCorpSubject },
      { subject: xaiLlcSubject },
    ]) {
      expect(() => validateNativeCliSignature('grok', { status: 'Valid', ...signature }))
        .toThrow(NativeCliPublisherMismatchError)
    }
  })

  it('rejects names that only resemble the X Corp. signer', () => {
    for (const subject of [
      'CN=X Corp. Holdings, O=X Corp. Holdings, L=Bastrop, S=Texas, C=US',
      'CN=X Corp., O=X Corp., L=Austin, S=Texas, C=US',
      'CN=X Corp., O=X Corp., L=Bastrop, S=Nevada, C=US',
      'CN=X Corp., O=X Corp., L=Bastrop, S=Texas, C=CA',
      'CN=X Corp., OU=X Corp., O=Evil LLC, L=Bastrop, S=Texas, C=US',
      'CN=X Corp, O=X Corp, L=Bastrop, S=Texas, C=US',
      'CN=X CorpX, O=X CorpX, L=Bastrop, S=Texas, C=US',
    ]) {
      expect(() => validateNativeCliSignature('grok', { status: 'Valid', subject, issuer: xCorpIssuer }))
        .toThrow('官方发布者不一致')
    }
  })

  it('rejects unsigned, unexpected, and unsupported native executables', () => {
    expect(() => validateNativeCliSignature('grok', {
      status: 'NotSigned',
      subject: null,
    })).toThrow('没有有效')
    expect(() => validateNativeCliSignature('grok', {
      status: 'HashMismatch',
      subject: xCorpSubject,
      issuer: xCorpIssuer,
    })).toThrow('没有有效')
    expect(() => validateNativeCliSignature('claude', {
      status: 'Valid',
      subject: 'CN=Unexpected Publisher, O=Unexpected Publisher, C=US',
    })).toThrow('官方发布者不一致')
    expect(() => validateNativeCliSignature('gemini', {
      status: 'Valid',
      subject: 'CN=Google LLC, O=Google LLC',
    })).toThrow('不支持安全托管')
    expect(() => validateNativeCliSignature('codex', {
      status: 'Valid',
      subject: 'CN=OpenAI, O=OpenAI',
    })).toThrow('官方发布者不一致')
  })

  it('only grants Grok the X Corp. signer', () => {
    expect(() => validateNativeCliSignature('codex', { status: 'Valid', subject: xCorpSubject, issuer: xCorpIssuer }))
      .toThrow('官方发布者不一致')
    expect(() => validateNativeCliSignature('claude', { status: 'Valid', subject: xCorpSubject, issuer: xCorpIssuer }))
      .toThrow('官方发布者不一致')
  })
})
