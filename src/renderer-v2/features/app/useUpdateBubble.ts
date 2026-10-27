import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { AppSettingsV2, UpdateSnapshot, XingmangApi } from '../../../../electron/ipc-contract'
import { updateBubbleRepeatsUpdatesPage, updateDiskShortfallText, type SettingsGroupId } from '../../registry/business'
import type { PageId } from '../../registry/pages'
import { useWindowSessionString } from '../../window-session'
import { maintenanceNoticeKey } from './MaintenanceNotice'
import { redownloadUpdate, requestUpdateInstallConfirm, retryFailedUpdateStep, updateFailureBubbleQuiet } from './update-retry'
import { buildUpdateDismissal, parseUpdateDismissal, updateBubbleRepeatMs, updateDismissalRemainingMs } from './update-dismissal'
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

/** 右下角那个更新气泡（有新版本、下载中、没下完、空间不够）和角落的维护提示：什么时候出、关掉以后什么时候再出。 */
export function useUpdateBubble({ native, update, setUpdate, settings, page, settingsGroup, perform, navigate }: UpdateBubbleOptions) {
  // 关掉的气泡和维护提示记在窗口的 sessionStorage 里：缩到托盘关掉界面再叫出来，不再冒出来。
  // 更新气泡还记着什么时候关的，满一天再出一次（update-dismissal.ts）。
  const [dismissedUpdate, setDismissedUpdate] = useWindowSessionString('xingmang-v2-dismissed-update')
  const [updateRetrying, setUpdateRetrying] = useState(false)
  const [dismissedMaintenance, setDismissedMaintenance] = useWindowSessionString('xingmang-v2-dismissed-maintenance')
  // 满一天的那一刻界面可能正开着，没有别的事会让它重画：到点了自己拨一下。
  const [, setRepeatDue] = useState(0)
  // 空间不够是另一句话：之前关掉的「有新版本」不该连它一起盖住。
  const updateKey = update ? `${update.phase}:${update.availableVersion}:${update.error?.code ?? ''}${update.diskShortfall ? ':disk' : ''}` : ''
  const dismissal = parseUpdateDismissal(dismissedUpdate)
  const dismissedFor = updateDismissalRemainingMs(dismissal, updateKey, Date.now())
  const repeatAt = dismissal && dismissedFor > 0 ? dismissal.at + updateBubbleRepeatMs : 0
  useEffect(() => {
    if (!repeatAt) return
    const timer = setTimeout(() => setRepeatDue((current) => current + 1), Math.max(0, repeatAt - Date.now()))
    return () => clearTimeout(timer)
  }, [repeatAt])
  // 维护提示来自更新目录上的状态文件，没登录也收得到。角落那条可以关，关掉的
  // 是这一句话；发布者换了说法（比如改了预计恢复时间）会再出现一次。
  const maintenance = update?.serviceMaintenance ?? null
  const launchInstall = update?.launchInstallNotice ?? null
  const maintenanceKey = maintenanceNoticeKey(maintenance)
  // 人就在设置 › 版本更新时，说的是卡上同一件事的那几种气泡不弹，离开那一组照旧。
  const onUpdatesPage = page === 'settings' && settingsGroup === 'about'
  const showUpdate = Boolean(update && !updateFailureBubbleQuiet(update) && (update.error || update.currentVersionWithdrawn || ['available', 'downloading', 'downloaded'].includes(update.phase)) && dismissedFor === 0
    && !(onUpdatesPage && updateBubbleRepeatsUpdatesPage(update)))
  // 「自动更新」勾选跟着提示气泡走：用户第一次看到「有新版本」时就能看到它、改它。
  // 这台电脑的更新通道不支持自动更新时不显示，免得勾了没用。
  const autoUpdateToggle = Boolean(update?.autoUpdateSupported && settings && !update.error && !update.rollback)
  const autoUpdateOn = autoUpdateToggle && settings?.autoUpdate !== false
  const updateDiskText = updateDiskShortfallText(update, autoUpdateOn)
  // 气泡上直接给下一步要点的那颗按钮（「侧栏改」第 2 条）：下好了就「重启并安装」，没开自动下载就「下载更新」。
  // 人就在版本更新卡前时卡底已经有同一颗，气泡上不再摆第二颗。
  const offerInstall = Boolean(update && !update.error && update.phase === 'downloaded' && !onUpdatesPage)
  const offerDownload = Boolean(update && !update.error && update.phase === 'available' && !update.diskShortfall && !autoUpdateOn && !onUpdatesPage)
  // 气泡上的重试与版本更新卡的重试是同一套（update-retry.ts）：检查失败重新查，下载失败
  // 重新查再下，安装失败跳到版本更新卡的「重启并安装」确认框。
  const runUpdate = (label: string, work: () => Promise<UpdateSnapshot>) => {
    setUpdateRetrying(true)
    void perform(label, async () => setUpdate(await work())).finally(() => setUpdateRetrying(false))
  }
  // 侧栏的更新入口、状态栏的版本号、气泡上的「重启并安装」都落到版本更新卡那个确认框：保存工作、
  // Mac 钥匙串、Windows 授权窗口那几句都在框里，不在这里另开一条直接重启的路。
  const openInstallConfirm = () => { navigate('updates'); requestUpdateInstallConfirm() }
  const retryUpdate = () => retryFailedUpdateStep(update?.failedStep, {
    check: () => runUpdate('重试更新', () => native.checkForUpdates()),
    redownload: () => runUpdate('重试更新', () => redownloadUpdate(native)),
    confirmInstall: openInstallConfirm,
  })
  return {
    showUpdate, dismissUpdate: () => setDismissedUpdate(buildUpdateDismissal(updateKey, Date.now())), updateRetrying, retryUpdate, autoUpdateToggle, autoUpdateOn, updateDiskText,
    offerInstall, offerDownload, openInstallConfirm, downloadUpdate: () => runUpdate('下载更新', () => native.downloadUpdate()),
    maintenance, launchInstall, maintenanceDismissed: maintenanceKey === dismissedMaintenance, dismissMaintenance: () => setDismissedMaintenance(maintenanceKey),
  }
}
