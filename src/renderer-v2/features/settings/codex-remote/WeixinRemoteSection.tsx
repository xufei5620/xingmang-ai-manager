import { useState, type FormEvent } from 'react'
import { Button, Dialog, Input, Notice, SettingRow } from '../../../ui'
import { errorMessage } from '../../../business-common'
import { useLatestRequest } from '../../../latest-request'
import type { WeixinLoginPhase, WeixinLoginSnapshot } from '../../../../../electron/codex-remote-weixin-login-state'
import type { RemoteChannelSectionProps } from './channel-sections'

// 「设置 › 手机遥控 Codex」里微信那一块：只管扫码登录。开关、配对码、绑定的人、退出登录是卡片
// 公共部分（CodexRemoteCard.tsx）。二维码图由主进程画好给过来，这里不碰登录链接，也拿不到令牌。

export const weixinRemoteText = {
  warningTitle: '实验功能，随时可能断',
  warningBody: '这条通道是腾讯给 OpenClaw 开的，星芒借来用。腾讯随时可能限流或关掉它，断了我们也修不了。长期用建议选飞书。',
  rowTitle: '微信扫码登录',
  description: '在手机微信的 ClawBot 对话里遥控这台电脑上的 Codex。',
  loggedIn: (label: string) => `已登录：${label}`,
  login: '扫码登录',
  relogin: '重新扫码',
  dialogTitle: '用手机微信扫码',
  qrAlt: '微信登录二维码',
  scanHint: '打开手机微信「扫一扫」，扫完在手机上点确认。二维码 5 分钟内有效。',
  scanned: '已扫码，请在手机上点确认',
  needCode: '手机微信上显示了一串数字，请输在下面',
  codePlaceholder: '手机上的数字',
  confirmCode: '确认',
  wrongCode: '数字不对，请对照手机上的数字重新输入',
  confirmed: '微信登录好了。下一步点「开始配对」，在微信的 ClawBot 对话里发配对码。',
  cancel: '取消',
  retry: '重新扫码',
  close: '关闭',
} as const

/** 新一轮结果没带二维码时沿用上一张：只有换了新二维码，主进程才把图再给一次。 */
export function mergeWeixinLoginView(previous: WeixinLoginSnapshot | null, next: WeixinLoginSnapshot): WeixinLoginSnapshot {
  if (!previous || previous.loginId !== next.loginId) return next
  return { ...next, qrImage: next.qrImage ?? previous.qrImage, expiresAt: next.expiresAt ?? previous.expiresAt }
}

/** 等手机那边的两种状态接着轮询；要客户输数字的两种停下来等他输。 */
export function weixinLoginKeepsPolling(phase: WeixinLoginPhase): boolean {
  return phase === 'waiting-scan' || phase === 'scanned'
}

export function weixinLoginFinished(phase: WeixinLoginPhase): boolean {
  return phase === 'confirmed' || phase === 'failed' || phase === 'cancelled'
}

