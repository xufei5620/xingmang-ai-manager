import type { V2Bridge } from './types'

export function bridge(): V2Bridge | null {
  return typeof window !== 'undefined' && window.xingmang ? window.xingmang : null
}
