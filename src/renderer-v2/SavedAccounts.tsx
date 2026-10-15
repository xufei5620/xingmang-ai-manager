import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2, X } from 'lucide-react'
import { Button, Dialog, Input, ListRow, Notice, Pill } from './ui'
import {
  ListState,
  ResultNotice,
  useOperation,
  useResource,
} from './business-common'
import type { V2Bridge } from './types'
import {
  accountSwitchRestartHint,
  accountSyncCandidates,
  preserveAccountSwitchResult,
  previousAccountSwitchResult,
  readAccountSyncContext,
  sameAccountOrigin,
  switchAccountWithOptionalSync,
  type AccountSwitchSyncResult,
  type AccountSyncCandidate,
} from './account-switch-sync'
import { tools } from './registry/tools'
import { keySyncFailureText } from './features/tools/key-sync-failure'
import { accountOrigin, siteIdForOrigin } from './account-context'
import { accountSources, isEmail } from './features/auth/state'
import type { LoginTarget } from './features/auth/api'
import { offersCodexDesktopRestart } from '../../electron/running-tools'
import { currentWindowOs, type WindowOs } from './features/app/window-os'

export function SavedAccounts({
  api,
  onAccountChanged,
  onLogin,
  variant = 'dialog',
}: {
  api: V2Bridge
  onAccountChanged?: (result?: AccountSwitchSyncResult) => void
  onLogin?: (target?: LoginTarget) => void
  /**
   * card = 摆在页面卡片里的样子：没有别的账号时只留一句话和「添加另一个账号」，「同步到工具」默认
   * 收起。v4 的账号概览不再列保存的账号（只在「切换账号」框里），眼下没有页面用它。缺省 = 「切换账号」框。
   */
  variant?: 'dialog' | 'card'
}) {
  const load = useCallback(async () => {
    const [accounts, session] = await Promise.all([
      api.listSavedAccounts(),
      api.getAccountSession(),
    ])
    return {
      accounts,
      session,
      origin: accountOrigin(session),
    }
  }, [api])
  const resource = useResource(load)
  const operation = useOperation()
  const syncLoad = useCallback(() => readAccountSyncContext(api), [api])
  const sync = useResource(syncLoad)
  // 切换账号时，原本就在用账号密钥的工具默认一起换过去，不然切完工具还在花上一个
  // 账号的钱（新手引导梳理 9-25 第 1 条）。自己填的密钥默认不动，要换就手动勾上。
  // 记的是用户改过的那几项，勾选框的值由候选列表现算，检测结果晚到也不会丢默认勾选。
  const [choices, setChoices] = useState<Partial<Record<SyncProvider, boolean>>>({})
  const [result, setResult] = useState<AccountSwitchSyncResult | null>(null)
  const restartHint = result ? accountSwitchRestartHint(result) : ''
  const candidates = sync.data ? accountSyncCandidates(sync.data) : []
  const selected = defaultSyncSelection(candidates, choices)
  useEffect(() => {
    setChoices({})
    const userId = resource.data?.session.account?.userId
    if (userId && resource.data)
      setResult(previousAccountSwitchResult(resource.data.origin, userId))
  }, [resource.data?.origin, resource.data?.session.account?.userId])
  const [remove, setRemove] = useState<string | null>(null)
  // 切过去才发现登录已失效的那一个保存账号（全面检测 Q12）：当前账号没变，
  // 这一行给个「重新登录这个账号」，不然用户只看到一句失败、不知道下一步。
  const [expired, setExpired] = useState<string | null>(null)
  function isCurrent(account: { userId: number; origin: string }) {
    return Boolean(
      resource.data?.session.authenticated &&
      account.userId === resource.data.session.account?.userId &&
      sameAccountOrigin(account.origin, resource.data.origin),
    )
  }
  const desktopClientsHint = accountSwitchDesktopClientsHint(currentWindowOs())
  const alone = variant === 'card' && Boolean(resource.data) && !resource.data?.accounts.some((account) => !isCurrent(account))
  const switchedTo = result ? resource.data?.accounts.find((account) => account.id === result.accountId)?.username : undefined
  return (
    <div data-testid="saved-accounts-list">
      {variant === 'dialog' && <p className="v2-saved-accounts-lead">切换后，下面勾上的工具会一起换成新账号的密钥。</p>}
      <ResultNotice {...operation} />
      {result && (
        <Notice
          tone={result.failed.length || result.skipped.length || restartHint ? 'warn' : 'ok'}
          title={
            result.failed.length || result.skipped.length ? '账号已切换，部分工具没有同步' : accountSwitchedTitle(switchedTo, result.origin)
          }
          body={
            <>
              {result.configured.length
                ? `已同步：${result.configured.map((id) => tools.find((tool) => tool.id === id)?.name ?? id).join('、')}`
                : '没有重写未勾选的工具配置。'}
              {[...result.failed, ...result.skipped].map((entry) => (
                <span key={entry.provider}>
                  <br />
                  {keySyncFailureText(entry.provider, entry.message)}
                </span>
              ))}
              {restartHint && (
                <span data-testid="account-sync-restart-hint">
                  <br />
                  {restartHint}
                </span>
              )}
            </>
          }
          actions={offersCodexDesktopRestart(result.runningTools) && (
            <Button
              size="sm"
              variant="primary"
              disabled={Boolean(operation.busy)}
              loading={operation.busy === 'restart-codex-desktop'}
              testId="account-sync-restart-codex-desktop"
              onClick={() =>
                void operation.execute(
                  'restart-codex-desktop',
                  async () => {
                    // 点了才重开，从不自动重开：桌面端正在回答的那一轮会被打断。
                    await api.launchCodexDesktop('restart')
                    const next = result.runningTools
                      ? { ...result, runningTools: { ...result.runningTools, codexDesktopRunning: false } }
                      : result
                    preserveAccountSwitchResult(next)
                    setResult(next)
                  },
                  'Codex 桌面端已重开，用上当前账号了。',
                )
              }
            >
              帮我重开 Codex 桌面端
            </Button>
          )}
          testId="account-sync-result"
        />
      )}
      {alone ? (
        <div className="v2-business-card-inset v2-business-saved-alone" data-testid="saved-accounts-alone">
          <p><strong>还没有保存别的账号。</strong></p>
          <p>点下面的「添加另一个账号」，以后在这里一键切换。</p>
          <Button icon={Plus} onClick={() => onLogin?.()} testId="account-add">
            添加另一个账号
          </Button>
        </div>
      ) : (
        <>
          <ListState
            page="saved-accounts"
            noun="保存的账号"
            loading={resource.loading}
            error={resource.error}
            count={resource.data?.accounts.length ?? 0}
            retry={() => void resource.reload()}
            emptyTitle="还没有保存别的账号"
            emptyDescription="点下面的「添加另一个账号」，以后在这里一键切换。"
          >
            {resource.data?.accounts.map((account) => {
              const current = isCurrent(account)
              return (
                <ListRow
                  key={account.id}
                  testId={`saved-account-row-${account.id}`}
                  title={account.username}
                  desc={savedAccountSourceLabel(account.origin)}
                  badge={current && <Pill tone="ok">当前账号</Pill>}
                  actions={
                    <>
                      <Button
                        size="sm"
                        disabled={current || Boolean(operation.busy)}
                        loading={operation.busy === account.id}
                        onClick={() =>
                          void operation.execute(
                            account.id,
                            async () => {
                              setExpired(null)
                              const outcome = await switchAccountWithOptionalSync(
                                api,
                                account,
                                selected,
                                sync.data,
                                resource.data?.origin ?? '',
                              ).catch((error: unknown) => {
                                if (savedAccountExpired(error)) setExpired(account.id)
                                throw error
                              })
                              preserveAccountSwitchResult(outcome)
                              setResult(outcome)
                              setChoices({})
                              await resource.reload()
                              await sync.reload()
                              onAccountChanged?.(outcome)
                            },
                            '',
                          )
                        }
                      >
                        切换
                      </Button>
                      {expired === account.id && !current && onLogin && (
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={Boolean(operation.busy)}
                          onClick={() => onLogin?.(savedAccountLoginTarget(account))}
                          testId={`saved-account-relogin-${account.id}`}
                        >
                          重新登录这个账号
                        </Button>
                      )}
                      {!current && (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={X}
                          aria-label={`移除保存的账号「${account.username}」`}
                          title="移除保存账号"
                          disabled={Boolean(operation.busy)}
                          onClick={() => setRemove(account.id)}
                          testId={`saved-account-remove-${account.id}`}
                        />
                      )}
                    </>
                  }
                />
              )
            })}
          </ListState>
          <details className="v2-business-account-sync" open={variant !== 'card'}>
            <summary>同步到工具</summary>
            <p>勾上的工具会一起换成要切过去的账号，不勾的保持原样。</p>
            {desktopClientsHint && <p data-testid="account-sync-desktop-clients">{desktopClientsHint}</p>}
            <ResultNotice error={sync.error} detail={sync.detail} />
            {sync.loading && <p role="status">正在检查工具配置…</p>}
            {candidates.map((candidate) => (
              <Input
                key={candidate.provider}
                type="checkbox"
                label={candidate.name}
                hint={`${candidate.reason}${candidate.eligible ? '' : '，保持原配置'}`}
                checked={
                  candidate.eligible && selected.includes(candidate.provider)
                }
                disabled={
                  !candidate.eligible || sync.loading || Boolean(operation.busy)
                }
                testId={`account-sync-${candidate.provider}`}
                onChange={(event) =>
                  setChoices((values) => ({
                    ...values,
                    [candidate.provider]: event.target.checked,
                  }))
                }
              />
            ))}
          </details>
          <div className="v2-business-card-inset">
            <Button icon={Plus} onClick={() => onLogin?.()} testId="account-add">
              添加另一个账号
            </Button>
          </div>
        </>
      )}
      <Dialog
        open={Boolean(remove)}
        title="移除保存账号？"
        onClose={() => setRemove(null)}
        footer={
          <>
            <Button onClick={() => setRemove(null)}>取消</Button>
            <Button
              variant="danger"
              icon={Trash2}
              loading={operation.busy === 'remove'}
              onClick={() => {
                if (remove)
                  void operation.execute(
                    'remove',
                    async () => {
                      await api.removeSavedAccount(remove)
                      setRemove(null)
                      await resource.reload()
                    },
                    '保存账号已移除',
                  )
              }}
            >
              移除
            </Button>
          </>
        }
      >
        <p>只移除本机保存的登录信息。已写入工具的密钥不会改变。</p>
        <ResultNotice error={operation.error} detail={operation.detail} />
      </Dialog>
    </div>
  )
}

