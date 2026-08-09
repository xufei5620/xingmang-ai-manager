import { describe, expect, it, vi } from 'vitest'
import { resolveCanvasAuthToken, type CanvasAuthTokenDependencies } from './canvas-auth'

const baseUrl = 'https://xm.solov.cc'

function fakeDeps(overrides: Partial<CanvasAuthTokenDependencies> = {}): CanvasAuthTokenDependencies {
  return {
    isAccountAuthenticated: vi.fn(() => true),
    revealConfiguredRelayKey: vi.fn(() => ''),
    provisionRelayKey: vi.fn(async () => 'sk-provisioned'),
    ...overrides,
  }
}

describe('resolveCanvasAuthToken', () => {
  it('returns null without calling anything else when not logged in (no network at all)', async () => {
    const deps = fakeDeps({ isAccountAuthenticated: vi.fn(() => false) })

    const result = await resolveCanvasAuthToken(baseUrl, deps)

    expect(result).toBeNull()
    expect(deps.revealConfiguredRelayKey).not.toHaveBeenCalled()
    expect(deps.provisionRelayKey).not.toHaveBeenCalled()
  })

  it('reuses an already-configured CLI key without provisioning a new one', async () => {
    const deps = fakeDeps({ revealConfiguredRelayKey: vi.fn(() => 'sk-already-on-disk') })

    const result = await resolveCanvasAuthToken(baseUrl, deps)

    expect(result).toEqual({ baseUrl, apiKey: 'sk-already-on-disk' })
    expect(deps.provisionRelayKey).not.toHaveBeenCalled()
  })

  it('falls back to provisioning a fresh key when authenticated but nothing is configured locally', async () => {
    const deps = fakeDeps()

    const result = await resolveCanvasAuthToken(baseUrl, deps)

    expect(result).toEqual({ baseUrl, apiKey: 'sk-provisioned' })
    expect(deps.provisionRelayKey).toHaveBeenCalledTimes(1)
  })

  it('trims whitespace from both the reveal and provision paths', async () => {
    const revealed = await resolveCanvasAuthToken(baseUrl, fakeDeps({
      revealConfiguredRelayKey: vi.fn(() => '  sk-padded  '),
    }))
    expect(revealed).toEqual({ baseUrl, apiKey: 'sk-padded' })

    const provisioned = await resolveCanvasAuthToken(baseUrl, fakeDeps({
      provisionRelayKey: vi.fn(async () => '  sk-padded-provisioned  '),
    }))
    expect(provisioned).toEqual({ baseUrl, apiKey: 'sk-padded-provisioned' })
  })

  it('returns null (never throws) when provisioning fails, and reports the failure via onProvisionError', async () => {
    const failure = new Error('请先登录星芒账号')
    const onProvisionError = vi.fn()
    const deps = fakeDeps({
      provisionRelayKey: vi.fn(async () => { throw failure }),
      onProvisionError,
    })

    await expect(resolveCanvasAuthToken(baseUrl, deps)).resolves.toBeNull()
    expect(onProvisionError).toHaveBeenCalledWith(failure)
  })

  it('returns null when provisioning resolves to an empty key, without erroring', async () => {
    const deps = fakeDeps({ provisionRelayKey: vi.fn(async () => '') })

    await expect(resolveCanvasAuthToken(baseUrl, deps)).resolves.toBeNull()
  })

  it('never throws when onProvisionError is omitted', async () => {
    const deps = fakeDeps({ provisionRelayKey: vi.fn(async () => { throw new Error('boom') }) })
    delete (deps as { onProvisionError?: unknown }).onProvisionError

    await expect(resolveCanvasAuthToken(baseUrl, deps)).resolves.toBeNull()
  })
})
