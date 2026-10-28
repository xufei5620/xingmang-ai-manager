import { describe, expect, it } from 'vitest'
import { CanvasAccountChangedError, canvasAccountChangedCode, canvasAccountChangedMessage, canvasAccountStatusHeader, canvasExpectedAccountHeader, isCanvasPublicAccountId } from './canvas-account-contract'

describe('canvas account request contract', () => {
  it('exports fixed expectation and account-change response fields', () => {
    expect(canvasExpectedAccountHeader).toBe('X-Canvas-Expected-Account')
    expect(canvasAccountStatusHeader).toBe('X-Canvas-Account-Status')
    expect(canvasAccountChangedCode).toBe('ACCOUNT_CHANGED')
  })

  it('accepts a complete public UUID without rewriting its case', () => {
    expect(isCanvasPublicAccountId('a1b2c3d4-1111-4111-8111-000000000001')).toBe(true)
    expect(isCanvasPublicAccountId('A1B2C3D4-1111-4111-8111-000000000001')).toBe(true)
  })

  it.each([undefined, null, 42, {}, '', '42', 'owner-a', ' a1b2c3d4-1111-4111-8111-000000000001', 'a1b2c3d4-1111-4111-8111-000000000001 ', 'a1b2c3d4-1111-4111-8111-000000000001\n', 'a1b2c3d4-1111-4111-8111-000000000001,another', '../../account', 'a1b2c3d4-1111-4111-8111-00000000000g'])('rejects invalid account expectation %j', (value) => {
    expect(isCanvasPublicAccountId(value)).toBe(false)
  })

  it('returns a typed conflict that preserves the current editing context', () => {
    const error = new CanvasAccountChangedError()
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('CanvasAccountChangedError')
    expect(error.status).toBe(409)
    expect(error.code).toBe(canvasAccountChangedCode)
    expect(error.message).toBe(canvasAccountChangedMessage)
    expect(error.message).toContain('当前编辑内容仍保留')
  })
})
