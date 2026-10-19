// 主窗口业务通道的处理器：网络加速的状态、线路、开关、口令和偏好。
// #1070 第 7 步从 ipc.ts 原样搬来：按域一个文件，ipc.ts 只管组装，各域共用的东西在 context.ts。
import type { AccelerationMode } from '../../acceleration-contract'
import { isRecord } from '../../input-guards'
import { requiredString } from '../parsers/common'
import type { IpcHandlerContext } from './context'

export function registerAccelerationHandlers(ctx: IpcHandlerContext): void {
  const { options, registerTrustedHandler } = ctx
  const accelerationService = () => {
    if (!options.acceleration) throw new Error('加速服务暂未准备好，请稍后再试。')
    return options.acceleration
  }
  registerTrustedHandler('acceleration:get-state', (_event, scope: unknown) => (
    accelerationService().getAccelerationState(requiredString(scope, '加速账号', 64))
  ))
  registerTrustedHandler('acceleration:list-lines', (_event, scope: unknown) => (
    accelerationService().listAccelerationLines?.(requiredString(scope, '加速账号', 64)) ?? []
  ))
  registerTrustedHandler('acceleration:ping-line', (_event, scope: unknown, lineId: unknown) => (
    accelerationService().pingAccelerationLine?.(requiredString(scope, '加速账号', 64), requiredString(lineId, '加速线路', 80))
      ?? Promise.reject(new Error('线路检测服务暂未准备好，请稍后重试。'))
  ))
  registerTrustedHandler('acceleration:start', (_event, scope: unknown, mode: unknown, lineId: unknown, ignoreConflicts: unknown) => {
    if (mode !== 'system-proxy' && mode !== 'tun') throw new Error('加速模式无效。')
    if (lineId !== undefined && typeof lineId !== 'string') throw new Error('加速线路参数无效。')
    // The renderer only sets this after the user answered the conflict warning
    // with 仍然连接; it is a decision, never a default.
    if (ignoreConflicts !== undefined && typeof ignoreConflicts !== 'boolean') throw new Error('加速冲突确认参数无效。')
    const accountScope = requiredString(scope, '加速账号', 64)
    if (ignoreConflicts !== undefined) return accelerationService().startAcceleration(accountScope, mode, lineId, ignoreConflicts)
    return lineId === undefined
      ? accelerationService().startAcceleration(accountScope, mode)
      : accelerationService().startAcceleration(accountScope, mode, lineId)
  })
  registerTrustedHandler('acceleration:stop', (_event, scope: unknown) => (
    accelerationService().stopAcceleration(requiredString(scope, '加速账号', 64))
  ))
  registerTrustedHandler('acceleration:redeem-code', (_event, scope: unknown, code: unknown) => {
    const accountScope = requiredString(scope, '加速账号', 64)
    const promotionCode = requiredString(code, '加速口令', 64)
    const acceleration = accelerationService()
    if (!acceleration.redeemAccelerationCode) throw new Error('加速口令兑换暂不可用，请稍后再试。')
    return acceleration.redeemAccelerationCode(accountScope, promotionCode)
  })
  registerTrustedHandler('acceleration:get-preference', (_event, scope: unknown) => (
    // 没有偏好存储时按「从没选过」回答，加速页照旧从智能分配 + 标准模式开始。
    accelerationService().getAccelerationPreference?.(requiredString(scope, '加速账号', 64))
      ?? Promise.resolve({ lineId: null, mode: 'system-proxy' as const })
  ))
  // 线路与模式是两处界面分别写的，所以收的是按字段的更新而不是整条记录：缺省
  // 的那一半保留已存的值，界面点线路不会顺手把模式也改了。
  registerTrustedHandler('acceleration:save-preference', (_event, scope: unknown, update: unknown) => {
    if (!isRecord(update)) throw new Error('加速线路偏好格式错误。')
    // null 是「智能分配」，与「这次不改线路」（缺省）是两回事，所以分开判。
    if (update.lineId !== undefined && update.lineId !== null && typeof update.lineId !== 'string') throw new Error('加速线路参数无效。')
    if (update.mode !== undefined && update.mode !== 'system-proxy' && update.mode !== 'tun') throw new Error('加速模式无效。')
    const service = accelerationService()
    if (!service.saveAccelerationPreference) throw new Error('加速线路偏好暂不可用，请稍后重试。')
    return service.saveAccelerationPreference(requiredString(scope, '加速账号', 64), {
      ...(update.lineId !== undefined ? { lineId: update.lineId as string | null } : {}),
      ...(update.mode !== undefined ? { mode: update.mode as AccelerationMode } : {}),
    })
  })
  // 不收参数：读的是安装包里那几个固定文件名，渲染层给不出任何路径（I5）。
  registerTrustedHandler('acceleration:recheck-bundle', () => {
    const service = accelerationService()
    if (!service.recheckAccelerationBundle) throw new Error('加速文件现在不用检查，请重新打开「设置 › 网络加速」。')
    return service.recheckAccelerationBundle()
  })
}
