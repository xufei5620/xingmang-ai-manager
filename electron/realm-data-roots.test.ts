import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveRealmDataRoot, resolveRealmDataRoots } from './realm-data-roots'

describe('realm data roots', () => {
  const manager = path.join('C:', 'Users', 'tester', 'AppData', 'Roaming', 'xingmang')

  it('keeps xm paths compatible with the existing layout', () => {
    const roots = resolveRealmDataRoots(manager, 'xm-account')
    expect(roots.rootDirectory).toBe(path.resolve(manager))
    expect(roots.chatKeysFile).toBe(path.join(path.resolve(manager), 'chat-group-keys.dat'))
    expect(roots.canvasProjectsDirectory).toBe(path.join(path.resolve(manager), 'canvas-projects'))
    expect(roots.accountDirectory(7)).toBe(path.join(path.resolve(manager), 'user-7'))
    expect(roots.assetOutputDirectory(path.join('D:', 'xingmang', 'output'))).toBe(path.resolve('D:', 'xingmang', 'output'))
  })

  it('puts api data under a fixed independent directory', () => {
    const xm = resolveRealmDataRoots(manager, 'xm-account')
    const api = resolveRealmDataRoots(manager, 'api-account')
    expect(api.rootDirectory).toBe(path.join(path.resolve(manager), 'realms', 'api-account'))
    expect(api.rootDirectory).not.toBe(xm.rootDirectory)
    expect(api.accountDirectory(7)).not.toBe(xm.accountDirectory(7))
    expect(api.chatKeysFile).toContain(path.join('realms', 'api-account'))
    expect(api.assetOutputDirectory(path.join('D:', 'xingmang', 'output'))).toBe(path.join(path.resolve('D:', 'xingmang', 'output'), 'realms', 'api-account'))
  })

  it('rejects invalid realms and user IDs', () => {
    expect(() => resolveRealmDataRoot(manager, 'solov')).toThrow('账号数据域无效')
    expect(() => resolveRealmDataRoots(manager, 'solov-api')).toThrow('账号数据域无效')
    const roots = resolveRealmDataRoots(manager, 'api-account')
    expect(() => roots.accountDirectory(0)).toThrow('账号标识无效')
    expect(() => roots.accountDirectory(Number.MAX_SAFE_INTEGER + 1)).toThrow('账号标识无效')
  })
})
