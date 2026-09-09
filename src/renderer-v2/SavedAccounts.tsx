import { useCallback, useEffect, useState } from 'react'
import { MoreHorizontal, Plus, Trash2 } from 'lucide-react'
import { resolveRelaySite } from '../../electron/ipc-contract'
import { Button, Dialog, Input, ListRow, Menu, Notice, Pill } from './ui'
import {
  ListState,
  ResultNotice,
  useOperation,
  useResource,
} from './business-common'
import type { V2Bridge } from './types'
import {
  accountSyncCandidates,
  preserveAccountSwitchResult,
  previousAccountSwitchResult,
  readAccountSyncContext,
  sameAccountOrigin,
  switchAccountWithOptionalSync,
  type AccountSwitchSyncResult,
} from './account-switch-sync'
import { tools } from './registry/tools'

/** Make the account realm explicit when two providers share the same email. */
function accountBackendLabel(origin: string): string {
  try {
    const hostname = new URL(origin).hostname.toLowerCase()
    return hostname === 'api.solov.cc' ? 'sub2api' : 'new-api'
  } catch {
    return '未知服务'
  }
}

export function SavedAccounts({
  api,
  onAccountChanged,
  onLogin,
}: {
  api: V2Bridge
  onAccountChanged?: (result?: AccountSwitchSyncResult) => void
  onLogin?: () => void
}) {
  const load = useCallback(async () => {
    const [accounts, session, settings] = await Promise.all([
      api.listSavedAccounts(),
      api.getAccountSession(),
      api.getSettings(),
    ])
    const site = resolveRelaySite(settings.relaySiteId)
    return {
      accounts,
      session,
      origin: new URL(site.accountBaseUrl ?? site.websiteUrl).origin,
    }
  }, [api])
  const resource = useResource(load)
  const operation = useOperation()
  const syncLoad = useCallback(() => readAccountSyncContext(api), [api])
  const sync = useResource(syncLoad)
  const [selected, setSelected] = useState<
    Array<
      Parameters<V2Bridge['configureManagedCliKeys']>[0]['providers'][number]
    >
  >([])
  const [result, setResult] = useState<AccountSwitchSyncResult | null>(null)
  const candidates = sync.data ? accountSyncCandidates(sync.data) : []
  useEffect(() => {
    setSelected([])
    const userId = resource.data?.session.account?.userId
    if (userId && resource.data)
      setResult(previousAccountSwitchResult(resource.data.origin, userId))
  }, [resource.data?.origin, resource.data?.session.account?.userId])
  useEffect(() => {
    const allowed = new Set(
      candidates.filter((item) => item.eligible).map((item) => item.provider),
    )
    setSelected((values) => values.filter((value) => allowed.has(value)))
  }, [sync.data])
  const [remove, setRemove] = useState<string | null>(null)
  return (
    <div data-testid="saved-accounts-list">
      <ResultNotice {...operation} />
      {result && (
        <Notice
          tone={result.failed.length ? 'warn' : 'ok'}
          title={
            result.failed.length ? '账号已切换，部分工具没有同步' : '账号已切换'
          }
          body={
            <>
              {result.configured.length
                ? `已同步：${result.configured.map((id) => tools.find((tool) => tool.id === id)?.name ?? id).join('、')}`
                : '没有重写未勾选的工具配置。'}
              {[...result.failed, ...result.skipped].map((entry) => (
                <span key={entry.provider}>
                  <br />
                  {tools.find((tool) => tool.id === entry.provider)?.name ??
                    entry.provider}
                  ：{entry.message}
                </span>
              ))}
            </>
          }
          testId="account-sync-result"
        />
      )}
      <ListState
        page="saved-accounts"
        noun="保存的账号"
        loading={resource.loading}
        error={resource.error}
        count={resource.data?.accounts.length ?? 0}
        retry={() => void resource.reload()}
      >
        {resource.data?.accounts.map((account) => {
          const current =
            resource.data?.session.authenticated &&
            account.userId === resource.data.session.account?.userId &&
            sameAccountOrigin(account.origin, resource.data.origin)
          const sameOrigin =
            resource.data &&
            sameAccountOrigin(account.origin, resource.data.origin)
          return (
            <ListRow
              key={account.id}
              title={account.username}
              desc={`${accountBackendLabel(account.origin)} · ${account.origin}`}
              badge={current && <Pill tone="ok">当前账号</Pill>}
              actions={
                <>
                  <Button
                    size="sm"
                    disabled={current || !sameOrigin || Boolean(operation.busy)}
                    loading={operation.busy === account.id}
                    onClick={() =>
                      void operation.execute(
                        account.id,
                        async () => {
                          const outcome = await switchAccountWithOptionalSync(
                            api,
                            account,
                            selected,
                            sync.data,
                            resource.data?.origin ?? '',
                          )
                          preserveAccountSwitchResult(outcome)
                          setResult(outcome)
                          setSelected([])
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
                  {!current && (
                    <Menu
                      anchor={<MoreHorizontal size={18} />}
                      items={[
                        {
                          label: '移除保存账号',
                          icon: Trash2,
                          danger: true,
                          onSelect: () => setRemove(account.id),
                        },
                      ]}
                    />
                  )}
                </>
              }
            />
          )
        })}
      </ListState>
      <details className="v2-business-account-sync">
        <summary>同步到工具（可选）</summary>
        <p>只有勾选的工具会改用目标账号的星芒密钥。</p>
        <ResultNotice error={sync.error} />
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
              setSelected((values) =>
                event.target.checked
                  ? [...new Set([...values, candidate.provider])]
                  : values.filter((value) => value !== candidate.provider),
              )
            }
          />
        ))}
      </details>
      <div className="v2-business-card-inset">
        <Button icon={Plus} onClick={onLogin} testId="account-add">
          添加另一个账号
        </Button>
        <p>登录状态失效时需要重新登录。未勾选的工具保持原配置。</p>
      </div>
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
        <ResultNotice error={operation.error} />
      </Dialog>
    </div>
  )
}
