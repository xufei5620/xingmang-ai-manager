import type { Plugin } from 'vite'

export interface ThirdPartyCollectorOptions {
  bundle: 'renderer' | 'canvas'
  projectRoot: string
  expectedOutDir: string
  renderer?: string
}

export interface ThirdPartyCollector {
  plugin: Plugin
  workerPlugin(): Plugin
}

export function createThirdPartyCollector(options: ThirdPartyCollectorOptions): ThirdPartyCollector
