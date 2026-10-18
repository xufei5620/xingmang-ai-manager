/**
 * 线路切换、系统代理复查、加速到期和中断提醒这几个后台控制器默认都用它计时（测试各自注入假的）。
 * unref：这些都是后台复查，进程该退的时候不能因为一个还没到点的复查被拖住。
 */
export function scheduleTimeout(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}
