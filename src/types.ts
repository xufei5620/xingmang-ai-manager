import type { XingmangApi } from '../electron/ipc-contract'

export * from '../electron/ipc-contract'

declare global {
  interface Window {
    xingmang: XingmangApi
  }
}
