import { describe, expect, it } from 'vitest'
import { createRunProposalClaim } from './run-proposal-claim'

describe('run proposal claim', () => {
  it('allows only one submission for repeated clicks in the same event loop', () => {
    const claim = createRunProposalClaim()
    const proposal = { graph: {}, scope: {} }
    expect(claim(proposal)).toBe(true)
    expect(claim(proposal)).toBe(false)
    expect(claim(proposal)).toBe(false)
  })

  it('requires a new proposal after a refreshed snapshot', () => {
    const claim = createRunProposalClaim()
    const before = { prompt: 'before' }
    const after = { prompt: 'after' }
    expect(claim(before)).toBe(true)
    expect(claim(after)).toBe(true)
    expect(claim(before)).toBe(false)
    expect(claim(after)).toBe(false)
  })

  it('does not unlock an uncertain or rejected submission automatically', async () => {
    const claim = createRunProposalClaim()
    const proposal = {}
    expect(claim(proposal)).toBe(true)
    await Promise.reject(new Error('unknown result')).catch(() => undefined)
    expect(claim(proposal)).toBe(false)
  })
})
