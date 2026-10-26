// 记录页（#1070 第 11 步，从 pages-management.tsx 原样搬来）：各工具的会话列表、按工具筛、搜索、详情和对话开头、
// 接着聊、归档与恢复、导出。pages-management.tsx 照旧转出这里的导出名；工具选单在 features/tools/provider-options.ts。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  Copy,
  Download,
  FolderOpen,
  MoreHorizontal,
  Play,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import {
  BrandIcon,
  Button,
  Card,
  Chips,
  Confirm,
  Dialog,
  Menu,
  Notice,
  PageHead,
  Pill,
  SearchInput,
  useToast,
  type MenuItem,
} from '../../ui'
import {
  RelativeTime,
  ListState,
  Pagination,
  ResultNotice,
  useOperation,
  useReloadWhenShown,
  useResource,
} from '../../business-common'
import { isMissingWorkspace, latestSessionIdsByWorkspace, resumeLaunchChoice, resumeNeedsRecheck, resumeStillLatest, withoutRetiredSessions } from '../tools/recent-workspaces'
import { launchDeclined, resumeSessionNotice } from '../tools/launch-notice'
import type { V2Bridge } from '../../types'
import type { ActiveProviderId } from '../../../../electron/catalog'
import { isProvider, providerName, providerOptions } from '../tools/provider-options'

// 已下线的 CLI（Gemini，yoyo 2026-10-14）不在这里：管理页不再列它的扩展、会话和备份。
type Provider = ActiveProviderId
type Session = Awaited<
  ReturnType<V2Bridge['listProviderSessions']>
>['items'][number]
// 记录页显示着、窗口回到前面时，离上次读不到这么久就不再读（同 useNetworkLocation 的 focusRefreshIntervalMs）。
const recordsForegroundReloadMs = 30_000
// 详情里「对话开头」先给几条；多出来的点「看全部」再展开，整段对话照旧都在。
const transcriptPreviewCount = 2
type SessionToolFilter = Provider | 'all'
/**
 * 工具按钮上的数。列表那一份已经按工具筛过、按搜索词滤过，数不出别的工具有几条，
 * 所以用不带筛选的那份（定「接着聊」用的最新 100 条）的统计。已下线的工具不算进「全部」。
 * 还没读到（或读不到）时返回 null，按钮上就不写数，免得像是真的一条没有。
 */
