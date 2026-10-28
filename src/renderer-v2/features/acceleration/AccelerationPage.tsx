import { useEffect, useState } from 'react'
import type { AccelerationBundleCheck } from './api'
import { useLiveAccelerationState, type useAcceleration } from './useAcceleration'
import { AccelerationView } from './AccelerationView'

/** 设置 › 网络加速最上面那张游戏加速卡；连接本身挂在 App 上（托盘、到期提醒连着它），这里只画。 */
export function AccelerationPage({ connection, scope, live = true, suspended = false, onLogin, onHelp, onContactSupport, onRelaunch, onViewLog, preview = false }: {
  connection: ReturnType<typeof useAcceleration>
  /** 状态文件关掉了网络加速（remote-features.ts）：不能新连，连着的照常能停。 */
  suspended?: boolean
  /** 这张卡正在眼前；不在时剩余时长不跟着每秒走，省得后台一直重画。 */
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
  const { snapshot, refresh, start, stop, lines, selectedLineId, rememberedLine, setSelectedLineId, linesBusy, linesError, measureLines, recheckBundle } = connection
  const state = useLiveAccelerationState(connection, live)
  const [bundleCheck, setBundleCheck] = useState<AccelerationBundleCheck | 'checking' | null>(null)
  // 没在加速时 App 不定时读状态，所以卡一露面就读一次：托盘或 Codex 桌面端可能刚连上过。
  useEffect(() => { if (live) void refresh() }, [live, refresh])
  function recheck() {
    setBundleCheck('checking')
    // 检查失败（通道出错）也按「还是不对」说：客户能做的事是一样的。
    void recheckBundle().catch((): AccelerationBundleCheck => 'damaged').then(setBundleCheck)
  }
  return <AccelerationView state={state} busy={snapshot.busy} error={snapshot.error}
    signedIn={scope !== null} suspended={suspended}
    lines={lines} selectedLineId={selectedLineId} rememberedLine={rememberedLine} linesBusy={linesBusy} linesError={linesError} onSelectLine={setSelectedLineId} onRefreshLines={() => { void measureLines() }}
    onStart={() => { void start(selectedLineId ?? undefined) }} onStartAnyway={() => { void start(selectedLineId ?? undefined, true) }}
    onStop={() => { void stop() }} onRefresh={() => { void refresh() }}
    bundleCheck={bundleCheck} onRecheckBundle={recheck} onContactSupport={onContactSupport ?? onHelp} onRelaunch={onRelaunch}
    onLogin={onLogin} onHelp={onHelp} onViewLog={onViewLog} preview={preview} />
}
