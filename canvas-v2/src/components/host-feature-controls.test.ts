import { describe, expect, it } from 'vitest'
import { v2EquivalentCapabilities } from '../host-capabilities'
import { fullCanvasCapabilityProfile } from '../host-capabilities.test-fixture'
import { hostCandidateCountChoices, hostFeatureControlShown } from './host-feature-controls'

describe('host feature controls', () => {
  it('shows a control when the host has the switch on, the node already uses it, or no host profile is given', () => {
    expect(hostFeatureControlShown(undefined, 'imageEditMask')).toBe(true)
    expect(hostFeatureControlShown(fullCanvasCapabilityProfile, 'imageEditMask')).toBe(true)
    expect(hostFeatureControlShown(v2EquivalentCapabilities, 'imageEditMask')).toBe(false)
    expect(hostFeatureControlShown(v2EquivalentCapabilities, 'imageEditMask', true)).toBe(true)
  })

  it('offers counts up to the host maximum and keeps the saved count', () => {
    expect(hostCandidateCountChoices([1, 2, 3, 4], 1, undefined)).toEqual([1, 2, 3, 4])
    expect(hostCandidateCountChoices([1, 2, 3, 4], 1, 2)).toEqual([1, 2])
    expect(hostCandidateCountChoices([1, 2, 3, 4], 4, 1)).toEqual([1, 4])
  })
})
