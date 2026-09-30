import { describe, expect, it } from 'vitest'
import {
  canTrustCertificatesUserWide,
  certificateTrustConfirmBody,
  certificateTrustConfirmTitle,
  certificateTrustMessage,
} from './certificate-trust'

describe('user-wide certificate trust', () => {
  it('offers the button only when the main process marked it available', () => {
    expect(canTrustCertificatesUserWide({ code: 'CERTIFICATE_TRUST', details: { verdict: 'systemTrusted', userWide: 'available' } })).toBe(true)
    expect(canTrustCertificatesUserWide({ code: 'CERTIFICATE_TRUST', details: { verdict: 'systemTrusted', userWide: 'applied' } })).toBe(false)
    expect(canTrustCertificatesUserWide({ code: 'CERTIFICATE_TRUST', details: { verdict: 'systemTrusted' } })).toBe(false)
    expect(canTrustCertificatesUserWide({ code: 'CERTIFICATE_TRUST' })).toBe(false)
    expect(canTrustCertificatesUserWide({ code: 'XINGMANG_NETWORK', details: { userWide: 'available' } })).toBe(false)
  })

  it('says what changes and for whom before writing', () => {
    expect(certificateTrustConfirmBody).toContain('只影响你这个账号')
    expect(certificateTrustConfirmBody).toContain('新开的终端才生效')
  })

  it('says plainly what happened', () => {
    expect(certificateTrustMessage('applied')).toContain('设好了')
    expect(certificateTrustMessage('userSet')).toContain('没有改它')
  })

  it('keeps technical words off the screen', () => {
    const texts = [certificateTrustConfirmTitle, certificateTrustConfirmBody, certificateTrustMessage('applied'), certificateTrustMessage('userSet')]
    for (const text of texts) {
      expect(text).not.toMatch(/NODE_USE_SYSTEM_CA|环境变量|注册表|PATH|npm|Node\.js/i)
    }
  })
})
