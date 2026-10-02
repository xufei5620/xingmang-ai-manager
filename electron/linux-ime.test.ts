import { describe, expect, it } from 'vitest'
import { isWaylandSession, resolveLinuxImeSwitches } from './linux-ime'

function none(): boolean {
  return false
}

describe('linux-ime', () => {
  it('leaves an X11 session alone, where GTK already carries the input method', () => {
    expect(resolveLinuxImeSwitches({ env: { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }, hasSwitch: none })).toEqual([])
    expect(resolveLinuxImeSwitches({ env: {}, hasSwitch: none })).toEqual([])
  })

  it('turns on the Wayland text-input protocol, version 3, for a Wayland session', () => {
    const expected = [{ name: 'enable-wayland-ime' }, { name: 'wayland-text-input-version', value: '3' }]
    expect(resolveLinuxImeSwitches({ env: { XDG_SESSION_TYPE: 'wayland' }, hasSwitch: none })).toEqual(expected)
    // Some launchers drop XDG_SESSION_TYPE but keep the socket name.
    expect(resolveLinuxImeSwitches({ env: { WAYLAND_DISPLAY: 'wayland-0' }, hasSwitch: none })).toEqual(expected)
  })

  it('keeps whatever the user already put on the command line', () => {
    expect(resolveLinuxImeSwitches({
      env: { XDG_SESSION_TYPE: 'wayland' },
      hasSwitch: (name) => name === 'wayland-text-input-version',
    })).toEqual([{ name: 'enable-wayland-ime' }])
    expect(resolveLinuxImeSwitches({ env: { XDG_SESSION_TYPE: 'wayland' }, hasSwitch: () => true })).toEqual([])
  })

  it('recognises a Wayland session by either signal', () => {
    expect(isWaylandSession({ XDG_SESSION_TYPE: 'wayland' })).toBe(true)
    expect(isWaylandSession({ WAYLAND_DISPLAY: 'wayland-1' })).toBe(true)
    expect(isWaylandSession({ XDG_SESSION_TYPE: 'x11' })).toBe(false)
    expect(isWaylandSession({ WAYLAND_DISPLAY: '' })).toBe(false)
  })
})
