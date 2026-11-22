import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { AppUninstallLeftover, AppUninstallResult } from '../../../../electron/ipc-contract'
import { ResultNotice, useOperation } from '../../business-common'
import type { V2Bridge } from '../../types'
import { settingsItemLabel } from '../../registry/business'
import { Button, Dialog, Input, Notice, SettingRow } from '../../ui'

export const appUninstallRowDescription = '默认保留工具及其配置'

/**
 * Windows 和 Linux 那一行：软件里卸不了星芒，只说去哪儿卸（v4 字表批09）；工具的卸载在首页卡片的「…」里，
 * 这一行不再管。
 */
export function toolUninstallRowDescription(isLinux: boolean): string {
  return isLinux
    ? '请使用系统软件管理器卸载星芒，工具及其配置将保留'
    : '请打开 Windows「设置 → 应用」，找到「星芒AI管理工具」并卸载，工具及其配置将保留'
}

/**
 * 勾了「同时删除星芒安装的命令行工具」之后那条提醒。删之前确实会先备份配置（macos-uninstall.ts 的 backupCliConfigs）。
 * Grok 单说：Mac 上它在 ~/.grok（macos-grok.ts），客户自己用官方脚本装的也在那儿、分不出是谁装的，
 * removeMacManagedTools 只删星芒自己的目录，所以这里不删它，指去首页卡片上的卸载（0.2.24 深查 Mac M2，决定单 D8 选 a）。
 */
export const appUninstallRemoveToolsWarning = '将删除由星芒安装的 Claude Code、Codex CLI，自行安装的不受影响。Grok CLI 位于个人文件夹，此处不删除；如需删除，请先在首页 Grok 卡片上点击「卸载工具」。删除前将自动备份配置。'

const leftoverLabels: Record<AppUninstallLeftover, string> = {
  'cli-hooks': '部分工具的通知设置未能移除',
  'login-item': '开机自启动未能关闭',
  tools: '星芒安装的命令行工具未完全删除',
  records: '登录记录和聊天记录未清除',
}

/** 没移到废纸篓时界面要说的话；移走了就不用说，程序马上退出。 */
export function appUninstallNotice(result: AppUninstallResult): string {
  if (result.trashed) return ''
  const leftovers = result.leftovers.map((item) => leftoverLabels[item])
  return [
    '无法将星芒移至废纸篓。请退出星芒，在访达「应用程序」中将其拖入废纸篓。',
    leftovers.length ? `另外，${leftovers.join('、')}。` : '通知设置已移除。',
  ].join('')
}

export function AppUninstallDialog({
  open,
  clearRecords,
  removeTools,
  busy,
  error,
  detail,
  message,
  onClearRecords,
  onRemoveTools,
  onConfirm,
  onClose,
}: {
  open: boolean
  clearRecords: boolean
  removeTools: boolean
  busy: boolean
  error: string
  /** 被兜底句换掉的原话，只拿来认类别（同 ResultNotice 的 detail）。 */
  detail?: string
  message: string
  onClearRecords: (checked: boolean) => void
  onRemoveTools: (checked: boolean) => void
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Dialog
      open={open}
      title="卸载星芒"
      onClose={onClose}
      busy={busy}
      testId="app-uninstall-dialog"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>取消</Button>
          <Button
            variant="danger"
            icon={Trash2}
            loading={busy}
            onClick={onConfirm}
            testId="app-uninstall-confirm"
          >
            卸载星芒
          </Button>
        </>
      }
    >
      <p>将先移除星芒写入各工具的通知设置，再删除星芒。工具配置及 Claude Code、Codex 等工具均保留，可继续使用。卸载完成后星芒将退出。</p>
      <Input
        type="checkbox"
        label="同时清除登录记录和聊天记录"
        hint="重新安装后需重新登录"
        checked={clearRecords}
        disabled={busy}
        testId="app-uninstall-clear-records"
        onChange={(event) => onClearRecords(event.target.checked)}
      />
      <Input
        type="checkbox"
        label="同时删除星芒安装的命令行工具"
        checked={removeTools}
        disabled={busy}
        testId="app-uninstall-remove-tools"
        onChange={(event) => onRemoveTools(event.target.checked)}
      />
      {removeTools && <Notice tone="warn" title={appUninstallRemoveToolsWarning} body={null} testId="app-uninstall-remove-tools-warning" />}
      <ResultNotice error={error} detail={detail} message={message} />
    </Dialog>
  )
}

/**
 * 设置 → 版本更新「卸载星芒」那一行。Mac 没有卸载程序，拖进废纸篓以后工具里的提醒设置
 * 还指着已经不在的星芒，所以 Mac 上给一颗真正的「卸载」；其它电脑没有按钮，只说卸星芒走
 * 系统自己的卸载（工具的卸载在首页卡片的「…」里）。
 */
export function AppUninstallRow({
  api,
  isMac,
  isLinux = false,
}: {
  api: Pick<V2Bridge, 'uninstallApp'>
  isMac: boolean
  /** Linux 上没有 Windows 的「设置 → 应用」，那句换成系统的软件管理器。 */
  isLinux?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [clearRecords, setClearRecords] = useState(false)
  const [removeTools, setRemoveTools] = useState(false)
  const operation = useOperation()
  if (!isMac) {
    return (
      <SettingRow
        title={settingsItemLabel('uninstall')}
        anchor="uninstall"
        description={toolUninstallRowDescription(isLinux)}
        control={null}
      />
    )
  }
  function close() {
    if (operation.busy) return
    setOpen(false)
    setClearRecords(false)
    setRemoveTools(false)
    operation.clear()
  }
  return (
    <>
      <SettingRow
        title={settingsItemLabel('uninstall-app')}
        anchor="uninstall-app"
        description={appUninstallRowDescription}
        testId="settings-app-uninstall"
        control={
          <Button size="sm" icon={Trash2} onClick={() => setOpen(true)} testId="settings-app-uninstall-open">
            卸载
          </Button>
        }
      />
      <AppUninstallDialog
        open={open}
        clearRecords={clearRecords}
        removeTools={removeTools}
        busy={operation.busy === 'uninstall-app'}
        error={operation.error}
        detail={operation.detail}
        message={operation.message}
        onClearRecords={setClearRecords}
        onRemoveTools={setRemoveTools}
        onClose={close}
        onConfirm={() =>
          void operation.execute(
            'uninstall-app',
            () => api.uninstallApp({ clearLoginRecords: clearRecords, removeManagedTools: removeTools }),
            appUninstallNotice,
          )
        }
      />
    </>
  )
}
