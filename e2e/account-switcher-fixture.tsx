import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AccountSwitcher } from '../src/components/account/AccountSwitcher'
import type { ProviderId, SavedAccount } from '../src/types'
import '../src/styles.css'
import '../src/styles/ui-tokens.css'
import '../src/styles/ui-layout.css'

const search = new URLSearchParams(location.search)
const scenario = search.get('scenario') ?? 'normal'
document.documentElement.dataset.theme = search.get('theme') ?? 'dark'
document.documentElement.dataset.skin = search.get('theme') === 'light' ? 'dawn' : 'obsidian'
const origin = 'https://xm.example.com'
const initialAccounts: SavedAccount[] = [
  { id: 'account-a', origin, userId: 1, username: '当前账号 A', updatedAt: '2026-09-07T00:00:00.000Z' },
  { id: 'account-b', origin, userId: 2, username: scenario === 'long-name' ? 'long-account-address-that-needs-wrapping@example-with-a-long-domain.test' : '目标账号 B', updatedAt: '2026-09-06T00:00:00.000Z' },
  { id: 'account-c', origin: 'https://other.example.com', userId: 1, username: '其他站点 C', updatedAt: '2026-09-05T00:00:00.000Z' },
]

declare global {
  interface Window {
    accountSwitcherHarness: {
      activeId: number
      loadCalls: number
      switchCalls: Array<{ id: string; providers: ProviderId[] }>
      removeCalls: string[]
      addCalls: number
      closeCalls: number
      loadFailure: string
      releaseSwitch: (success: boolean) => void
      releaseRemove: (success: boolean) => void
      disallowCodex: () => void
    }
  }
}
window.accountSwitcherHarness = { activeId: 1, loadCalls: 0, switchCalls: [], removeCalls: [], addCalls: 0, closeCalls: 0, loadFailure: scenario === 'encryption-fails' ? '系统加密服务不可用，无法保存或切换账号' : '', releaseSwitch: () => {}, releaseRemove: () => {}, disallowCodex: () => {} }

function Fixture() {
  const [visible, setVisible] = useState(false)
  const [activeId, setActiveId] = useState(1)
  const [accounts, setAccounts] = useState(initialAccounts)
  const [codexAllowed, setCodexAllowed] = useState(true)
  window.accountSwitcherHarness.disallowCodex = () => setCodexAllowed(false)
  return <>
    <button type="button" id="open-switcher" onClick={() => setVisible(true)}>账号切换</button>
    {visible && <AccountSwitcher activeUserId={activeId} accountsOrigin={origin}
      loadAccounts={async () => {
        window.accountSwitcherHarness.loadCalls += 1
        if (window.accountSwitcherHarness.loadFailure) throw new Error(window.accountSwitcherHarness.loadFailure)
        return accounts
      }}
      onSwitch={async (id, providers) => {
        window.accountSwitcherHarness.switchCalls.push({ id, providers })
        if (scenario === 'switch-fails-once' && window.accountSwitcherHarness.switchCalls.length === 1) throw new Error('目标账号登录状态已失效')
        if (scenario === 'slow-switch') await new Promise<void>((resolve, reject) => { window.accountSwitcherHarness.releaseSwitch = (success) => success ? resolve() : reject(new Error('切换请求超时，请重试')) })
        const selected = accounts.find((account) => account.id === id)!
        window.accountSwitcherHarness.activeId = selected.userId
        setActiveId(selected.userId)
      }}
      onRemove={async (id) => {
        window.accountSwitcherHarness.removeCalls.push(id)
        if (scenario === 'remove-fails-once' && window.accountSwitcherHarness.removeCalls.length === 1) throw new Error('账号文件写入失败')
        if (scenario === 'slow-remove') await new Promise<void>((resolve, reject) => { window.accountSwitcherHarness.releaseRemove = (success) => success ? resolve() : reject(new Error('账号文件写入失败')) })
        setAccounts((current) => current.filter((account) => account.id !== id))
      }}
      onAddAccount={() => { window.accountSwitcherHarness.addCalls += 1 }}
      onClose={() => { window.accountSwitcherHarness.closeCalls += 1; setVisible(false) }}
      syncTools={[
        { id: 'codex', label: 'Codex CLI', source: '自己填写的星芒 Key', allowed: codexAllowed },
        { id: 'claude', label: 'Claude Code', source: 'Claude 官方账号', allowed: false },
        { id: 'gemini', label: 'Gemini CLI', source: '已有第三方配置', allowed: false },
        { id: 'grok', label: 'Grok CLI', source: '星芒账号', allowed: true },
      ]}
    />}
  </>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
