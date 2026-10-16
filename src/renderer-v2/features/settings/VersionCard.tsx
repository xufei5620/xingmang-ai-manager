import { useCallback, useEffect, useState } from 'react'
import { BookOpen, Download, ExternalLink, FileText, RefreshCw } from 'lucide-react'
import { Button, Dialog, Logo, Notice, Pill, Progress, useToast } from '../../ui'
import { ResultNotice, relativeTimeText, useOperation, useResource, userFacingErrorMessage } from '../../business-common'
import {
  standardAccountUpdateNotice,
  updateDiskShortfallText,
  updateDownloadDetail,
  updateFailureLabel,
  updateInstallActionLabel,
  updateInstallNote,
  updateNewVersion,
  updateStatusLabel,
  withdrawnVersionAdvice,
} from '../../registry/business'
import { updateDiskCleanupDetail } from '../../registry/tutorials'
import { releaseNotesSection } from '../app/release-notes'
import { redownloadUpdate, retryFailedUpdateStep, subscribeUpdateInstallConfirm, takeUpdateInstallConfirm, updateNeedsManualReinstall, updateOffersDownloadPage } from '../app/update-retry'
import { appReleaseDownloadUrl } from '../../../../electron/app-download-page'
import type { V2Bridge, V2Page } from '../../types'

// 为什么 Mac 每换一版都会问一次钥匙串密码，见 registry/tutorials.ts 的
// macKeychainTutorialDetail。重启前说一句，客户就不会慌着点「拒绝」。
// 安装包装在「所有用户」的程序目录下，Windows 会弹一次授权窗口；点了「否」就装不上。
export const windowsConsentUpdateHint = 'Windows 会弹出一个授权窗口问要不要允许更改，点「是」就好；点了「否」这次就装不上。'
// 账号不在管理员组时那个窗口要的是管理员密码，只点「是」过不去。
export const windowsAdminPasswordUpdateHint = 'Windows 会弹出一个授权窗口，要在里面输入管理员密码；点了「否」这次就装不上。'
// Linux 上星芒不提权，装这一步交给系统的安装窗口；它要开机密码，装完也不会替他重开星芒。
export const systemInstallerUpdateHint = '星芒会先关掉，再打开这台电脑的安装窗口：在里面点「安装」，输入开机密码。装好后从应用菜单重新打开星芒。'
export const macKeychainUpdateHint = '重启后 Mac 可能弹出钥匙串密码框，输入这台 Mac 的开机密码，点「始终允许」就好。'

/**
 * 设置 › 版本更新最上面那张版本卡（v4 批09，原来是单独的更新页）：当前版本、状态小标签、更新内容、
 * 下载进度和那颗主按钮；撤回、要管理员密码、磁盘不够、失败、没法自动更新这几种提示照旧摆在卡里。
 * 「启动时检查新版本」「自动下载更新」两个开关在卡下面的设置行里，不在卡上再摆一份。
 */
