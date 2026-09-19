import { describe, expect, it } from 'vitest'
import { onboardingPreviewEnabled } from './dev-preview'

describe('onboardingPreviewEnabled', () => {
  it('opens the preview only for the exact flag main.ts appends on a development runtime', () => {
    expect(onboardingPreviewEnabled('?onboardingPreview=1', true)).toBe(true)
    expect(onboardingPreviewEnabled('?theme=dark&onboardingPreview=1', true)).toBe(true)
    expect(onboardingPreviewEnabled('?onboardingPreview=true', true)).toBe(false)
    expect(onboardingPreviewEnabled('?onboardingPreview=0', true)).toBe(false)
    expect(onboardingPreviewEnabled('?theme=dark', true)).toBe(false)
  })

  it('never opens the preview in a packaged build, whatever the query says', () => {
    expect(onboardingPreviewEnabled('?onboardingPreview=1', false)).toBe(false)
    expect(onboardingPreviewEnabled('?theme=dark&onboardingPreview=1', false)).toBe(false)
  })
})
