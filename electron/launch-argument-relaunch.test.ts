import { describe, expect, it } from 'vitest'
import {
  formatRelaunchedWithout,
  launchArgumentRelaunchEnvironmentKey,
  launchArgumentsRelaunchedWithout,
  takeLaunchArgumentRelaunch,
} from './launch-argument-relaunch'

describe('launch argument relaunch marker', () => {
  it('carries the dropped switch names to the relaunched process', () => {
    const env: NodeJS.ProcessEnv = { [launchArgumentRelaunchEnvironmentKey]: formatRelaunchedWithout(['disable-gpu', 'lang']) }
    expect(takeLaunchArgumentRelaunch(env)).toEqual(['disable-gpu', 'lang'])
    expect(launchArgumentsRelaunchedWithout()).toEqual(['disable-gpu', 'lang'])
  })

  it('removes the marker so nothing the process starts inherits it', () => {
    const env: NodeJS.ProcessEnv = { [launchArgumentRelaunchEnvironmentKey]: 'lang', PATH: '/usr/bin' }
    takeLaunchArgumentRelaunch(env)
    expect(env).toEqual({ PATH: '/usr/bin' })
  })

  it('reports an ordinary start as no relaunch', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    expect(takeLaunchArgumentRelaunch(env)).toBeNull()
    expect(launchArgumentsRelaunchedWithout()).toBeNull()
  })

  it('keeps only short plain names, without repeats, and never their values', () => {
    expect(formatRelaunchedWithout([
      'disable-gpu',
      'disable-gpu',
      '',
      'C:\\Users\\tester',
      'x'.repeat(41),
      'lang',
    ])).toBe('disable-gpu,?,lang')
    expect(formatRelaunchedWithout(Array.from({ length: 12 }, (_value, index) => `switch-${index}`)).split(',')).toHaveLength(8)
  })

  it('never writes an empty marker', () => {
    expect(formatRelaunchedWithout([])).toBe('?')
  })

  it('still treats an empty or rewritten marker as a relaunch', () => {
    expect(takeLaunchArgumentRelaunch({ [launchArgumentRelaunchEnvironmentKey]: '' })).toEqual(['?'])
    expect(takeLaunchArgumentRelaunch({ [launchArgumentRelaunchEnvironmentKey]: 'a b,../../x,ok' })).toEqual(['?', 'ok'])
  })
})
