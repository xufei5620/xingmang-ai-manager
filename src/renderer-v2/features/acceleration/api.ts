import type { AccelerationApi } from '../../../../electron/acceleration-contract'

export type { AccelerationApi, AccelerationConflictKind, AccelerationLine, AccelerationMode, AccelerationRedemptionResult, AccelerationState } from '../../../../electron/acceleration-contract'

/** The bridge is the only authority for connectivity and account time. */
export function createAccelerationApi(bridge: Partial<AccelerationApi> | null): AccelerationApi {
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
  }
}