export function weixinLoginHeadline(phase: WeixinLoginPhase): string | null {
  switch (phase) {
    case 'waiting-scan':
      return weixinRemoteText.scanHint
    case 'scanned':
      return weixinRemoteText.scanned
    case 'need-verify-code':
      return weixinRemoteText.needCode
    case 'verify-code-wrong':
      return weixinRemoteText.wrongCode
    case 'confirmed':
      return weixinRemoteText.confirmed
    case 'failed':
    case 'cancelled':
      return null
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

export function WeixinLoginDialogBody({ view, code, onCodeChange, onSubmitCode, busy }: {
  view: WeixinLoginSnapshot
  code: string
  onCodeChange(value: string): void
  onSubmitCode(): void
  busy: boolean
}) {
  const headline = weixinLoginHeadline(view.phase)
  const askingForCode = view.phase === 'need-verify-code' || view.phase === 'verify-code-wrong'
  const showQr = view.qrImage && (view.phase === 'waiting-scan' || view.phase === 'scanned')
  function submit(event: FormEvent) {
    event.preventDefault()
    onSubmitCode()
  }
  return <div className="v2-remote-weixin-login" data-testid="settings-remote-weixin-login" data-phase={view.phase}>
    {showQr ? <img className="v2-remote-weixin-qr" src={view.qrImage} alt={weixinRemoteText.qrAlt} width={240} height={240} data-testid="settings-remote-weixin-qr" /> : null}
    {headline ? <p>{headline}</p> : null}
    {view.message ? <p className={view.phase === 'failed' ? 'v2-remote-weixin-error' : undefined} role={view.phase === 'failed' ? 'alert' : 'status'}>{view.message}</p> : null}
    {askingForCode ? <form onSubmit={submit} className="v2-remote-weixin-code">
      <Input
        value={code}
        onChange={(event) => onCodeChange(event.target.value)}
        placeholder={weixinRemoteText.codePlaceholder}
        aria-label={weixinRemoteText.codePlaceholder}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={8}
        disabled={busy}
        testId="settings-remote-weixin-code"
      />
      <Button type="submit" variant="primary" disabled={busy || !code.trim()} testId="settings-remote-weixin-code-submit">{weixinRemoteText.confirmCode}</Button>
    </form> : null}
  </div>
}

/**
 * 拿二维码交给卡片的 run（和卡上别的按钮共用一把锁、一条红条）；之后弹窗里的轮询和输数字自己管，
 * 不占着那把锁：扫码要等手机，最长 8 分钟。登录好了主进程推 state-changed，卡片自己变成「已登录」。
 */
export function WeixinRemoteSection({ snapshot, api, disabled, busy, run }: RemoteChannelSectionProps) {
  const latest = useLatestRequest()
  const [view, setView] = useState<WeixinLoginSnapshot | null>(null)
  const [code, setCode] = useState('')

  async function pollUntilSettled(loginId: string, current: () => boolean, verifyCode?: string) {
    let pendingCode = verifyCode
    while (current()) {
      let next: WeixinLoginSnapshot
      try {
        next = await api.pollWeixinRemoteLogin(pendingCode ? { loginId, verifyCode: pendingCode } : { loginId })
      } catch (error) {
        if (!current()) return
        setView((previous) => previous ? { ...previous, phase: 'failed', message: errorMessage(error) } : previous)
        return
      }
      pendingCode = undefined
      if (!current()) return
      setView((previous) => mergeWeixinLoginView(previous, next))
      if (!weixinLoginKeepsPolling(next.phase)) return
      if (next.retryAfterMs > 0) await wait(next.retryAfterMs)
    }
  }

  async function start() {
    const current = latest.begin()
    setCode('')
    await run('weixin-login', async () => {
      const first = await api.startWeixinRemoteLogin()
      if (!current()) return
      setView(first)
      if (weixinLoginKeepsPolling(first.phase)) void pollUntilSettled(first.loginId, current)
    })
  }

  function submitCode() {
    if (!view || !code.trim()) return
    const current = latest.begin()
    const verifyCode = code.trim()
    setCode('')
    void pollUntilSettled(view.loginId, current, verifyCode)
  }

  function close() {
    latest.invalidate()
    if (view && !weixinLoginFinished(view.phase)) {
      void api.cancelWeixinRemoteLogin(view.loginId).catch(() => undefined)
    }
    setView(null)
    setCode('')
  }

  const starting = busy === 'weixin-login'
  const label = snapshot.hasCredential && snapshot.accountLabel ? snapshot.accountLabel : null
  const finished = view ? weixinLoginFinished(view.phase) : false
  const footer = view ? finished
    ? <>
      {view.phase === 'failed' ? <Button variant="primary" onClick={() => void start()} loading={starting} disabled={disabled} testId="settings-remote-weixin-retry">{weixinRemoteText.retry}</Button> : null}
      <Button onClick={close} testId="settings-remote-weixin-close">{weixinRemoteText.close}</Button>
    </>
    : <Button onClick={close} testId="settings-remote-weixin-cancel">{weixinRemoteText.cancel}</Button>
    : null

  return <>
    <div className="v2-remote-weixin-notice">
      <Notice tone="warn" title={weixinRemoteText.warningTitle} body={weixinRemoteText.warningBody} testId="settings-remote-weixin-warning" />
    </div>
    <SettingRow
      title={label ? weixinRemoteText.loggedIn(label) : weixinRemoteText.rowTitle}
      description={weixinRemoteText.description}
      control={<Button
        size="sm"
        variant={snapshot.hasCredential ? 'secondary' : 'primary'}
        onClick={() => void start()}
        loading={starting && !view}
        disabled={disabled}
        testId="settings-remote-weixin-login-start"
      >{snapshot.hasCredential ? weixinRemoteText.relogin : weixinRemoteText.login}</Button>}
      testId="settings-remote-weixin-login-row"
    />
    <Dialog open={view !== null} title={weixinRemoteText.dialogTitle} onClose={close} footer={footer} testId="settings-remote-weixin-dialog">
      {view ? <WeixinLoginDialogBody view={view} code={code} onCodeChange={setCode} onSubmitCode={submitCode} busy={false} /> : null}
    </Dialog>
  </>
}
