import type { PlatformUiFamily, PlatformUiRegistry } from './types'

const registry: Record<PlatformUiFamily, PlatformUiRegistry> = {
  windows: Object.freeze({
    family: 'windows',
    titleBarHeightDip: 36,
    commandModifier: 'Ctrl',
    workspacePathExample: 'D:\\projects',
    appDataPathExample: '%APPDATA%\\xingmang',
    terminalNames: Object.freeze(['Windows Terminal', 'PowerShell', 'cmd']),
  }),
  macos: Object.freeze({
    family: 'macos',
    titleBarHeightDip: 46,
    commandModifier: '\u2318',
    workspacePathExample: '~/Projects',
    appDataPathExample: '~/Library/Application Support/xingmang',
    terminalNames: Object.freeze(['Terminal.app', 'iTerm2']),
  }),
  linux: Object.freeze({
    family: 'linux',
    titleBarHeightDip: 36,
    commandModifier: 'Ctrl',
    workspacePathExample: '~/projects',
    appDataPathExample: '~/.config/xingmang',
    terminalNames: Object.freeze(['gnome-terminal', 'Konsole', 'xterm']),
  }),
}

export const PLATFORM_UI_REGISTRY: Readonly<Record<PlatformUiFamily, PlatformUiRegistry>> = Object.freeze(registry)

export function platformUiRegistryFor(family: PlatformUiFamily): PlatformUiRegistry {
  return PLATFORM_UI_REGISTRY[family]
}
