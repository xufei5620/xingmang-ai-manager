import type { AccelerationApi, AccelerationPreferenceApi } from '../../../../electron/acceleration-contract'

export type { AccelerationApi, AccelerationConflictKind, AccelerationLine, AccelerationMode, AccelerationPreference, AccelerationPreferenceApi, AccelerationPreferenceUpdate, AccelerationRedemptionResult, AccelerationState } from '../../../../electron/acceleration-contract'

/**
 * 偏好那两个方法是可选的：交互预览与旧版宿主上没有它们，那里照旧每次从
 * 「智能分配 + 标准模式」开始，加速页的其余部分一行不变。
 */
export type AccelerationClient = AccelerationApi & Partial<AccelerationPreferenceApi>

/** The bridge is the only authority for connectivity and account time. */
export function createAccelerationApi(bridge: (Partial<AccelerationApi> & Partial<AccelerationPreferenceApi>) | null): AccelerationClient {
  const unavailable = () => Promise.reject(new Error('加速服务暂未就绪，请稍后重试。'))
  return {
    getAccelerationState: (scope) => bridge?.getAccelerationState ? bridge.getAccelerationState(scope) : unavailable(),
    startAcceleration: (scope, mode, lineId, ignoreConflicts) => bridge?.startAcceleration
      ? ignoreConflicts === undefined
        ? lineId === undefined ? bridge.startAcceleration(scope, mode) : bridge.startAcceleration(scope, mode, lineId)
        : bridge.startAcceleration(scope, mode, lineId, ignoreConflicts)
      : unavailable(),
    stopAcceleration: (scope) => bridge?.stopAcceleration ? bridge.stopAcceleration(scope) : unavailable(),
    redeemAccelerationCode: (scope, code) => bridge?.redeemAccelerationCode ? bridge.redeemAccelerationCode(scope, code) : unavailable(),
    listAccelerationLines: (scope) => bridge?.listAccelerationLines ? bridge.listAccelerationLines(scope) : Promise.resolve([]),
    pingAccelerationLine: (scope, lineId) => bridge?.pingAccelerationLine ? bridge.pingAccelerationLine(scope, lineId) : unavailable(),
    ...(bridge?.getAccelerationPreference ? { getAccelerationPreference: bridge.getAccelerationPreference.bind(bridge) } : {}),
    ...(bridge?.saveAccelerationPreference ? { saveAccelerationPreference: bridge.saveAccelerationPreference.bind(bridge) } : {}),
  }
}