/**
 * 「同步到工具」只管命令行工具（account-switch-sync.ts 跳过桌面客户端），Claude Desktop、WorkBuddy、
 * OpenCode 切完还用着原来账号的 Key，首页照样给「打开」（已知37）。先把出路说清楚；Linux 上首页不列
 * 这几个客户端，就不提。
 */
export function accountSwitchDesktopClientsHint(os: WindowOs): string | null {
  return os === 'linux' ? null : 'Claude Desktop、WorkBuddy、OpenCode 不会跟着换。切完要换的话，到首页它那一行点「…」里的「配置」，再点「检测模型」「保存配置」。'
}

type SyncProvider = AccountSyncCandidate['provider']

/**
 * 切换账号时哪些工具要一起换。没动过的按默认：原本就是账号密钥的勾上，自己填的、
 * 官方账号、别处的配置都不勾；动过的听用户的。不能换的一律不算。
 */
export function defaultSyncSelection(
  candidates: readonly AccountSyncCandidate[],
  choices: Partial<Record<SyncProvider, boolean>>,
): SyncProvider[] {
  return candidates
    .filter((candidate) => candidate.eligible && (choices[candidate.provider] ?? candidate.reason === '星芒密钥'))
    .map((candidate) => candidate.provider)
}

/**
 * 保存账号那一行的副标题：说清是星芒账号还是历史账号（全面检测 Q45）。以前这里写
 * 「账户尾号」，其实是保存记录 id（地址 + 用户 id 的 sha256）的末 6 位，用户对不上
 * 任何东西，也分不出两类账号。标签沿用登录页两个来源的原名，不露地址。
 */
