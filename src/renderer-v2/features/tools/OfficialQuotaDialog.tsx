import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { OfficialChatGptAccount } from '../../../../electron/ipc-contract'
import { BrandIcon, Button, Dialog, Progress } from '../../ui'
import { errorMessage } from '../../business-common'

/** 一分钟内读到的写「刚刚更新」，再早的写具体时间（v4 原型的额度弹窗）。 */
export function quotaCheckedText(checkedAt: string, now = Date.now()): string {
  const at = new Date(checkedAt).getTime()
  return Number.isFinite(at) && now - at < 60_000 ? '刚刚更新' : `更新于 ${new Date(checkedAt).toLocaleString('zh-CN')}`
}

/**
 * ChatGPT 账号额度。首页卡片「…」和配置弹窗里「查看 ChatGPT 账号额度」打开的是同一个：
 * 原来只有首页有，配置里要看得先关掉配置。额度按「已用」画（主进程给的是剩余百分比）。
 */
export function OfficialQuotaDialog({ email, initial, refresh, onClose }: {
  email?: string | null
  initial: OfficialChatGptAccount | null
  refresh(): Promise<OfficialChatGptAccount | null>
  onClose(): void
}) {
  const [official, setOfficial] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const active = useRef(true)
  const lock = useRef(false)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  async function reload() {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { const value = await refresh(); if (active.current) setOfficial(value) }
    catch (cause) { if (active.current) setError(errorMessage(cause, '官方额度暂时没有读到')) }
    finally { lock.current = false; if (active.current) setBusy(false) }
  }
  return <Dialog open title="ChatGPT 账号额度" width={480} onClose={onClose} busy={busy} testId="codex-quota-dialog"
    footer={<><span className="v2-dialog-footer-start"><Button variant="ghost" icon={RefreshCw} loading={busy} onClick={() => void reload()}>刷新额度</Button></span><Button onClick={onClose} disabled={busy}>关闭</Button></>}>
    {error && <p className="v2-callout is-bad" role="alert">{error}</p>}
    {official ? <div className="v2-quota">
      <div className="v2-official-summary"><BrandIcon tool="codex" /><div>{email && <strong>{email}</strong>}<p>{official.planLabel ?? '官方账号'}，{quotaCheckedText(official.checkedAt)}</p>
        {official.renewsAt && <p>{new Date(official.renewsAt).toLocaleDateString('zh-CN')} 续订</p>}</div></div>
      {official.windows.map((window) => {
        const used = Math.min(100, Math.max(0, 100 - window.remainingPercent))
        return <div className="v2-quota-window" key={window.id}><div className="v2-quota-row"><span>{window.label}</span><strong>已用 {used}%</strong></div>
          <Progress value={used} tone={used > 80 ? 'warn' : 'accent'} />{window.resetAt && <small>{new Date(window.resetAt).toLocaleString('zh-CN')} 恢复</small>}</div>
      })}
      {official.resetCredits !== null && <p>剩余额度 {official.resetCredits}</p>}
      <p className="v2-quota-note">用完后可以在 Codex 配置里改用当前账号接着用。</p>
    </div> : <p>官方额度暂未读取，刷新后查看。</p>}
  </Dialog>
}
