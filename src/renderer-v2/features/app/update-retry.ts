import type { UpdateFailedStep, UpdateSnapshot } from '../../../../electron/ipc-contract'

/**
 * 更新失败后「再来一次」只有一套走法，更新页的失败提示和首页右上的气泡都调这里，
 * 免得两处各写一遍、日后改了一处漏另一处。
 *
 * - 检查失败：重新检查。
 * - 下载失败（含说不清是哪一步的旧快照）：先重新检查再下。安装包被校验拒掉后更新器
 *   停在 error，直接 downloadUpdate 会被主进程顶回来，得先查出可下的东西。
 * - 安装失败：包已经下好并校验过，不必再下，回到「重启并安装」那个确认框，由客户
 *   保存好手头的东西再点。这一步不在这里直接装：重启会关掉他正开着的窗口。
 */
export interface UpdateRetryActions {
  check: () => void
  redownload: () => void
  confirmInstall: () => void
}

export function retryFailedUpdateStep(step: UpdateFailedStep | null | undefined, actions: UpdateRetryActions): void {
  if (step === 'check') { actions.check(); return }
  if (step === 'install') { actions.confirmInstall(); return }
  actions.redownload()
}

interface UpdateRetryApi {
  checkForUpdates: () => Promise<UpdateSnapshot>
  downloadUpdate: () => Promise<UpdateSnapshot>
}

export async function redownloadUpdate(api: UpdateRetryApi): Promise<UpdateSnapshot> {
  const checked = await api.checkForUpdates()
  return checked.phase === 'available' ? api.downloadUpdate() : checked
}

/**
 * Mac 校验新版本签名没通过（主进程 updater.ts 的 updateSignatureRejectedCode，两边字面量
 * 要一致）：同一个包装多少遍都一样，「重新安装」是死路，更新页和首页气泡都改给「打开下载页」，
 * 让客户手动装一次。按错误代码判断而不看 failedStep，哪一步报上来的都一样处理。
 */
export function updateNeedsManualReinstall(update: Pick<UpdateSnapshot, 'error'> | null | undefined): boolean {
  return update?.error?.code === 'UPDATE_SIGNATURE_REJECTED'
}

/**
 * 开机那次检查超过时限只是放开了启动界面，真正的请求还在后台跑，算不上「失败」，
 * 气泡用提醒色，不用报错的红色。
 */
export function updateFailureTone(update: Pick<UpdateSnapshot, 'error'>): 'bad' | 'warn' {
  return update.error?.code === 'STARTUP_UPDATE_TIMEOUT' ? 'warn' : 'bad'
}

/**
 * 首页气泡上的「重新安装」要落到更新页的确认框里。页面切换只传页面名，更新页又可能
 * 早就挂着（隐藏而不卸载），所以这里既留一份待取的请求，也通知已经挂着的那一页。
 * 取走即清空：下一次从侧栏进更新页不会凭空弹框。
 */
let pendingInstallConfirm = false
const installConfirmListeners = new Set<() => void>()

export function requestUpdateInstallConfirm(): void {
  pendingInstallConfirm = true
  for (const listener of installConfirmListeners) listener()
}

export function takeUpdateInstallConfirm(): boolean {
  const pending = pendingInstallConfirm
  pendingInstallConfirm = false
  return pending
}

export function subscribeUpdateInstallConfirm(listener: () => void): () => void {
  installConfirmListeners.add(listener)
  if (pendingInstallConfirm) listener()
  return () => { installConfirmListeners.delete(listener) }
}