export function VersionCard({ api, navigate, autoUpdate }: {
  api: V2Bridge
  /** 失败提示里的「查看日志」。 */
  navigate?: (page: V2Page, section?: string) => void
  /** 「自动下载更新」开着没有：磁盘不够那句按它说接下来会怎样。 */
  autoUpdate: boolean
}) {
  const load = useCallback(() => api.getUpdateState(), [api])
  const resource = useResource(load)
  const operation = useOperation()
  const showToast = useToast().show
  const [confirm, setConfirm] = useState(false)
  const [isMac, setIsMac] = useState(false)
  const [isWindows, setIsWindows] = useState(false)
  // 星芒这次本身就带着管理员权限在跑（自带 Administrator 之类）：装更新不弹授权窗口，确认框不说会弹（已知19）。
  const [processElevated, setProcessElevated] = useState(false)
  const [diskCleanupOpen, setDiskCleanupOpen] = useState(false)
  useEffect(() => api.onUpdateState(resource.setData), [api, resource.setData])
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
  const update = resource.data
  const autoUpdateOn = Boolean(update?.autoUpdateSupported && autoUpdate)
  // Linux 的 .deb：装这一步交给系统安装程序，软件只关掉、不会自己重开（updater.ts 的 UpdateInstallMethod）。
  const systemInstaller = update?.installMethod === 'system-installer'
  function check() {
    void operation.execute(
      'check',
      async () => {
        const next = await api.checkForUpdates()
        resource.setData(next)
        return next
      },
      // 查完没有新版本时说一句，按钮旁边那句「刚刚检查过」不够显眼。
      (next) => next.phase === 'not-available' && !next.currentVersionWithdrawn && next.currentVersion ? `已经是最新版本 v${next.currentVersion}` : '',
    )
  }
  function download() {
    void operation.execute('download', async () => resource.setData(await api.downloadUpdate()), '')
  }
  // 空间不够时不拦死：估算是估的，他清出了一点、或者就想试一次，由他决定。
  function downloadAnyway() {
    void operation.execute('download', async () => resource.setData(await api.downloadUpdate({ ignoreDiskSpace: true })), '')
  }
  const diskShortfallText = updateDiskShortfallText(update, autoUpdateOn)
  function redownload() {
    void operation.execute('download', async () => resource.setData(await redownloadUpdate(api)), '')
  }
  // 失败在哪一步，重试就从哪一步接着走；首页气泡走的是同一套（update-retry.ts）。
  const failure = updateFailureLabel(update?.failedStep)
  const releaseNotes = releaseNotesSection(update)
  const retryFailedStep = () => retryFailedUpdateStep(update?.failedStep, { check, redownload, confirmInstall: () => setConfirm(true) })
  const manualReinstall = updateNeedsManualReinstall(update)
  const offerDownloadPage = updateOffersDownloadPage(update)
  const openDownloadPage = () => void operation.execute('download-page', async () => { await api.openExternal(appReleaseDownloadUrl) }, '')
  // 首页气泡上点了「重新安装」：跳过来直接弹确认框。设置页已经开在「版本更新」时，跳过来会把整页
  // 重新挂一次（settings-group-intent），旧卡的监听先被叫到；所以监听只记一笔，等这张卡真挂上了再取走，
  // 要不然请求被马上要拆掉的旧卡拿走，新卡就不弹了。
  const [confirmRequest, setConfirmRequest] = useState(0)
  useEffect(() => subscribeUpdateInstallConfirm(() => setConfirmRequest((current) => current + 1)), [])
  useEffect(() => {
    if (confirmRequest && takeUpdateInstallConfirm()) setConfirm(true)
  }, [confirmRequest])
  // 下好了说一句「下载完成，重启后生效」。只说正在这张卡前看着下的那一次，打开设置时已经下好的不说；
  // Linux 要点「安装新版本」、要管理员密码的 Windows 也不会重启后生效，这两种不说。
  const [downloadSeen, setDownloadSeen] = useState(false)
  useEffect(() => {
    if (update?.phase === 'downloading') setDownloadSeen(true)
    else if (update?.phase === 'downloaded' && downloadSeen) {
      setDownloadSeen(false)
      if (!systemInstaller && !update.installNeedsAdminPassword) showToast('下载完成，重启后生效', 'ok')
    } else if (update?.phase !== undefined) setDownloadSeen(false)
  }, [update?.phase, update?.installNeedsAdminPassword, systemInstaller, downloadSeen, showToast])
  const downloading = update?.phase === 'downloading'
  // 「刚刚检查过」「今天 14:20 检查过」：钟点和后面的字隔一个空格。
  const checkedAt = update?.checkedAt ? relativeTimeText(update.checkedAt, Date.now()) : ''
  const checkedText = checkedAt ? `${checkedAt}${/\d$/.test(checkedAt) ? ' ' : ''}检查过` : ''
  const statusTone = update?.phase === 'available' || update?.phase === 'downloading' ? 'accent' : update?.phase === 'downloaded' || update?.phase === 'not-available' ? (update.currentVersionWithdrawn ? 'warn' : 'ok') : update?.error ? 'warn' : 'neutral'
  const newVersion = updateNewVersion(update)
  const action =
    update?.phase === 'available' || update?.phase === 'cancelled' ? (
      <Button variant="primary" icon={Download} loading={operation.busy === 'download'} onClick={download}>
        下载更新
      </Button>
    ) : downloading ? (
      <Button variant="primary" loading>正在下载</Button>
    ) : update?.phase === 'downloaded' ? (
      // 验签没通过时「重启并安装」和失败卡里去掉的「重新安装」是同一条死路，下一步只在失败卡的「打开下载页」。
      manualReinstall ? null : (
        <Button variant="primary" icon={RefreshCw} onClick={() => setConfirm(true)}>
          {updateInstallActionLabel(update.installMethod)}
        </Button>
      )
    ) : (
      <Button
        variant="secondary"
        icon={RefreshCw}
        loading={update?.phase === 'checking' || operation.busy === 'check'}
        disabled={update?.phase === 'disabled'}
        onClick={check}
      >
        {update?.phase === 'error' ? '重新检查' : '检查更新'}
      </Button>
    )
  return (
    <section className="v2-version-card" data-testid="page-updates" aria-labelledby="v2-version-card-title">
      <div className="v2-version-card-head">
        <span className="v2-version-card-logo" aria-hidden="true"><Logo kind="micro" height={40} /></span>
        <div>
          <h2 id="v2-version-card-title">星芒AI管理工具</h2>
          <p data-testid="updates-current-version">{update?.currentVersion ? `当前版本 v${update.currentVersion}` : resource.error ? '版本暂未读到' : '正在读取更新状态…'}</p>
        </div>
        {update && (
          <span data-testid={newVersion && update.phase === 'available' ? 'updates-new-version' : undefined}>
            <Pill tone={statusTone}>{updateStatusLabel(update)}</Pill>
          </span>
        )}
      </div>
      <ResultNotice
        error={resource.error || operation.error}
        detail={resource.error ? resource.detail : operation.detail}
        message={operation.message}
      />
      <div className="v2-version-card-notes">
        <h3>{releaseNotes.title}</h3>
        {releaseNotes.items ? (
          <ul className="v2-business-release-notes-list" data-testid="updates-installed-notes">
            {releaseNotes.items.map((item, index) => <li key={index}>{item}</li>)}
          </ul>
        ) : (
          <p>{releaseNotes.text}</p>
        )}
      </div>
      {update?.progress && (
        <div className="v2-version-card-progress">
          <Progress value={update.progress.percent} label={`${update.progress.percent.toFixed(0)}%`} />
          <p data-testid="updates-progress-detail">{updateDownloadDetail(update.progress)}</p>
        </div>
      )}
      {update?.currentVersionWithdrawn && (
        <Notice tone="warn" title="这个版本有已知问题" body={withdrawnVersionAdvice(update)} testId="updates-current-withdrawn" />
      )}
      {/* 账号不是管理员的 Windows 电脑：下好的新版本不自动装，就在「重启并安装」旁边说清要谁来点。 */}
      {update?.phase === 'downloaded' && update.installNeedsAdminPassword && (
        <Notice tone="warn" title={standardAccountUpdateNotice.title} body={standardAccountUpdateNotice.body} testId="updates-admin-password" />
      )}
      {update?.unsignedChannel && !update.autoUpdateSupported && (
        <p className="v2-version-card-line" data-testid="updates-channel-unsigned"><span>更新方式</span>每次下载和安装新版本前都会先问你</p>
      )}
      {diskShortfallText && (
        <Notice
          tone="warn"
          title="磁盘空间不够，新版本先不下载"
          body={<><p>{diskShortfallText}</p>{diskCleanupOpen && <p data-testid="updates-disk-cleanup">{updateDiskCleanupDetail}</p>}</>}
          testId="updates-disk-shortfall"
          actions={
            <>
              <Button size="sm" icon={BookOpen} onClick={() => setDiskCleanupOpen((open) => !open)}>{diskCleanupOpen ? '收起' : '怎么清理'}</Button>
              <Button size="sm" icon={Download} loading={operation.busy === 'download'} onClick={downloadAnyway}>仍要下载</Button>
            </>
          }
        />
      )}
      {update?.error && (
        <Notice
          tone="warn"
          title={failure.title}
          body={userFacingErrorMessage(update.error)}
          testId={`updates-failure-${update.failedStep ?? 'unknown'}`}
          actions={
            <>
              {!manualReinstall && (
                <Button size="sm" icon={!update.failedStep || update.failedStep === 'download' ? Download : RefreshCw} onClick={retryFailedStep}>
                  {failure.retry}
                </Button>
              )}
              {offerDownloadPage && <Button size="sm" icon={ExternalLink} onClick={openDownloadPage}>打开下载页</Button>}
              <Button size="sm" icon={FileText} onClick={() => navigate?.('feedback')}>查看日志</Button>
            </>
          }
        />
      )}
      {update?.installMethod === 'manual' && (
        <Notice
          tone="warn"
          title="这台电脑上没法自动更新"
          body="星芒在这台电脑上不是用安装包装的，没法自己更新。到下载页下载新版本的安装包，装好后打开就行。"
          testId="updates-manual-install"
          actions={<Button size="sm" icon={ExternalLink} onClick={openDownloadPage}>打开下载页</Button>}
        />
      )}
      {update?.development && <p className="v2-version-card-line">当前是开发运行环境。</p>}
      <div className="v2-version-card-foot">
        {checkedText && <span>{checkedText}</span>}
        {action}
      </div>
      <Dialog
        open={confirm}
        title={systemInstaller ? '安装新版本？' : '重启并安装更新？'}
        onClose={() => setConfirm(false)}
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>稍后安装</Button>
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
                    setConfirm(false)
                    return result
                  },
                  // 还有工具在装、客户在问的那一句里点了「继续安装」：这次不装，回到原来的样子（已知31）。
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
          : <p>请先保存当前工作。安装完成后重新打开工具箱。</p>}
        <p data-testid="updates-install-note">{updateInstallNote}</p>
        {isMac && <p data-testid="updates-mac-keychain-hint">{macKeychainUpdateHint}</p>}
        {isWindows && !processElevated && <p data-testid="updates-windows-consent-hint">{update?.installNeedsAdminPassword ? windowsAdminPasswordUpdateHint : windowsConsentUpdateHint}</p>}
        <ResultNotice error={operation.error} detail={operation.detail} />
      </Dialog>
    </section>
  )
}
