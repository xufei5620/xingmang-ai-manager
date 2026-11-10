import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { UpdateSnapshot } from '../../../../electron/ipc-contract'
import { Button, Dialog } from '../../ui'
import { ResultNotice, useOperation } from '../../business-common'
import { updateInstallNote } from '../../registry/business'
import { macKeychainUpdateHint } from '../../../../electron/mac-keychain-update-copy'
import type { V2Bridge } from '../../types'

// 为什么 Mac 每换一版都会问一次钥匙串密码，见 registry/tutorials.ts 的
// macKeychainTutorialDetail。重启前说一句，客户就不会慌着点「拒绝」；那句和跳框、必须更新那层、
// 自动装的通知共用一份（electron/mac-keychain-update-copy.ts）。
// 安装包装在「所有用户」的程序目录下，Windows 会弹一次授权窗口；点了「否」就装不上。
export const windowsConsentUpdateHint = 'Windows 会弹出一个授权窗口问要不要允许更改，点「是」就好；点了「否」这次就装不上。'
// 账号不在管理员组时那个窗口要的是管理员密码，只点「是」过不去。
export const windowsAdminPasswordUpdateHint = 'Windows 会弹出一个授权窗口，要在里面输入管理员密码；点了「否」这次就装不上。'
// Linux 上星芒不提权，装这一步交给系统的安装窗口；它要开机密码，装完也不会替他重开星芒。
export const systemInstallerUpdateHint = '星芒会先关掉，再打开这台电脑的安装窗口：在里面点「安装」，输入开机密码。装好后从应用菜单重新打开星芒。'

type Operation = ReturnType<typeof useOperation>

interface UpdateInstallDialogProps {
  api: Pick<V2Bridge, 'installUpdate' | 'getPlatformCapabilities'>
  update: Pick<UpdateSnapshot, 'installMethod' | 'installNeedsAdminPassword'> | null | undefined
  open: boolean
  onClose(): void
}

/**
 * 「重启并安装更新？」确认框。版本卡底下那颗按钮用它，右下角气泡、状态栏版本号、侧栏「重启并安装新版」
 * 也直接在原地弹它：原来这几处要先跳到「设置 › 版本更新」再弹，那一页更新说明又长，客户嫌绕
 * （yoyo 2026-11-10）。框里的字和原来一字不差，装的还是同一条 installUpdate。
 */
export function UpdateInstallDialog({ api, update, open, onClose, operation }: UpdateInstallDialogProps & { operation: Operation }) {
  const [isMac, setIsMac] = useState(false)
  const [isWindows, setIsWindows] = useState(false)
  // 星芒这次本身就带着管理员权限在跑（自带 Administrator 之类）：装更新不弹授权窗口，确认框不说会弹（已知19）。
  const [processElevated, setProcessElevated] = useState(false)
  useEffect(() => {
    let current = true
    // 读不到平台就不提示：多说一句对 Windows 客户是噪音，少说一句只是回到原来的样子。
    void api.getPlatformCapabilities()
      .then((capability) => {
        if (!current) return
        setIsMac(capability.platform === 'macos')
        setIsWindows(capability.platform === 'windows')
        setProcessElevated(capability.processElevated === true)
      })
      .catch(() => undefined)
    return () => { current = false }
  }, [api])
  // Linux 的 .deb：装这一步交给系统安装程序，软件只关掉、不会自己重开（updater.ts 的 UpdateInstallMethod）。
  const systemInstaller = update?.installMethod === 'system-installer'
  return (
    <Dialog
      open={open}
      title={systemInstaller ? '安装新版本？' : '重启并安装更新？'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>稍后安装</Button>
          <Button
            variant="primary"
            icon={RefreshCw}
            loading={operation.busy === 'install'}
            onClick={() =>
              void operation.execute(
                'install',
                async () => {
                  // 有工具在装或排着队时主进程先问一句再重启（已知31）。
                  const result = await api.installUpdate({ askIfInstalling: true })
                  onClose()
                  return result
                },
                // 还有工具在装、或者聊天视频剪辑画布还在做，客户在问的那一句里点了「继续安装」「等它做完」：这次不装，回到原来的样子（已知31、D10）。
                (result) => (result.postponed ? null : '安装请求已提交'),
              )
            }
          >
            {systemInstaller ? '关掉并安装' : operation.busy === 'install' ? '正在重启' : '重启并安装'}
          </Button>
        </>
      }
    >
      {systemInstaller
        ? <p data-testid="updates-system-installer-hint">请先保存当前工作。{systemInstallerUpdateHint}</p>
        : <p>请先保存当前工作。星芒会先关掉，装好自动重新打开。</p>}
      <p data-testid="updates-install-note">{updateInstallNote}</p>
      {isMac && <p data-testid="updates-mac-keychain-hint">{macKeychainUpdateHint}</p>}
      {isWindows && !processElevated && <p data-testid="updates-windows-consent-hint">{update?.installNeedsAdminPassword ? windowsAdminPasswordUpdateHint : windowsConsentUpdateHint}</p>}
      <ResultNotice error={operation.error} detail={operation.detail} />
    </Dialog>
  )
}

/** 不在版本卡前时（气泡、状态栏、侧栏）弹的那一个：自带一份操作状态，装不上的原因写在框里。 */
export function UpdateInstallConfirm(props: UpdateInstallDialogProps) {
  const operation = useOperation()
  return <UpdateInstallDialog {...props} operation={operation} />
}