export function savedAccountSourceLabel(origin: string): string {
  const siteId = siteIdForOrigin(origin)
  return siteId ? accountSources[siteId].label : '账号来源无法识别'
}

/** 切换成功那条提示的标题：切到了谁、哪种账号（v4）；名字或来源没认出来就照旧说「账号已切换」。 */
export function accountSwitchedTitle(name: string | undefined, origin: string): string {
  const siteId = siteIdForOrigin(origin)
  return name && siteId ? `已切换到「${name}」（${accountSources[siteId].label}）` : '账号已切换'
}

/**
 * 「重新登录这个账号」要把登录框直接对到这一行的来源和用户名（#480）。以前只是打开
 * 登录框，默认星芒账号、用户名空着，历史账号的用户得自己改回来源再重填，改漏了就登错站。
 * 来源认不出时不预选，照常打开登录框。
 *
 * 历史账号只能用注册邮箱登录，这一行存的却是账号昵称，改过昵称的老用户两者不一样。
 * 昵称不是邮箱时就不预填，登录框空着才会带出记住的邮箱；硬填昵称只会换来一句
 * 「请使用注册邮箱登录」。
 */
export function savedAccountLoginTarget(account: { origin: string; username: string }): LoginTarget | undefined {
  const siteId = siteIdForOrigin(account.origin)
  if (!siteId) return undefined
  const identifier = account.username.trim()
  return { siteId, identifier: siteId === 'solov-api' && !isEmail(identifier) ? '' : identifier }
}

/** 主进程 SAVED_EXPIRED 那句（electron/realm-account.ts）；只认它，不认当前账号过期。 */
export function savedAccountExpired(error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return /保存的账号登录已失效/.test(message)
}
