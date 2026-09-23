import { describe, expect, it } from 'vitest'
import { rememberedLoginAction } from './remembered-login'

describe('rememberedLoginAction', () => {
  it('sends a signed-out user to the login dialog, where the remember box lives', () => {
    expect(rememberedLoginAction(undefined)).toEqual({ kind: 'login' })
    expect(rememberedLoginAction(null)).toEqual({ kind: 'login' })
    expect(rememberedLoginAction({ authenticated: false })).toEqual({ kind: 'login' })
  })

  it('never sends a signed-in user to the login dialog; it clears the remembered password instead', () => {
    expect(rememberedLoginAction({ authenticated: true, siteId: 'solov-api' })).toEqual({ kind: 'forget', siteId: 'solov-api' })
    expect(rememberedLoginAction({ authenticated: true })).toEqual({ kind: 'forget', siteId: undefined })
  })
})
