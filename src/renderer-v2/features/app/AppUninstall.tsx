import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { AppUninstallLeftover, AppUninstallResult } from '../../../../electron/ipc-contract'
import { ResultNotice, useOperation } from '../../business-common'
import type { V2Bridge } from '../../types'
import { settingsItemLabel } from '../../registry/business'
import { Button, Dialog, Input, SettingRow } from '../../ui'

export const appUninstallRowDescription = 'Mac 上删掉星芒之前先点这里：会收回星芒写进 Claude Code、Codex、Gemini CLI、Grok 里的提醒设置，再把星芒移到废纸篓。密钥和工具设置都留着，工具照样能用。'

/** Windows 和 Linux 那一行：工具到安装卸载页卸，星芒本身走系统自己的卸载，各说各的地方。 */
export function toolUninstallRowDescription(isLinux: boolean): string {
  return isLinux
    ? 'AI 工具到「安装卸载」页卸，配置默认留着。要卸载星芒本身，用系统的软件管理器'
    : 'AI 工具到「安装卸载」页卸，配置默认留着。要卸载星芒本身：打开 Windows「设置 → 应用」，找到「星芒AI管理工具」卸载'
}

const leftoverLabels: Record<AppUninstallLeftover, string> = {
  'cli-hooks': '有工具里的提醒设置没收回来',
  'login-item': '开机自动打开没关掉',
  tools: '星芒装的命令行工具没删干净',
  records: '登录记录和聊天记录没有清除',
}

/** 没移到废纸篓时界面要说的话；移走了就不用说，程序马上退出。 */
export function appUninstallNotice(result: AppUninstallResult): string {
  if (result.trashed) return ''
  const leftovers = result.leftovers.map((item) => leftoverLabels[item])
  return [
    '没能把星芒移到废纸篓。请退出星芒，在访达的「应用程序」里把它拖进废纸篓。',
    leftovers.length ? `另外，${leftovers.join('、')}。` : '提醒设置已经收回了。',
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
      title="卸载星芒AI管理工具"
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
            卸载并退出
          </Button>
        </>
      }
    >
      <p>先收回星芒写进各个工具里的提醒设置，再把星芒移到废纸篓并退出。密钥和工具设置都留着，卸了以后在终端里照样能用这些工具。</p>
      <Input
        type="checkbox"
        label="同时清除登录记录和聊天记录"
        hint="下次装回来要重新登录"
        checked={clearRecords}
        disabled={busy}
        testId="app-uninstall-clear-records"
        onChange={(event) => onClearRecords(event.target.checked)}
      />
      <Input
        type="checkbox"
        label="连同星芒替你装的命令行工具一起删"
        hint="你自己装的不会动；删了以后终端里就用不了星芒装的那几个工具"
        checked={removeTools}
        disabled={busy}
        testId="app-uninstall-remove-tools"
        onChange={(event) => onRemoveTools(event.target.checked)}
      />
      <ResultNotice error={error} detail={detail} message={message} />
    </Dialog>
  )
}

/**
 * 设置 → 更新与关于「卸载」那一行。Mac 没有卸载程序，拖进废纸篓以后工具里的提醒设置
 * 还指着已经不在的星芒，所以 Mac 上给一颗真正的「卸载星芒」；其它电脑照旧去工具的
 * 安装卸载页，卸星芒走系统自己的卸载。
 */
export function AppUninstallRow({
  api,
  isMac,
  isLinux = false,
  openMaintenance,
}: {
  api: Pick<V2Bridge, 'uninstallApp'>
  isMac: boolean
  /** Linux 上没有 Windows 的「设置 → 应用」，卸星芒本身那半句换成系统的软件管理器。 */
  isLinux?: boolean
  openMaintenance: () => void
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
        control={
          <Button size="sm" icon={Trash2} onClick={openMaintenance}>
            去安装卸载
          </Button>
        }
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
            卸载星芒
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
