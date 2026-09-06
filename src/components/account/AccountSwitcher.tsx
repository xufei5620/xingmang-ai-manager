import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRightLeft, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { errorMessage } from '../../error-message'
import type { ProviderId, SavedAccount } from '../../types'
import { DialogBackdrop, dialogAriaProps } from '../Dialog'
import { Avatar, Banner, Button, Checkbox, Empty, IconButton, Pill, Skeleton } from '../ui'
import './AccountSwitcher.css'

export interface AccountSwitcherSyncTool {
  id: ProviderId
  label: string
  source: string
  allowed: boolean
}

export function savedAccountMatchesOrigin(account: SavedAccount, expectedOrigin: string): boolean {
  try {
    const actual = new URL(account.origin)
    const expected = new URL(expectedOrigin)
    return actual.protocol === 'https:' && expected.protocol === 'https:' && !actual.username && !actual.password && !expected.username && !expected.password && actual.origin === expected.origin
  } catch { return false }
}

export function selectedSyncProviders(selected: ReadonlySet<ProviderId>, tools: readonly AccountSwitcherSyncTool[]): ProviderId[] {
  return [...new Set(tools.filter((tool) => tool.allowed && selected.has(tool.id)).map((tool) => tool.id))]
}

export function AccountSwitcher({ activeUserId, accountsOrigin, loadAccounts, onSwitch, onRemove, onAddAccount, onClose, syncTools }: {
  activeUserId: number | null
  accountsOrigin: string
  loadAccounts: () => Promise<SavedAccount[]>
  onSwitch: (id: string, selectedProviders: ProviderId[]) => Promise<void>
  onRemove: (id: string) => Promise<void>
  onAddAccount: () => void
  onClose: () => void
  syncTools: AccountSwitcherSyncTool[]
}) {
  const [accounts, setAccounts] = useState<SavedAccount[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [pending, setPending] = useState<{ kind: 'switch' | 'remove'; id: string } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<SavedAccount | null>(null)
  const [selected, setSelected] = useState<Set<ProviderId>>(new Set())
  const mounted = useRef(true)
  const pendingRef = useRef(false)
  const requestId = useRef(0)
  const loadRef = useRef(loadAccounts)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const cancelRemoveRef = useRef<HTMLButtonElement>(null)
  const removeTriggers = useRef(new Map<string, HTMLButtonElement>())
  loadRef.current = loadAccounts
  const allowedIds = syncTools.filter((tool) => tool.allowed).map((tool) => tool.id).join(',')

  const isCurrent = (account: SavedAccount) => account.userId === activeUserId && savedAccountMatchesOrigin(account, accountsOrigin)
  const reload = async () => {
    if (pendingRef.current) return
    const attempt = ++requestId.current
    setLoading(true)
    setLoadError('')
    try {
      const next = await loadRef.current()
      if (mounted.current && attempt === requestId.current) setAccounts(next)
    } catch (failure) {
      if (mounted.current && attempt === requestId.current) setLoadError(errorMessage(failure))
    } finally {
      if (mounted.current && attempt === requestId.current) setLoading(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    void reload()
    return () => { mounted.current = false; requestId.current += 1 }
  }, [accountsOrigin])
  useEffect(() => { setSelected(new Set()) }, [activeUserId, accountsOrigin])
  useEffect(() => {
    const allowed = new Set(allowedIds.split(','))
    setSelected((current) => new Set([...current].filter((id) => allowed.has(id))))
  }, [allowedIds])
  useEffect(() => { if (confirmRemove) cancelRemoveRef.current?.focus() }, [confirmRemove])
  useEffect(() => { if (actionError) errorRef.current?.focus() }, [actionError])

  const returnToList = () => {
    if (pendingRef.current) return
    const previous = confirmRemove
    setConfirmRemove(null)
    setActionError('')
    window.setTimeout(() => {
      if (!mounted.current) return
      if (previous) removeTriggers.current.get(previous.id)?.focus()
      else headingRef.current?.focus()
    }, 0)
  }
  const dismiss = () => {
    if (pendingRef.current) return
    if (confirmRemove) returnToList()
    else onClose()
  }
  const switchAccount = async (account: SavedAccount) => {
    if (pendingRef.current || loading || isCurrent(account) || !savedAccountMatchesOrigin(account, accountsOrigin)) return
    pendingRef.current = true
    setPending({ kind: 'switch', id: account.id })
    setActionError('')
    try {
      await onSwitch(account.id, selectedSyncProviders(selected, syncTools))
      if (mounted.current) onClose()
    } catch (failure) {
      if (mounted.current) setActionError(errorMessage(failure))
    } finally {
      pendingRef.current = false
      if (mounted.current) setPending(null)
    }
  }
  const removeAccount = async () => {
    if (pendingRef.current || !confirmRemove || isCurrent(confirmRemove)) return
    const target = confirmRemove
    pendingRef.current = true
    setPending({ kind: 'remove', id: target.id })
    setActionError('')
    try {
      await onRemove(target.id)
      if (!mounted.current) return
      setAccounts((current) => current?.filter((account) => account.id !== target.id) ?? null)
      setConfirmRemove(null)
      window.setTimeout(() => { if (mounted.current) headingRef.current?.focus() }, 0)
    } catch (failure) {
      if (mounted.current) setActionError(errorMessage(failure))
    } finally {
      pendingRef.current = false
      if (mounted.current) setPending(null)
    }
  }

  return <DialogBackdrop className="account-switcher-backdrop" onDismiss={dismiss}>
    <section className="account-switcher" {...dialogAriaProps('account-switcher-title')} aria-busy={pending !== null}>
      <header className="account-switcher-header">
        <div><h2 id="account-switcher-title" ref={headingRef} tabIndex={-1} data-initial-focus>{confirmRemove ? '移除已保存账号' : '切换账号'}</h2><p>{accountsOrigin}</p></div>
        <IconButton icon={confirmRemove ? ArrowLeft : X} label={confirmRemove ? '返回账号列表' : '关闭账号切换'} onClick={dismiss} disabled={pending !== null} />
      </header>
      <div className="account-switcher-body">
        {confirmRemove ? <>
          <div className="account-switcher-removal-identity"><Avatar name={confirmRemove.username} /><div><strong>{confirmRemove.username}</strong><span>{confirmRemove.origin}</span></div></div>
          <Banner title={isCurrent(confirmRemove) ? '当前账号不能移除' : '从这台设备移除登录凭据'} tone="warn">{isCurrent(confirmRemove) ? '请先切换到另一个账号。' : '移除后，切换到此账号需要重新登录。账号数据和工具配置不会被删除。'}</Banner>
        </> : <>
          <div className="account-switcher-list-heading"><h3>已保存账号</h3><IconButton icon={RefreshCw} size="sm" label="重新读取已保存账号" disabled={loading || pending !== null} loading={loading} onClick={() => void reload()} /></div>
          {loading && accounts === null && <Skeleton label="正在读取已保存账号" rows={3} />}
          {loadError && <Banner title="无法读取已保存账号" tone="bad" live="assertive" actions={<Button icon={RefreshCw} size="sm" disabled={loading || pending !== null} onClick={() => void reload()}>重试读取</Button>}>{loadError}</Banner>}
          {accounts?.length === 0 && !loading && !loadError && <Empty title="还没有已保存账号" description="登录账号后，可将凭据加密保存在这台设备。" />}
          {accounts && accounts.length > 0 && <ul className="account-switcher-list">
            {accounts.map((account) => <li className="account-switcher-row" key={account.id} data-account-id={account.id}>
              <Avatar name={account.username} />
              <div className="account-switcher-identity"><strong>{account.username}</strong><span>{account.origin}</span></div>
              <div className="account-switcher-row-actions">
                {isCurrent(account) ? <Pill tone="ok">当前账号</Pill> : savedAccountMatchesOrigin(account, accountsOrigin)
                  ? <Button size="sm" icon={ArrowRightLeft} disabled={loading || pending !== null} loading={pending?.kind === 'switch' && pending.id === account.id} onClick={() => void switchAccount(account)}>切换</Button>
                  : <Pill>其他站点</Pill>}
                {!isCurrent(account) && <IconButton icon={Trash2} size="sm" label={`移除 ${account.username}`} disabled={loading || pending !== null} ref={(element) => { if (element) removeTriggers.current.set(account.id, element); else removeTriggers.current.delete(account.id) }} onClick={() => { if (pendingRef.current) return; setActionError(''); setConfirmRemove(account) }} />}
              </div>
            </li>)}
          </ul>}
          {syncTools.length > 0 && <section className="account-switcher-sync" aria-labelledby="account-switcher-sync-heading">
            <h3 id="account-switcher-sync-heading">同步到工具</h3>
            <p>勾选的工具会改用目标账号的星芒 Key。</p>
            <div className="account-switcher-sync-list">{syncTools.map((tool) => <Checkbox key={tool.id} label={tool.label} description={`${tool.source}${tool.allowed ? '' : ' · 保持原配置'}`} checked={tool.allowed && selected.has(tool.id)} disabled={!tool.allowed || pending !== null || loading} testId={`account-sync-${tool.id}`} onChange={(event) => {
              setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(tool.id); else next.delete(tool.id); return next })
            }} />)}</div>
          </section>}
        </>}
        {pending?.kind === 'switch' && <Banner title="正在验证并切换账号" live="polite">请等待当前操作完成。</Banner>}
        {actionError && <div tabIndex={-1} ref={errorRef}><Banner title={confirmRemove ? '移除失败' : '切换未完成'} tone="bad" live="assertive">{actionError}</Banner></div>}
      </div>
      <footer className="account-switcher-footer">
        {confirmRemove ? <>
          <Button ref={cancelRemoveRef} disabled={pending !== null} onClick={returnToList}>保留账号</Button>
          <Button icon={Trash2} variant="danger" disabled={pending !== null || isCurrent(confirmRemove)} loading={pending?.kind === 'remove'} onClick={() => void removeAccount()}>确认移除</Button>
        </> : <>
          <Button icon={Plus} disabled={pending !== null} onClick={() => { if (pendingRef.current) return; try { onAddAccount() } catch (failure) { setActionError(errorMessage(failure)) } }}>添加账号</Button>
          <Button disabled={pending !== null} onClick={dismiss}>完成</Button>
        </>}
      </footer>
    </section>
  </DialogBackdrop>
}
