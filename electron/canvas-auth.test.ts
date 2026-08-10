import { describe, expect, it, vi } from 'vitest'
import { resolveCanvasAuthToken, type CanvasAuthTokenDependencies } from './canvas-auth'

const baseUrl = 'https://xm.solov.cc'

function fakeDeps(overrides: Partial<CanvasAuthTokenDependencies> = {}): CanvasAuthTokenDependencies {
  return {
    hasAccountBackend: vi.fn(() => true),
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

describe('resolveCanvasAuthToken on a manual-key site (no account backend)', () => {
  const relayBaseUrl = 'https://api.solov.cc'

  function manualKeyDeps(overrides: Partial<CanvasAuthTokenDependencies> = {}): CanvasAuthTokenDependencies {
    return fakeDeps({
      hasAccountBackend: vi.fn(() => false),
      // A manual-key site has nobody to be logged in as and nothing to mint
      // from -- these fakes throw so any call is a test failure, pinning the
      // "account machinery is never touched" contract.
      isAccountAuthenticated: vi.fn(() => { throw new Error('must not consult the account session') }),
      provisionRelayKey: vi.fn(async () => { throw new Error('must not mint keys without an account backend') }),
      ...overrides,
    })
  }

  it('hands canvas the pasted relay key without ever consulting the account machinery', async () => {
    const deps = manualKeyDeps({ revealConfiguredRelayKey: vi.fn(() => 'sk-pasted') })

    const result = await resolveCanvasAuthToken(relayBaseUrl, deps)

    expect(result).toEqual({ baseUrl: relayBaseUrl, apiKey: 'sk-pasted' })
    expect(deps.isAccountAuthenticated).not.toHaveBeenCalled()
    expect(deps.provisionRelayKey).not.toHaveBeenCalled()
  })

  it('returns null when no key has been pasted yet, leaving canvas to its own config UI', async () => {
    const deps = manualKeyDeps()

    await expect(resolveCanvasAuthToken(relayBaseUrl, deps)).resolves.toBeNull()
    expect(deps.isAccountAuthenticated).not.toHaveBeenCalled()
    expect(deps.provisionRelayKey).not.toHaveBeenCalled()
  })

  it('trims the pasted key and treats whitespace-only as absent', async () => {
    const padded = await resolveCanvasAuthToken(relayBaseUrl, manualKeyDeps({
      revealConfiguredRelayKey: vi.fn(() => '  sk-pasted  '),
    }))
    expect(padded).toEqual({ baseUrl: relayBaseUrl, apiKey: 'sk-pasted' })

    const blank = await resolveCanvasAuthToken(relayBaseUrl, manualKeyDeps({
      revealConfiguredRelayKey: vi.fn(() => '   '),
    }))
    expect(blank).toBeNull()
  })
})
