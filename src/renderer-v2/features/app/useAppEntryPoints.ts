import { useEffect, type Dispatch, type SetStateAction } from 'react'
import type { AccountSessionState, AppSettingsV2, XingmangApi } from '../../../../electron/ipc-contract'
import type { PageId } from '../../registry/pages'
import { shortcutTools } from '../../registry/tools'
import { isToolId, type ToolboxSnapshot, type ToolId } from '../tools/model'
import { uiScaleShortcutFor, type UiScaleShortcut } from './ui-scale-shortcut'
import type { WindowOs } from './window-os'

interface AppEntryPointsOptions {
  native: XingmangApi
  navigate(page: PageId, section?: string): void
  session: AccountSessionState
  os: WindowOs
  settings: AppSettingsV2 | null
  snapshot: ToolboxSnapshot | null
  changeUiScale(shortcut: UiScaleShortcut): void
  requestLaunchInLastWorkspace(id: ToolId): Promise<void>
  setAnnouncementOpen: Dispatch<SetStateAction<boolean>>
}

/** 不经过界面按钮进来的那几条路：系统通知、托盘「已安装的工具」、快捷键。 */
export function useAppEntryPoints({ native, navigate, session, os, settings, snapshot, changeUiScale, requestLaunchInLastWorkspace, setAnnouncementOpen }: AppEntryPointsOptions) {
  useEffect(() => native.onNavigate((target) => {
    // 系统通知点进来：余额去「充值订阅」，异步任务去「用量账单」里那一节，花费突然变多去「用量账单」，公告直接打开公告。
    if (target === 'topup') navigate('account', 'recharge')
    else if (target === 'tasks') navigate('account', 'tasks')
    else if (target === 'usage') navigate('account', 'usage')
    else if (target === 'announcement') { if (session.authenticated) setAnnouncementOpen(true) }
    else navigate(target)
  }), [native, navigate, session, setAnnouncementOpen])
  // 托盘点的那一下和快捷键都按当时的检测结果和登录态打开，所以这两样一变就重新挂一次。
  useEffect(() => native.onLaunchTool((id) => { if (isToolId(id)) void requestLaunchInLastWorkspace(id) }), [native, snapshot, session.authenticated])
  useEffect(() => {
    function onShortcut(event: KeyboardEvent) {
      // 放大缩小对整个窗口都有效，弹窗开着也照样能调；Mac 上这里拦下后菜单里的「放大」就不会再动一遍。
      const zoom = uiScaleShortcutFor(event)
      if (zoom) {
        event.preventDefault()
        if (settings) changeUiScale(zoom)
        return
      }
      if (event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey) || document.querySelector('dialog[open]')) return
      if (event.key === ',') { event.preventDefault(); navigate('settings') }
      if (/^[1-9]$/.test(event.key)) {
        const tool = shortcutTools(os)[Number(event.key) - 1]
        if (tool && isToolId(tool.id)) { event.preventDefault(); void requestLaunchInLastWorkspace(tool.id) }
      }
    }
    document.addEventListener('keydown', onShortcut)
    return () => document.removeEventListener('keydown', onShortcut)
  }, [navigate, os, snapshot, session.authenticated, settings, changeUiScale])
}
