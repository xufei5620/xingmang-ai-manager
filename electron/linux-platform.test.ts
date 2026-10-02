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

  it('leaves out a home or data directory whose name would split into relative PATH entries', () => {
    const candidates = linuxCommandPathCandidates({ PATH: '/usr/bin', XDG_DATA_HOME: '/data/x:y', VOLTA_HOME: '/opt/v:w' }, [], '/home/a:b')
    expect(candidates.some((entry) => entry.includes(':'))).toBe(false)
    expect(candidates.filter(Boolean)).toEqual(['/usr/bin', '/usr/local/bin', '/usr/bin', '/bin', '/snap/bin'])
  })

  it('drops the terminal launcher folder from the inherited PATH so a launcher never passes for an install', () => {
    const candidates = linuxCommandPathCandidates({
      PATH: '/usr/bin:/home/a/.local/share/XingMangAI/Cli/launchers:/opt/x:/home/a/.local/share/XingMangAI/Cli/launchers/',
    }, [], '/home/a')
    expect(candidates.some((entry) => entry.includes('launchers'))).toBe(false)
    expect(candidates).toContain('/opt/x')

    const custom = linuxCommandPathCandidates({ PATH: '/data/a/XingMangAI/Cli/launchers:/usr/bin', XDG_DATA_HOME: '/data/a' }, [], '/home/a')
    expect(custom.some((entry) => entry.includes('launchers'))).toBe(false)
    // Only the app's own folder is dropped, not one that merely looks like it.
    const other = linuxCommandPathCandidates({ PATH: '/home/b/.local/share/XingMangAI/Cli/launchers' }, [], '/home/a')
    expect(other).toContain('/home/b/.local/share/XingMangAI/Cli/launchers')
  })

  it('still yields the system directories when there is no usable home directory', () => {
    const candidates = linuxCommandPathCandidates({ PATH: '' }, [], 'relative/home')
    expect(candidates.filter(Boolean)).toEqual(['/usr/local/bin', '/usr/bin', '/bin', '/snap/bin'])
  })
})
