import { useState } from 'react'
import type { AccelerationBundleCheck } from './api'
import { useLiveAccelerationState, type useAcceleration } from './useAcceleration'
import { AccelerationView } from './AccelerationView'

export function AccelerationPage({ connection, scope, live = true, onLogin, onHelp, onContactSupport, onRelaunch, onViewLog, preview = false }: {
  connection: ReturnType<typeof useAcceleration>
  /** 加速页正显示在前面；藏在后面时剩余时长不跟着每秒走，省得后台一直重画。 */
  live?: boolean
  scope: string | null
  onLogin(): void
  onHelp(): void
  /** 加速文件坏了时的「联系客服」；缺省退回使用帮助（那里也有「帮助与客服」）。 */
  onContactSupport?(): void
  /** 加速文件恢复后的「现在重新打开」。 */
  onRelaunch?(): void
  onViewLog?(): void
  preview?: boolean
}) {
  const { snapshot, refresh, start, stop, setMode, lines, selectedLineId, rememberedLine, setSelectedLineId, linesBusy, linesError, refreshLines, pingLine, recheckBundle } = connection
  const state = useLiveAccelerationState(connection, live)
  const [bundleCheck, setBundleCheck] = useState<AccelerationBundleCheck | 'checking' | null>(null)
  function recheck() {
    setBundleCheck('checking')
    // 检查失败（通道出错）也按「还是不对」说：客户能做的事是一样的。
    void recheckBundle().catch((): AccelerationBundleCheck => 'damaged').then(setBundleCheck)
  }
  return <AccelerationView state={state} busy={snapshot.busy} error={snapshot.error}
    signedIn={scope !== null} mode={snapshot.mode} onModeChange={setMode}
    lines={lines} selectedLineId={selectedLineId} rememberedLine={rememberedLine} linesBusy={linesBusy} linesError={linesError} onSelectLine={setSelectedLineId} onPingLine={pingLine} onRefreshLines={() => { void refreshLines() }}
    onStart={() => { void start(selectedLineId ?? undefined) }} onStartAnyway={() => { void start(selectedLineId ?? undefined, true) }}
    onStop={() => { void stop() }} onRefresh={() => { void refresh() }}
    bundleCheck={bundleCheck} onRecheckBundle={recheck} onContactSupport={onContactSupport ?? onHelp} onRelaunch={onRelaunch}
    onLogin={onLogin} onHelp={onHelp} onViewLog={onViewLog} preview={preview} />
}
