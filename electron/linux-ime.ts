/**
 * Chinese input under a Wayland session.
 *
 * Electron 43 runs as a native Wayland client whenever the session is Wayland
 * (Ubuntu 22.04/24.04 GNOME by default), and in that mode Chromium talks to
 * the input method only through the text-input protocol, which it leaves off
 * unless asked. Measured in the sandbox against a nested weston (WAYLAND_DEBUG,
 * Electron 43.6.0): with no switch, and with --enable-wayland-ime alone, the
 * focused <input> never created a zwp_text_input object; with
 * --enable-wayland-ime plus --wayland-text-input-version it was created and
 * activated. app.commandLine.appendSwitch before `ready` was enough for both,
 * unlike --ozone-platform, which Chromium reads before any JavaScript runs (so
 * "run under XWayland instead" is not available without a relaunch).
 *
 * Version 3 because it is what GNOME's compositor speaks (it has no v1) and
 * what KDE, sway and Hyprland speak too; the measurement above only shows that
 * Chromium does not pick v1 by itself.
 *
 * An X11 session (UOS, deepin, Kylin by default) needs nothing: there Chromium
 * goes through the GTK input-method module like every other desktop app.
 */
export interface LinuxImeInput {
  env: Readonly<Record<string, string | undefined>>
  /** The switch is already on the real command line. */
  hasSwitch(name: string): boolean
}

export interface LinuxImeSwitch {
  name: string
  value?: string
}

export function isWaylandSession(env: LinuxImeInput['env']): boolean {
  return env.XDG_SESSION_TYPE === 'wayland' || Boolean(env.WAYLAND_DISPLAY)
}

/** Switches to append before `ready`; empty when there is nothing to do. */
export function resolveLinuxImeSwitches(input: LinuxImeInput): LinuxImeSwitch[] {
  if (!isWaylandSession(input.env)) return []
  const switches: LinuxImeSwitch[] = []
  if (!input.hasSwitch('enable-wayland-ime')) switches.push({ name: 'enable-wayland-ime' })
  // Someone who chose a version by hand knows their compositor better than we do.
  if (!input.hasSwitch('wayland-text-input-version')) switches.push({ name: 'wayland-text-input-version', value: '3' })
  return switches
}
