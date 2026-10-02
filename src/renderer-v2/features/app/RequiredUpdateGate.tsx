import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { BookOpen, Download } from 'lucide-react'
import type { UpdateDownloadOptions, UpdateSnapshot } from '../../../../electron/ipc-contract'
import { userFacingErrorMessage } from '../../business-common'
import { updateDiskShortfallText } from '../../registry/business'
import { updateDiskCleanupSteps } from '../../registry/tutorials'
import { Button, Progress } from '../../ui'
import { requiredUpdateFollowUp, requiredUpdateGate, type RequiredUpdateAction } from './required-update'

export interface RequiredUpdateActions {
  check: () => Promise<unknown>
  download: (options?: UpdateDownloadOptions) => Promise<unknown>
  install: () => Promise<unknown> | unknown
  openDownloadPage: () => void
  contactSupport: () => void
}

/**
 * 状态文件定了最低版本、本机又低于它时盖在整个界面上的那层提示。
 *
 * 它故意关不掉：没有右上角的叉，Esc 和点空白处都不起作用，底下的界面被 showModal
 * 设成不可操作。能做的只有更新和找客服；自动更新走不通时再多一个「打开下载页」。
 * 「联系客服」打开的帮助框是后开的模态框，会叠在这层上面。
 *
 * 磁盘不够时更新器不下载、也不报错，这层就换成更新页那段「只剩多少、要多少、怎么清理」，
 * 主按钮改成「空间够了，再试一次」；更新页给了「仍要下载」，这里也给，说法相同。
 */
export function RequiredUpdateGate({ update, windows, actions }: {
  update: UpdateSnapshot | null
  windows: boolean
  actions: RequiredUpdateActions
}) {
  const [requested, setRequested] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [cleanupOpen, setCleanupOpen] = useState(false)
  // 「再试一次」在量盘：按钮转圈，量完还不够就多说一句，免得他以为没点上。
  const [measuring, setMeasuring] = useState(false)
  const [stillShort, setStillShort] = useState(false)
  const followed = useRef('')
  const gate = requiredUpdateGate(update, installing)

  // 用户点过「立即更新」后，找到了就接着下载、下载好就接着装，不用再点第二下。
  const followUp = requested ? requiredUpdateFollowUp(update) : null
  const followKey = followUp ? `${followUp}:${update?.availableVersion ?? ''}` : ''
  useEffect(() => {
    if (!followUp || followed.current === followKey) return
    followed.current = followKey
    void run(followUp)
  })

  const short = Boolean(gate?.diskShortfall)
  useEffect(() => {
    if (!short) setStillShort(false)
  }, [short])

  useEffect(() => {
    // 安装没能启动时更新器会回到「已下载」并带上错误，这时让按钮重新可点。
    if (installing && update?.error) setInstalling(false)
  }, [installing, update?.error])

  async function run(action: RequiredUpdateAction, options?: UpdateDownloadOptions) {
    const retryingShortfall = action === 'download' && short
    try {
      if (action === 'check') await actions.check()
      else if (action === 'download') {
        if (retryingShortfall) setMeasuring(true)
        await actions.download(options)
        if (retryingShortfall && !options?.ignoreDiskSpace) setStillShort(true)
      } else {
        setInstalling(true)
        await actions.install()
      }
    } catch {
      // 失败会体现在更新快照里（阶段与错误），这层提示照着快照换成「重试」。
      if (action === 'install') setInstalling(false)
    } finally {
      if (retryingShortfall) setMeasuring(false)
    }
  }

  function start(action: RequiredUpdateAction, options?: UpdateDownloadOptions) {
    setRequested(true)
    // 这一下已经做了的事，别让「接着做」再做一遍。
    followed.current = action === 'check' ? '' : `${action}:${update?.availableVersion ?? ''}`
    void run(action, options)
  }

  if (!gate) return null
  // 门里进不了更新页，也不等后台自己下：用「自动更新关着」那句，下一步由下面的按钮给。
  const shortfallText = gate.diskShortfall ? updateDiskShortfallText(update, false) : null
  const busy = !gate.action || measuring
  return <GateDialog>
    <header><Download size={20} aria-hidden="true" /><div><h2 id="required-update-title">这个版本需要更新后才能继续用</h2></div></header>
    <div className="xm-modal-content">
      <div className="xm-dialog-body">
        {update?.installMethod === 'system-installer'
          ? <p data-testid="required-update-system-installer">为了让工具和账号正常工作，请先更新到 {gate.minimumVersion} 或更新的版本。点「立即更新」，新版本下载好后星芒会先关掉，再打开这台电脑的安装窗口：在里面点「安装」，输入开机密码。装好后重新打开星芒就行，账号和设置都会保留。</p>
          : <p>为了让工具和账号正常工作，请先更新到 {gate.minimumVersion} 或更新的版本。点「立即更新」，新版本会自己下载并装好，中间会重启一次，账号和设置都会保留。</p>}
        {windows && <p>装的时候如果弹出「是否允许更改」，点「是」。</p>}
        <p data-testid="required-update-versions">现在是 {gate.currentVersion}{gate.availableVersion ? `，将更新到 ${gate.availableVersion}` : ''}</p>
        {gate.percent !== null && <Progress value={gate.percent} label="下载进度" testId="required-update-progress" />}
        {gate.progressDetail && <p className="v2-update-progress-detail" data-testid="required-update-progress-detail">{gate.progressDetail}</p>}
        {shortfallText && <div role="alert" data-testid="required-update-disk">
          <p><strong>磁盘空间不够，新版本还没开始下载。</strong>{shortfallText}</p>
          <p>先清出一些空间，再点「空间够了，再试一次」。</p>
          {stillShort && !measuring && <p data-testid="required-update-disk-still">刚才又量了一次，空间还是不够。</p>}
          {cleanupOpen && <p data-testid="required-update-disk-cleanup">{updateDiskCleanupSteps}</p>}
          <Button size="sm" icon={BookOpen} testId="required-update-disk-help" onClick={() => setCleanupOpen((open) => !open)}>{cleanupOpen ? '收起' : '怎么清理'}</Button>
        </div>}
        {gate.failure && <div role="alert" data-testid="required-update-failure">
          <p><strong>{gate.failureTitle}。</strong>{userFacingErrorMessage(gate.failure)}</p>
          <p>试了还是不行，点「打开下载页」下载适合这台电脑的安装包，装好后打开就行。</p>
        </div>}
      </div>
      <footer>
        <Button variant="ghost" testId="required-update-support" onClick={actions.contactSupport}>联系客服</Button>
        {gate.failure && <Button testId="required-update-download-page" onClick={actions.openDownloadPage}>打开下载页</Button>}
        {/* 空间是估算的：他清出了一点、或者就想试一次，由他决定，和更新页一样。 */}
        {gate.diskShortfall && <Button testId="required-update-download-anyway" disabled={busy} onClick={() => start('download', { ignoreDiskSpace: true })}>仍要下载</Button>}
        <Button variant="primary" testId="required-update-start" disabled={busy} loading={busy} onClick={() => { if (gate.action) start(gate.action) }}>{gate.label}</Button>
      </footer>
    </div>
  </GateDialog>
}

function GateDialog({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (!dialog.open) dialog.showModal()
    return () => { if (dialog.open) dialog.close() }
  }, [])
  return <dialog ref={ref} className="xm-modal xm-dialog xm-dialog-480" data-testid="required-update-gate" tabIndex={-1} aria-modal="true" aria-labelledby="required-update-title"
    onCancel={(event) => event.preventDefault()}>
    {children}
  </dialog>
}
