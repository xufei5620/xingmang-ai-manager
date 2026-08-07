import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  defaultProviderConfigRoots,
  providerConfigRoot,
  resolveCodexHomeContext,
} from './codex-home'

const userHome = path.resolve('/users/alex')
const override = path.resolve('/volumes/dev-codex')
const environmentHome = path.resolve('/volumes/env-codex')

describe('resolveCodexHomeContext', () => {
  it('uses the development override before CODEX_HOME without changing HOME values', () => {
    const env = {
      HOME: userHome,
      USERPROFILE: 'C:\\Users\\alex',
      CODEX_HOME: environmentHome,
      XINGMANG_CODEX_HOME_OVERRIDE: `  ${override}  `,
    }
    const originalEnv = { ...env }

    const result = resolveCodexHomeContext({ isPackaged: false, env, userHome })

    expect(result.codexHome).toBe(override)
    expect(result.codexEnv).toEqual({ ...env, CODEX_HOME: override })
    expect(result.codexEnv).not.toBe(env)
    expect(env).toEqual(originalEnv)
    expect(result.codexEnv.HOME).toBe(userHome)
    expect(result.codexEnv.USERPROFILE).toBe('C:\\Users\\alex')
  })

  it('ignores the development override in packaged builds', () => {
    expect(resolveCodexHomeContext({
      isPackaged: true,
      env: { CODEX_HOME: environmentHome, XINGMANG_CODEX_HOME_OVERRIDE: override },
      userHome,
    }).codexHome).toBe(environmentHome)
  })

  it('falls back to the user default when a packaged build has only the development override', () => {
    expect(resolveCodexHomeContext({
      isPackaged: true,
      env: { XINGMANG_CODEX_HOME_OVERRIDE: override },
      userHome,
    }).codexHome).toBe(path.join(userHome, '.codex'))
  })

  it('rejects invalid packaged CODEX_HOME even when the development override is valid', () => {
    expect(() => resolveCodexHomeContext({
      isPackaged: true,
      env: { CODEX_HOME: '../invalid', XINGMANG_CODEX_HOME_OVERRIDE: override },
      userHome,
    })).toThrow(/CODEX_HOME/)
  })

  it('uses the default only when every applicable environment value is empty', () => {
    expect(resolveCodexHomeContext({
      isPackaged: false,
      env: { CODEX_HOME: ' ', XINGMANG_CODEX_HOME_OVERRIDE: '' },
      userHome,
    }).codexHome).toBe(path.join(userHome, '.codex'))
  })

  it.each([
    { env: { XINGMANG_CODEX_HOME_OVERRIDE: '../escape', CODEX_HOME: environmentHome }, name: 'override' },
    { env: { CODEX_HOME: 'relative/codex' }, name: 'CODEX_HOME' },
    { env: { CODEX_HOME: `${environmentHome}\0suffix` }, name: 'NUL' },
  ])('rejects invalid selected $name instead of falling through', ({ env }) => {
    expect(() => resolveCodexHomeContext({ isPackaged: false, env, userHome })).toThrow()
  })

  it('maps only Codex to the independent root', () => {
    const roots = { userHome, codexHome: override }

    expect(providerConfigRoot('codex', roots)).toBe(override)
    expect(providerConfigRoot('claude', roots)).toBe(path.join(userHome, '.claude'))
    expect(providerConfigRoot('gemini', roots)).toBe(path.join(userHome, '.gemini'))
    expect(providerConfigRoot('grok', roots)).toBe(path.join(userHome, '.grok'))
    expect(defaultProviderConfigRoots(userHome, { CODEX_HOME: environmentHome })).toEqual({
      userHome,
      codexHome: environmentHome,
    })
  })
})