export function sessionToolCounts(
  byProvider: Partial<Record<string, number>> | undefined,
): Record<SessionToolFilter, number> | null {
  if (!byProvider) return null
  const counts: Record<SessionToolFilter, number> = { all: 0, claude: 0, codex: 0, grok: 0 }
  for (const option of providerOptions) {
    if (!isProvider(option.value)) continue
    const count = byProvider[option.value] ?? 0
    counts[option.value] = count
    counts.all += count
  }
  return counts
}
/** 表格标题下面那行小字：模型、几条消息；归档过的记录在后面标一句。条数不知道就不写，不写「未知 条」。 */
export function sessionRowMeta(session: Pick<Session, 'model' | 'messageCount' | 'archived'>): string {
  return [
    session.model || '未记录模型',
    session.messageCount === null ? '' : `${session.messageCount} 条消息`,
    session.archived ? '已归档' : '',
  ].filter(Boolean).join(' · ')
}
function sessionTitle(session: Pick<Session, 'title'>) {
  return session.title || '未命名会话'
}
export function SessionsPage({
  api,
  onSessionsChanged,
  onOpenTools,
  beforeResume,
  installedProviders,
  active,
}: {
  api: V2Bridge
  /**
   * 接着聊成功、归档或恢复之后通知外层：首页那份「最近」缓存要作废并重读。
   * 省略 = 不通知（旧行为）。
   */
  onSessionsChanged?: () => void
  /** 一条记录都没有时「去打开工具」：回首页「你的工具」。省略 = 不放这颗按钮。 */
  onOpenTools?: () => void
  /**
   * 「接着聊」真打开之前，先过首页「打开」那几道关：核对默认模型、没连好账号先去连、
   * Codex 老配置先修。过不了的原因照常抛出来，挂在页顶；返回 false = 不往下走（问话框里
   * 关掉了，或者中途换了账号）。省略 = 不检查（旧行为）。
   */
  beforeResume?: (provider: Provider) => Promise<boolean>
  /**
   * 装好的命令行工具：没装的那家「接着聊」按不动，说一句要先装好。
   * 缺省 = 还没检测完，不因此置灰（旧行为）。
   */
  installedProviders?: readonly string[]
  /**
   * 外壳说的「现在显示的是这一页」（同 BusinessActions.active）：再显示时、显示着窗口又回到前面时重读；
   * 缺省 = 只在第一次进来时读（旧行为）。
   */
  active?: boolean
}) {
  const toast = useToast()
  const [provider, setProvider] = useState<SessionToolFilter>('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const load = useCallback(
    () =>
      api.listProviderSessions({ provider, search: query, page, pageSize: 20 }).then(withoutRetiredSessions),
    [api, provider, query, page],
  )
  const resource = useResource(load)
  // 「接着聊」只能出现在每个(工具 × 目录)组合最近的那一条上,而当前这一页是
  // 过滤加分页之后的切片,判断不出全局最近。所以另取一份不带过滤的最新记录来
  // 定这件事,上限就是主进程允许的一页最大条数;更老的组合不给按钮(宁可少给)。
  const latestLoad = useCallback(
    () => api.listProviderSessions({ provider: 'all', page: 1, pageSize: 100 }).then(withoutRetiredSessions),
    [api],
  )
  const latestResource = useResource(latestLoad)
  const resumable = useMemo(
    () => latestSessionIdsByWorkspace(latestResource.data?.items ?? []),
    [latestResource.data],
  )
  const counts = sessionToolCounts(latestResource.error ? undefined : latestResource.data?.stats.byProvider)
  const operation = useOperation()
  const [selected, setSelected] = useState<Session | null>(null)
  const [showAllMessages, setShowAllMessages] = useState(false)
  // 只有摘要的记录原文已经不在这台电脑上，不去读；详情里照样看工具、文件夹和模型。
  const detailLoad = useCallback(
    () =>
      selected?.detailAvailable
        ? api.getProviderSessionDetail(selected.id)
        : Promise.resolve(null),
    [api, selected?.id, selected?.detailAvailable],
  )
  const detailResource = useResource(detailLoad)
  const detail = detailResource.data
  // 去过的页面只藏不卸：在终端里聊完回来，这一页还是第一次进来时那份，刚聊的那条不在，「接着聊」还挂在
  // 同一文件夹更早那条上；Claude Code、Grok CLI 按文件夹接最近一条（#292），点下去接上的是刚聊的
  // 那条。所以再显示时、显示着窗口又回到前面时，两份列表连同开着的详情一起重读，先摆着旧的、读回来再换。
  // 窗口那一下离上次读不到 30 秒就不读；本页「接着聊」打开了终端就清零，回来头一次切回窗口一定重读。
  const lastRead = useRef(Number.NEGATIVE_INFINITY)
  const reloadRecords = () => {
    lastRead.current = performance.now()
    void Promise.all([resource.reload(), latestResource.reload(), ...(selected ? [detailResource.reload()] : [])])
  }
  useReloadWhenShown(active, reloadRecords)
  const latestReloadRecords = useRef(reloadRecords)
  useEffect(() => { latestReloadRecords.current = reloadRecords })
  useEffect(() => {
    if (!active) return
    // 进页、再显示的这一下本来就在读，从这里起算。
    lastRead.current = performance.now()
    function foreground() {
      if (document.visibilityState === 'hidden' || performance.now() - lastRead.current < recordsForegroundReloadMs) return
      latestReloadRecords.current()
    }
    window.addEventListener('focus', foreground)
    document.addEventListener('visibilitychange', foreground)
    return () => {
      window.removeEventListener('focus', foreground)
      document.removeEventListener('visibilitychange', foreground)
    }
  }, [active])
  const view = (session: Session) => {
    setShowAllMessages(false)
    setSelected(session)
  }
  const capabilityOf = (session: Session) => resource.data?.capabilities[session.provider]
  const capability = selected ? capabilityOf(selected) : undefined
  // 装好的名单还没检测完时不算「没装」：宁可让它照旧去打开，也不把按钮错按灰。
  const notInstalled = (session: Session) =>
    installedProviders !== undefined && !installedProviders.includes(session.provider)
  /**
   * 归档、恢复只有 Codex 有（看 capability）。行上的「…」、归档行的「恢复」和详情里的按钮都走这里，
   * 所以动的是点到的那一条，不是详情里开着的那条。
   */
  const archive = (session: Session) => {
    if (!capabilityOf(session)?.operations[session.archived ? 'restore' : 'archive']) return
    const title = sessionTitle(session)
    void operation.execute(
      'archive',
      async () => {
        if (session.archived) await api.restoreSession(session.nativeId)
        else await api.archiveSession(session.nativeId)
        setSelected(null)
        // 归档会把记录移出 CLI 自己的目录,那个文件夹的「最近一条」也就变了,
        // 所以按钮的判断依据要跟着一起重读。首页「最近」缓存着同一份列表，
        // 不通知它的话一分钟内回首页还看得到刚归档的那条（#544）。
        onSessionsChanged?.()
        await Promise.all([resource.reload(), latestResource.reload()])
      },
      session.archived ? `已恢复「${title}」` : `已归档「${title}」`,
    )
  }
  const [deleting, setDeleting] = useState<Session | null>(null)
  /**
   * 彻底删除只传会话 id,要删哪些文件由主进程重新找出来并校验。删掉之后和归档
   * 一样,那个文件夹的「最近一条」变了,首页「最近」也要作废(#544)。
   */
  const remove = () => {
    const target = deleting
    if (!target || !capabilityOf(target)?.operations.delete) return
    void operation.execute(
      'delete-session',
      async () => {
        try {
          await api.deleteProviderSession(target.id)
        } finally {
          setDeleting(null)
        }
        setSelected(null)
        onSessionsChanged?.()
        await Promise.all([resource.reload(), latestResource.reload()])
      },
      `已删除「${sessionTitle(target)}」`,
    )
  }
  const canExport = (session: Session) =>
    Boolean(capabilityOf(session)?.operations.exportMarkdown) && session.detailAvailable
  const exportSession = (session: Session) => {
    if (!canExport(session)) return
    void operation.execute(
      'export',
      () => api.exportProviderSession(session.id),
      (result) =>
        result
          ? {
              text: `已导出 ${result.messages} 条消息：${result.outputPath}${result.truncated ? '；源记录不完整，已在文件中标记' : ''}`,
              revealPath: result.outputPath,
            }
          : null,
    )
  }
  /**
   * 「接着聊」点下去先读一份最新的对一次（已知4，同首页 resumeRecent）：窗口回到前面时的那次重读是
   * 异步的，从终端直接点回来，这一下用的还是旧列表。点的这条已经不是它那个文件夹最近的了，就换上新列表、
   * 这次不打开，按钮自己挪到该挂的那条上。返回 false = 不打开；读不到就照旧打开。
   */
  const recheckResume = async (session: Session): Promise<boolean> => {
    const fresh = await latestLoad().catch(() => null)
    if (!fresh) return true
    latestResource.setData(fresh)
    if (resumeStillLatest(session, fresh.items)) return true
    // 刚聊的那条多半也该出现在这一页上，列表一起换。
    void resource.reload()
    return false
  }
  /**
   * 各家 CLI 的续接参数都是「按当前工作目录找最近一条」,不是按会话 id 挑。
   * 所以按钮只长在每个(工具 × 目录)组合最近的那一条上(resumable),点到的
   * 就是接上的。Codex 另外带上这条记录的 id:它自己按目录找时还按连接名过滤,
   * 切过账号就找不到(resumeLaunchChoice)。归档过的记录已经被移出 CLI
   * 自己的目录,它找不到,所以对归档记录置灰。
   */
  const resume = (session: Session) => {
    const provider = session.provider
    // 列表里本来就不收已下线工具的记录；万一漏进来一条，也不替它打开。
    if (!resumable.has(session.id) || session.archived || session.cwdExists === false || !isProvider(provider))
      return
    // 「…」里的「接着聊」不置灰，点了说清楚为什么接不上；行上和详情里的按钮是灰的，悬停有同一句。
    if (notInstalled(session)) {
      toast.show(`要先装好 ${providerName(provider)} 才能接着聊`, 'warn')
      return
    }
    void operation.execute(
      'resume',
      async () => {
        // 先对一次再过下面那几道关：问完话再说「这次不打开」，客户等于白答了一遍。
        if (resumeNeedsRecheck(session) && !(await recheckResume(session))) return null
        // 首页「接着聊」打开前要过的那几道关，这里以前一道都没过（第四十批 B）。不往下走就和
        // 问话框里点了关掉一样：什么都不打开，不报错，也不说「已打开」。
        if (beforeResume && !(await beforeResume(provider))) return null
        try {
          const choice = resumeLaunchChoice(session)
          const result = await (typeof choice === 'object'
            ? api.launchCli(provider, session.cwd, 'resumeLast', choice.resumeSessionId)
            : api.launchCli(provider, session.cwd, 'resumeLast'))
          // 选了「先不打开」就什么都没开，首页那份「最近」也没变。
          if (!launchDeclined(result)) {
            onSessionsChanged?.()
            // 终端里这就要多出新的对话，从终端回来头一次切回窗口不管隔了多久都重读。
            lastRead.current = Number.NEGATIVE_INFINITY
          }
          return result
        } catch (cause) {
          // 列表出来之后目录才被删掉的那一瞬间:按钮还亮着,但已经接不上了。
          // 主进程那句「工作目录不存在,请重新选择」是给目录选择器写的,这里
          // 没有选择器可退(换个目录就接不上这条对话),所以换一句实话,并把
          // 列表重读一遍让这一行跟着置灰。
          if (!isMissingWorkspace(cause)) throw cause
          void Promise.all([resource.reload(), latestResource.reload()])
          throw new Error('这条记录的文件夹已经不在了，接不上上次的对话。')
        }
      },
      // 项目文件夹里的设置会盖过当前账号时，那句提醒跟在成功提示后面，不另弹一条。
      (result) =>
        result === null
          ? null
          : resumeSessionNotice(result, providerName(session.provider), session.cwd),
    )
  }
  /** 行上和详情里「接着聊」那颗按钮的悬停说明：按不动时说为什么。 */
  const resumeTitle = (session: Session) =>
    session.cwdExists === false
      ? '这条记录的文件夹已经不在了，接不上上次的对话'
      : notInstalled(session)
        ? `要先装好 ${providerName(session.provider)}`
        : '接着这个文件夹里最近一次对话'
  /**
   * 只传会话 id,不传路径:工作目录由主进程从记录里取并校验(必须是真实存在的
   * 文件夹),界面没有办法让资源管理器去打开别的位置。目录已经不在的那一行按钮
   * 是灰的,这里再挡一道,免得列表出来之后目录才被删掉。
   */
  const openDirectory = (session: Session) => {
    if (!session.cwd || session.cwdExists === false) return
    void operation.execute(
      'open-directory',
      async () => {
        try {
          return await api.openProviderSessionDirectory(session.id)
        } catch (cause) {
          // 目录刚被删掉的那一瞬间:按钮还亮着,主进程已经打不开了。顺手把列表
          // 重读一遍,让这一行跟着置灰。
          void Promise.all([resource.reload(), latestResource.reload()])
          throw cause
        }
      },
      `已打开 ${session.cwd}`,
    )
  }
  const copySessionId = (session: Session) => {
    void navigator.clipboard.writeText(session.nativeId).then(
      () => toast.show('会话 ID 已复制', 'ok'),
      () => toast.show('没复制上，请手动选中这行文字复制。', 'warn'),
    )
  }
  const busy = Boolean(operation.busy)
  /** 行上「…」里的几项：按这一家的能力给，能力里没有的一项就不出现（Claude Code、Grok CLI 没有归档）。 */
  const rowMenu = (session: Session, canResume: boolean): Array<MenuItem | 'divider'> => {
    const missingWorkspace = session.cwdExists === false
    const operations = capabilityOf(session)?.operations
    const items: Array<MenuItem | 'divider'> = []
    if (canResume)
      items.push({ label: '接着聊', icon: Play, disabled: busy || missingWorkspace, onSelect: () => resume(session), testId: `sessions-menu-resume-${session.id}` })
    if (session.cwd)
      items.push({ label: '打开文件夹', icon: FolderOpen, disabled: busy || missingWorkspace, onSelect: () => openDirectory(session), testId: `sessions-open-directory-${session.id}` })
    items.push({ label: '导出对话', icon: Download, disabled: busy || !canExport(session), onSelect: () => exportSession(session), testId: `sessions-menu-export-${session.id}` })
    if (operations?.[session.archived ? 'restore' : 'archive'])
      items.push({ label: session.archived ? '恢复到记录' : '归档', icon: Archive, disabled: busy, onSelect: () => archive(session), testId: `sessions-menu-archive-${session.id}` })
    if (operations?.delete)
      items.push('divider', { label: '彻底删除', icon: Trash2, danger: true, disabled: busy, onSelect: () => setDeleting(session), testId: `sessions-menu-delete-${session.id}` })
    return items
  }
  const messages = detail?.messages ?? []
  const shownMessages = showAllMessages ? messages : messages.slice(0, transcriptPreviewCount)
  const hiddenMessages = messages.length - shownMessages.length
  const selectedCount = selected?.messageCount ?? detail?.messageStats.total ?? null
  return (
    <section
      className="v2-page"
      data-page-id="sessions"
      data-testid="page-sessions"
    >
      <PageHead
        title="记录"
        actions={
          <Button
            variant="ghost"
            icon={RefreshCw}
            loading={resource.loading}
            aria-label="重新加载"
            title="重新加载"
            onClick={() => void Promise.all([resource.reload(), latestResource.reload()])}
            testId="sessions-reload"
          />
        }
      />
      <div className="v2-filter-bar">
        <Chips
          label="按工具筛选"
          value={provider}
          options={[
            { value: 'all', label: '全部', count: counts?.all, testId: 'sessions-tool-all' },
            ...providerOptions.map((option) => ({
              value: option.value,
              label: option.label,
              count: counts && isProvider(option.value) ? counts[option.value] : undefined,
              leading: <BrandIcon tool={option.value} size={16} />,
              testId: `sessions-tool-${option.value}`,
            })),
          ]}
          onChange={(value) => {
            if (!isProvider(value) && value !== 'all') return
            setProvider(value)
            setPage(1)
            // 上一个工具的红条不跟到下一个工具上。
            operation.clear()
          }}
        />
        <SearchInput
          value={query}
          onChange={(value) => {
            setQuery(value)
            setPage(1)
          }}
          placeholder="搜索标题、文件夹或模型"
          testId="sessions-search"
        />
      </div>
      <ResultNotice
        {...operation}
        onReveal={(path) => api.revealExportedFile(path)}
      />
      <Card padding="none">
        <ListState
          page="sessions"
          noun="记录"
          {...resource}
          error={resource.error}
          count={resource.data?.items.length ?? 0}
          query={query}
          filtered={Boolean(query)}
          retry={() => void resource.reload()}
          clear={() => setQuery('')}
          emptyDescription="在首页打开工具，聊过的会话会出现在这里。"
          searchTitle="没有找到相关记录"
          searchDescription="换个关键词，或者切换到「全部」再看看。"
          action={
            onOpenTools && (
              <Button size="sm" onClick={onOpenTools} testId="sessions-empty-open-tools">
                去打开工具
              </Button>
            )
          }
        >
          <table className="v2-sessions-table">
            <thead>
              <tr>
                <th scope="col">标题</th>
                <th scope="col">工具</th>
                <th scope="col">项目文件夹</th>
                <th scope="col">最后活动</th>
                <th scope="col"><span className="xm-visually-hidden">操作</span></th>
              </tr>
            </thead>
            <tbody>
              {resource.data?.items.map((session) => {
                // 文件夹被删掉或搬走之后,CLI 按目录找回对话这条路就断了。按钮留在
                // 原位但按不动,悬停说一句为什么——把它藏起来的话,用户只会觉得
                // 「昨天还有的按钮今天没了」。
                const missingWorkspace = session.cwdExists === false
                const canResume = resumable.has(session.id) && !session.archived
                const title = sessionTitle(session)
                const operations = capabilityOf(session)?.operations
                return (
                  <tr key={session.id} data-testid={`sessions-row-${session.id}`}>
                    <td>
                      <button type="button" className="v2-sessions-open" onClick={() => view(session)} data-testid={`sessions-view-${session.id}`}>
                        <strong>{title}</strong>
                        <small>{sessionRowMeta(session)}</small>
                      </button>
                    </td>
                    <td>
                      <span className="v2-sessions-tool"><BrandIcon tool={session.provider} size={18} />{providerName(session.provider)}</span>
                    </td>
                    <td className="v2-sessions-dir">
                      {missingWorkspace ? (
                        <span className="v2-sessions-dir-gone" title="这个文件夹已经不在了" data-testid={`sessions-missing-${session.id}`}>
                          <TriangleAlert size={13} aria-hidden="true" />
                          <span className="xm-visually-hidden">这个文件夹已经不在了：</span>
                          <span>{session.cwd || '未记录文件夹'}</span>
                        </span>
                      ) : (
                        <span title={session.cwd || undefined}>{session.cwd || '未记录文件夹'}</span>
                      )}
                    </td>
                    <td className="v2-sessions-when"><RelativeTime value={session.updatedAt} /></td>
                    <td className="v2-sessions-actions">
                      {session.archived && operations?.restore ? (
                        <Button size="xs" disabled={busy} onClick={() => archive(session)} testId={`sessions-restore-${session.id}`}>
                          恢复
                        </Button>
                      ) : canResume ? (
                        <Button
                          size="xs"
                          icon={Play}
                          disabled={busy || missingWorkspace || notInstalled(session)}
                          onClick={() => resume(session)}
                          title={resumeTitle(session)}
                          testId={`sessions-resume-${session.id}`}
                        >
                          接着聊
                        </Button>
                      ) : null}
                      <Menu
                        label={`「${title}」更多操作`}
                        testId={`sessions-menu-${session.id}`}
                        anchor={<Button size="sm" variant="ghost" icon={MoreHorizontal} aria-label={`「${title}」更多操作`} />}
                        items={rowMenu(session, canResume)}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </ListState>
      </Card>
      <Pagination
        page={page}
        total={resource.data?.total ?? 0}
        failed={Boolean(resource.error)}
        onChange={setPage}
      />
      <Dialog
        open={Boolean(selected)}
        title={selected?.title || '记录详情'}
        width={640}
        onClose={() => {
          setSelected(null)
        }}
        testId="session-detail-drawer"
        footer={
          selected && (
            <>
              {capability?.operations.delete && (
                <span className="v2-dialog-footer-start">
                  <Button
                    variant="danger"
                    icon={Trash2}
                    disabled={busy}
                    onClick={() => setDeleting(selected)}
                    testId="session-detail-delete"
                  >
                    彻底删除
                  </Button>
                </span>
              )}
              <Button
                variant="ghost"
                icon={Download}
                title="导出成文件"
                disabled={!canExport(selected) || busy}
                onClick={() => exportSession(selected)}
                testId="session-detail-export"
              >
                导出对话
              </Button>
              {!selected.archived && capability?.operations.archive && (
                <Button variant="ghost" icon={Archive} disabled={busy} onClick={() => archive(selected)}>
                  归档
                </Button>
              )}
              <Button onClick={() => setSelected(null)}>关闭</Button>
              {selected.archived
                ? capability?.operations.restore && (
                    <Button variant="primary" disabled={busy} onClick={() => archive(selected)} testId="session-detail-restore">
                      恢复到记录
                    </Button>
                  )
                : resumable.has(selected.id) && (
                    <Button
                      variant="primary"
                      icon={Play}
                      disabled={busy || selected.cwdExists === false || notInstalled(selected)}
                      onClick={() => resume(selected)}
                      title={resumeTitle(selected)}
                      testId="session-detail-resume"
                    >
                      接着聊
                    </Button>
                  )}
            </>
          )
        }
      >
        {selected && (
          <>
            <div className="v2-session-detail-head">
              <span className="v2-sessions-tool"><BrandIcon tool={selected.provider} size={18} />{providerName(selected.provider)}</span>
              <Pill>{selected.model || '未记录模型'}</Pill>
              {selected.archived && <Pill>已归档</Pill>}
            </div>
            {selected.cwdExists === false && (
              <p className="v2-session-detail-gone" role="note">
                <TriangleAlert size={15} aria-hidden="true" />
                <span>项目文件夹 {selected.cwd} 已经不在了，接不上上次的对话。</span>
              </p>
            )}
            <ResultNotice
              {...operation}
              onReveal={(path) => api.revealExportedFile(path)}
            />
            <dl className="v2-session-detail-kv">
              <div>
                <dt>项目文件夹</dt>
                <dd>
                  <span className="xm-mono">{selected.cwd || '未记录文件夹'}</span>
                  {Boolean(selected.cwd) && selected.cwdExists !== false && (
                    <button type="button" className="v2-link-button" disabled={busy} onClick={() => openDirectory(selected)} data-testid="session-detail-open-directory">
                      打开
                    </button>
                  )}
                </dd>
              </div>
              <div>
                <dt>消息</dt>
                <dd>{selectedCount === null ? '未知' : `${selectedCount} 条`}</dd>
              </div>
              <div>
                <dt>开始于</dt>
                <dd><RelativeTime value={selected.createdAt} /></dd>
              </div>
              <div>
                <dt>最后活动</dt>
                <dd><RelativeTime value={selected.updatedAt} /></dd>
              </div>
              <div>
                <dt>会话 ID</dt>
                <dd>
                  <span className="xm-mono">{selected.nativeId}</span>
                  <Button size="xs" variant="ghost" icon={Copy} aria-label="复制会话 ID" title="复制会话 ID" onClick={() => copySessionId(selected)} testId="session-detail-copy-id" />
                </dd>
              </div>
            </dl>
          </>
        )}
        {selected && !selected.detailAvailable && (
          <p className="v2-transcript-missing" data-testid="session-detail-summary-only">
            这条记录只有摘要，对话原文已经不在这台电脑上了
          </p>
        )}
        <ResultNotice error={detailResource.error} detail={detailResource.detail} />
        {detailResource.error && (
          <Button
            size="sm"
            icon={RefreshCw}
            loading={detailResource.loading}
            onClick={() => void detailResource.reload()}
          >
            重试读取
          </Button>
        )}
        {/* 回到窗口时连详情一起重读：正读着的对话先摆着、读回来再换，不闪成「正在读取」，展开的「看全部」也不收回去。 */}
        {detailResource.loading && !detail ? (
          <p role="status">正在读取对话…</p>
        ) : (
          shownMessages.length > 0 && (
            <section className="v2-session-transcript">
              <h3>对话开头</h3>
              <div className="v2-transcript">
                {shownMessages.map((message, i) => (
                  <div className={message.role === 'user' ? 'v2-transcript-me' : 'v2-transcript-ai'} key={i}>
                    {message.role !== 'user' && <BrandIcon tool={selected?.provider} size={14} />}
                    <p>
                      <span className="xm-visually-hidden">
                        {message.role === 'user' ? '你' : message.role === 'assistant' ? 'AI' : message.role}：
                      </span>
                      {message.text}
                    </p>
                  </div>
                ))}
                {hiddenMessages > 0 && (
                  <p className="v2-transcript-more">
                    后面还有 {hiddenMessages} 条消息
                    <Button size="xs" variant="ghost" onClick={() => setShowAllMessages(true)} testId="session-detail-show-all">
                      看全部
                    </Button>
                  </p>
                )}
              </div>
            </section>
          )
        )}
        {detail?.messagesTruncated && (
          <Notice
            tone="warn"
            title="已限制预览长度"
            body="完整内容请通过导出记录查看。"
          />
        )}
      </Dialog>
      <Confirm
        open={Boolean(deleting)}
        title={`彻底删除「${deleting ? sessionTitle(deleting) : ''}」？`}
        body={
          <>
            <p>
              会把这条对话从这台电脑上删掉，里面粘贴过的代码、密码和聊天内容会一起消失，删了就找不回来。
            </p>
            <p>只删这一条，不影响别的记录和你的项目文件。想留一份的话，先点「导出对话」。</p>
          </>
        }
        okLabel="彻底删除"
        cancelLabel="先不删"
        danger
        loading={operation.busy === 'delete-session'}
        onClose={() => setDeleting(null)}
        onOk={remove}
        testId="session-delete-confirm"
      />
    </section>
  )
}
