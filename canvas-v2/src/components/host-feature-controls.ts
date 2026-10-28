// 节点里各项功能的控件按宿主能力显示（#4）：宿主关掉的功能不给入口。没传宿主能力（测试、纯函数调用方）时什么都不藏。
import type { CanvasCapabilityProfile, CanvasHostFeature } from '../host-capabilities'

/**
 * Whether a node offers a feature's control. A value already on the node
 * keeps its control, so the user can see it and turn it off; the run
 * preflight blocks the node until then.
 */
export function hostFeatureControlShown(capabilities: CanvasCapabilityProfile | undefined, feature: CanvasHostFeature, alreadySet = false): boolean {
  return !capabilities || capabilities.features[feature] || alreadySet
}

/** The candidate counts a node offers: up to the host's maximum, and the saved count so it stays visible. */
export function hostCandidateCountChoices<T extends number>(counts: readonly T[], current: number, maximum: number | undefined): T[] {
  return counts.filter((count) => maximum === undefined || count <= maximum || count === current)
}
