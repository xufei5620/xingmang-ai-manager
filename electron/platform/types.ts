import type { PlatformCapabilities } from '../platform-capabilities'

export type PlatformUiFamily = PlatformCapabilities['platform']
export type PlatformCommandModifier = 'Ctrl' | '\u2318'
export type UiScalePreference = 'auto' | '90' | '100' | '110'

export interface PlatformNativeCapabilities {
  readonly tray: boolean
  readonly notifications: boolean
  readonly safeStorage: boolean
  readonly deepLinks: boolean
  readonly startup: boolean
}

export interface PlatformUiRegistry {
  readonly family: PlatformUiFamily
  readonly titleBarHeightDip: number
  readonly commandModifier: PlatformCommandModifier
  readonly workspacePathExample: string
  readonly appDataPathExample: string
  readonly terminalNames: readonly string[]
}

export interface PlatformCapabilityFacade extends PlatformCapabilities {
  readonly native: PlatformNativeCapabilities
  readonly ui: PlatformUiRegistry
}
