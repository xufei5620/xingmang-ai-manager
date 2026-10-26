import { useState, type Dispatch, type SetStateAction } from 'react'
import type { AppSettingsV2, UpdateSnapshot, XingmangApi } from '../../../../electron/ipc-contract'
import { updateBubbleRepeatsUpdatesPage, updateDiskShortfallText, type SettingsGroupId } from '../../registry/business'
import type { PageId } from '../../registry/pages'
import { useWindowSessionString } from '../../window-session'
import { maintenanceNoticeKey } from './MaintenanceNotice'
import { redownloadUpdate, requestUpdateInstallConfirm, retryFailedUpdateStep, updateFailureBubbleQuiet } from './update-retry'
import type { Perform } from './runtime-context'

interface UpdateBubbleOptions {
  native: XingmangApi
  update: UpdateSnapshot | null
  setUpdate: Dispatch<SetStateAction<UpdateSnapshot | null>>
  settings: AppSettingsV2 | null
  page: PageId
  settingsGroup: SettingsGroupId | null
  perform: Perform
  navigate(page: PageId): void
}

/** 右上角那个更新气泡（有新版本、下载中、没下完、空间不够）和角落的维护提示：什么时候出、关掉以后什么时候再出。 */
export function useUpdateBubble({ native, update, setUpdate, settings, page, settingsGroup, perform, navigate }: UpdateBubbleOptions) {
  // 关掉的气泡和维护提示记在窗口的 sessionStorage 里：缩到托盘关掉界面再叫出来，不再冒出来。
  const [dismissedUpdate, setDismissedUpdate] = useWindowSessionString('xingmang-v2-dismissed-update')
  const [updateRetrying, setUpdateRetrying] = useState(false)
  const [dismissedMaintenance, setDismissedMaintenance] = useWindowSessionString('xingmang-v2-dismissed-maintenance')
  // 空间不够是另一句话：之前关掉的「有新版本」不该连它一起盖住。
  const updateKey = update ? `${update.phase}:${update.availableVersion}:${update.error?.code ?? ''}${update.diskShortfall ? ':disk' : ''}` : ''
  // 维护提示来自更新目录上的状态文件，没登录也收得到。角落那条可以关，关掉的
  // 是这一句话；发布者换了说法（比如改了预计恢复时间）会再出现一次。
  const maintenance = update?.serviceMaintenance ?? null
  const launchInstall = update?.launchInstallNotice ?? null
  const maintenanceKey = maintenanceNoticeKey(maintenance)
  // 人就在设置 › 版本更新时，说的是卡上同一件事的那几种气泡不弹，离开那一组照旧。
  const showUpdate = Boolean(update && !updateFailureBubbleQuiet(update) && (update.error || update.currentVersionWithdrawn || ['available', 'downloading', 'downloaded'].includes(update.phase)) && dismissedUpdate !== updateKey
    && !(page === 'settings' && settingsGroup === 'about' && updateBubbleRepeatsUpdatesPage(update)))
  // 「自动更新」勾选跟着提示气泡走：用户第一次看到「有新版本」时就能看到它、改它。
  // 这台电脑的更新通道不支持自动更新时不显示，免得勾了没用。
  const autoUpdateToggle = Boolean(update?.autoUpdateSupported && settings && !update.error && !update.rollback)
  const autoUpdateOn = autoUpdateToggle && settings?.autoUpdate !== false
  const updateDiskText = updateDiskShortfallText(update, autoUpdateOn)
  // 气泡上的重试与版本更新卡的重试是同一套（update-retry.ts）：检查失败重新查，下载失败
  // 重新查再下，安装失败跳到版本更新卡的「重启并安装」确认框。
  const runUpdateRetry = (work: () => Promise<UpdateSnapshot>) => {
    setUpdateRetrying(true)
    void perform('重试更新', async () => setUpdate(await work())).finally(() => setUpdateRetrying(false))
  }
  const retryUpdate = () => retryFailedUpdateStep(update?.failedStep, {
    check: () => runUpdateRetry(() => native.checkForUpdates()),
    redownload: () => runUpdateRetry(() => redownloadUpdate(native)),
    confirmInstall: () => { navigate('updates'); requestUpdateInstallConfirm() },
  })
  return {
    showUpdate, dismissUpdate: () => setDismissedUpdate(updateKey), updateRetrying, retryUpdate, autoUpdateToggle, autoUpdateOn, updateDiskText,
    maintenance, launchInstall, maintenanceDismissed: maintenanceKey === dismissedMaintenance, dismissMaintenance: () => setDismissedMaintenance(maintenanceKey),
  }
}
