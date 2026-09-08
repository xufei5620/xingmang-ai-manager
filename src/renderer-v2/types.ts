import type { XingmangApi } from '../../electron/ipc-contract'
import type { PageId } from './registry/pages'

export type V2Bridge = XingmangApi

export type V2Theme = 'light' | 'dark'
export type V2Platform = 'win' | 'mac' | 'linux'
export type V2Page = PageId

export interface V2ToolState {
  id: string
  installed: boolean
  version?: string | null
  model?: string | null
  configured?: boolean
  source?: string | null
  updateAvailable?: boolean
}

export interface V2AccountState {
  signedIn: boolean
  displayName?: string
  email?: string
  balance?: string
}

export interface V2SystemState {
  tools: V2ToolState[]
  runtime: { node?: string; npm?: string; python?: string }
  account: V2AccountState
  checkedAt?: string | null
}

declare global {
  interface Window { xingmang: V2Bridge }
}
