import { describe, expect, it } from 'vitest'
import { linuxCommandPathCandidates } from './linux-platform'

describe('Linux command path candidates', () => {
  it('puts caller paths first, then the managed runtime and CLIs, then the inherited PATH', () => {
    const candidates = linuxCommandPathCandidates({ PATH: '/usr/bin:/home/a/.nvm/versions/node/v22.0.0/bin' }, ['/exact'], '/home/a')
    expect(candidates.slice(0, 5)).toEqual([
      '/exact',
      '/home/a/.local/share/XingMangAI/Runtime/node/bin',
      '/home/a/.local/share/XingMangAI/Cli/npm/bin',
      '/usr/bin',
      '/home/a/.nvm/versions/node/v22.0.0/bin',
    ])
  })

  it('follows XDG_DATA_HOME for the managed directories', () => {
    const candidates = linuxCommandPathCandidates({ PATH: '', XDG_DATA_HOME: '/data/a' }, [], '/home/a')
    expect(candidates.slice(0, 2)).toEqual([
      '/data/a/XingMangAI/Runtime/node/bin',
      '/data/a/XingMangAI/Cli/npm/bin',
    ])
  })

  it('adds the user directories a desktop-launched app does not inherit, after the inherited PATH', () => {
    const candidates = linuxCommandPathCandidates({
      PATH: '/usr/bin',
      VOLTA_HOME: '/opt/volta',
      FNM_MULTISHELL_PATH: '/run/user/1000/fnm_multishells/1',
    }, [], '/home/a')
    const inherited = candidates.indexOf('/usr/bin')
    for (const entry of [
      '/opt/volta/bin',
      '/run/user/1000/fnm_multishells/1',
      '/home/a/.local/bin',
      '/home/a/.npm-global/bin',
      '/home/a/.volta/bin',
      '/home/a/.local/share/fnm/aliases/default/bin',
      '/home/a/.grok/bin',
      '/usr/local/bin',
      '/snap/bin',
    ]) {
      expect(candidates.indexOf(entry)).toBeGreaterThan(inherited)
    }
  })

  it('still yields the system directories when there is no usable home directory', () => {
    const candidates = linuxCommandPathCandidates({ PATH: '' }, [], 'relative/home')
    expect(candidates.filter(Boolean)).toEqual(['/usr/local/bin', '/usr/bin', '/bin', '/snap/bin'])
  })
})
