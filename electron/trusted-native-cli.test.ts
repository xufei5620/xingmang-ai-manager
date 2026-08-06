import { describe, expect, it } from 'vitest'
import { parseNativeCliSignature, validateNativeCliSignature } from './trusted-native-cli'

describe('trusted native CLI publishers', () => {
  it('normalizes Windows PowerShell 5.1/7 Authenticode enum JSON shapes', () => {
    expect(parseNativeCliSignature({ Status: 0, Subject: 'CN=X.AI LLC, O=X.AI LLC' }))
      .toEqual({ status: 'Valid', subject: 'CN=X.AI LLC, O=X.AI LLC' })
    expect(parseNativeCliSignature({ status: 'NotSigned', subject: null }))
      .toEqual({ status: 'NotSigned', subject: null })
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
      subject: 'CN=X.AI LLC, SERIALNUMBER=NV20243235882, O=X.AI LLC, C=US',
    })).not.toThrow()
  })

  it('rejects unsigned, unexpected, and unsupported native executables', () => {
    expect(() => validateNativeCliSignature('grok', {
      status: 'NotSigned',
      subject: null,
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
})
