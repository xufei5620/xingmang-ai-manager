// 反馈与客服页（#1070 第 11 步，从 pages-maintenance.tsx 原样搬来）：留言反馈、运行日志、预览与复制/导出反馈报告，
// 右边那张「找客服」卡。pages-maintenance.tsx 照旧转出这里的导出名；各业务页共用的参数类型在 business-actions.ts。
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FolderOpen,
  HeartPulse,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import {
  Button,
  Card,
  Chips,
  Confirm,
  Dialog,
  Input,
  Notice,
  PageHead,
  Pill,
  SearchInput,
  Segment,
  Switch,
  Tabs,
  Textarea,
  useToast,
} from '../../ui'
import {
  displayDate,
  ListState,
  ResultNotice,
  type OperationNotice,
  useOperation,
  useReloadWhenShown,
  useResource,
} from '../../business-common'
import { feedbackTabs, type FeedbackTabValue } from '../../registry/business'
import { redactSecretPatterns } from '../../../../electron/redaction-patterns'
import { SupportIdentity } from '../app/SupportIdentity'
import {
  anyRuntimeLogValue,
  filterRuntimeLogs,
  formatRuntimeLogEntry,
  hasRuntimeLogFilter,
  installRuntimeLogArea,
  isCurrentBootEntry,
  runtimeLogArea,
  runtimeLogAreaLabel,
  runtimeLogDisplayMessage,
  runtimeLogSourceOptions,
  runtimeLogTimeText,
  runtimeLogWriteNotice,
} from '../app/runtime-log-filter'
import type { V2Bridge } from '../../types'
import type {
  FeedbackReportCopyResult,
  FeedbackReportExportResult,
  RuntimeLogSnapshot,
} from '../../../../electron/ipc-contract'
import type { BusinessActions } from '../../business-actions'

/** 与上面筛选条的说法一致；英文级别名只进导出的报告。 */
const runtimeLogLevelLabels: Readonly<Record<string, string>> = {
  error: '错误',
  warn: '提醒',
  info: '信息',
  debug: '调试',
}
/** 反馈页一次读多少条运行日志。 */
const runtimeLogLimit = 500
/** 日志列表先铺这么多条，最后一行「再显示 100 条」。 */
const runtimeLogPage = 100

// 预览过了 30 分钟，主进程会按最新日志重生成再复制/导出；提示要让客户知道拿到的是新的那份。
export function feedbackCopyNotice(result: FeedbackReportCopyResult) {
  return result.regenerated
    ? '报告已更新到最新日志并复制，发给客服就行'
    : '报告已复制'
}

export function feedbackExportNotice(
  result: FeedbackReportExportResult | null,
): OperationNotice | null {
  if (!result) return null
  return {
    text: result.regenerated
      ? `报告已更新到最新日志并导出：${result.outputPath}`
      : `反馈报告已导出：${result.outputPath}`,
    revealPath: result.outputPath,
  }
}

/** 留言的类型，复制给客服时写在第一行。 */
const feedbackTypes = [
  { value: 'bug', label: '遇到问题' },
  { value: 'idea', label: '功能建议' },
  { value: 'other', label: '其他' },
]

/**
 * 「复制给客服」复制出去的那一段（v4 第 10 批按问 5：不往服务器提交，客户自己发给客服）：类型、客户写的、
 * 联系方式、身份行、最近一次出错；勾了「附带诊断报告」再接上整份反馈报告（主进程已经脱敏）。
 * 客户自己写的那几行再过一遍打码表（I13）：描述里偶尔会贴上 sk-… 或 Bearer …。
 */
export function buildFeedbackMessage(input: {
  type: string
  description: string
  contact: string
  identity?: string
  lastFailure?: string
  report?: string
  /** 勾了「附带诊断报告」但这次没生成出来：末尾说一句，客服不会当成客户忘了勾。缺省 = 不说。 */
  reportMissing?: boolean
}): string {
  const lines = [`留言反馈 · ${input.type}`, input.description.trim()]
  const contact = input.contact.trim()
  if (contact) lines.push(`联系方式：${contact}`)
  if (input.identity) lines.push(input.identity)
  if (input.lastFailure) lines.push(input.lastFailure)
  if (input.reportMissing) lines.push('诊断报告：这次没生成出来')
  const head = redactSecretPatterns(lines.join('\n'))
  return input.report ? `${head}\n\n${input.report}` : head
}

/** 运行日志页签上那个红色角标：这次打开软件以后记下的错误条数（以前打开时留下的旧错误不算）。 */
export function feedbackErrorCount(snapshot: Pick<RuntimeLogSnapshot, 'entries' | 'currentProcessId' | 'startedAt'> | null | undefined): number {
  if (!snapshot) return 0
  return snapshot.entries.filter((entry) => entry.level === 'error' && isCurrentBootEntry(entry, snapshot)).length
}

export function FeedbackPage({
  api,
  navigate,
  support,
  feedbackRequest,
  ordersVisible,
  active,
}: { api: V2Bridge } & BusinessActions) {
  const load = useCallback(() => api.getRuntimeLogs(runtimeLogLimit), [api])
  const resource = useResource(load)
  // 错误框「查看日志」把人带回这一页时，刚出的那个错要在「运行日志」最上面，不用再点「刷新」。
  useReloadWhenShown(active, () => void resource.reload())
  const operation = useOperation()
  const toast = useToast()
  const [tab, setTab] = useState<FeedbackTabValue>(feedbackRequest?.tab ?? 'form')
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState(anyRuntimeLogValue)
  const [source, setSource] = useState(feedbackRequest?.installLog ? installRuntimeLogArea : anyRuntimeLogValue)
  const [onlyCurrentBoot, setOnlyCurrentBoot] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  // 刚点过「清除」：列表空着时说「日志已清空」，不说「还没有运行日志」。下一次读到日志就不再算。
  const [cleared, setCleared] = useState(false)
  const [type, setType] = useState(feedbackTypes[0].value)
  const [description, setDescription] = useState('')
  const [descriptionError, setDescriptionError] = useState('')
  const [contact, setContact] = useState('')
  const [attachReport, setAttachReport] = useState(true)
  const formRef = useRef<HTMLElement>(null)
  // 外面点名要看「运行日志」（错误框「查看日志」、顶部搜索、帮助弹窗）：页面早就挂着，只是藏着，换到那个页签；
  // 装工具没装上时来源先选好「安装与更新」。别的筛选条件清掉，免得刚出的那一条被筛走。
  const handledRequest = useRef(feedbackRequest?.sequence)
  useEffect(() => {
    if (!feedbackRequest || handledRequest.current === feedbackRequest.sequence) return
    handledRequest.current = feedbackRequest.sequence
    setTab(feedbackRequest.tab)
    if (feedbackRequest.tab !== 'log') return
    setQuery('')
    setLevel(anyRuntimeLogValue)
    setOnlyCurrentBoot(false)
    setSource(feedbackRequest.installLog ? installRuntimeLogArea : anyRuntimeLogValue)
  }, [feedbackRequest])
  // 「再显示 100 条」点到第几页；换了筛选条件就从头的 100 条重新开始，改回原来的条件也不接着上次的页数。
  const filterKey = JSON.stringify([level, source, query, onlyCurrentBoot])
  const [shown, setShown] = useState({ key: filterKey, count: runtimeLogPage })
  if (shown.key !== filterKey) setShown({ key: filterKey, count: runtimeLogPage })
  const visibleCount = shown.key === filterKey ? shown.count : runtimeLogPage
  const [report, setReport] = useState<Awaited<
    ReturnType<V2Bridge['getFeedbackReport']>
  > | null>(null)
  const [clearOpen, setClearOpen] = useState(false)
  const entries = resource.data?.entries ?? []
  if (cleared && entries.length) setCleared(false)
  const filter = {
    level,
    source,
    query,
    onlyCurrentBoot,
    currentProcessId: resource.data?.currentProcessId ?? -1,
    startedAt: resource.data?.startedAt ?? '',
  }
  const list = filterRuntimeLogs(entries, filter)
  const writeNotice = runtimeLogWriteNotice(resource.data?.writeFailure)
  const errorCount = feedbackErrorCount(resource.data)
  const now = Date.now()
  const shownLogs = list.slice(0, visibleCount).map((entry) => ({ entry, time: runtimeLogTimeText(entry.timestamp, now) }))
  // 去年的条目时间带年份，比平常长一截：有一条带年份，各行的时间那一格一起放宽，才对得齐。
  const logRowClass = shownLogs.some(({ time }) => time.includes('年')) ? 'v2-feedback-log has-year' : 'v2-feedback-log'
  const resetFilters = () => {
    setQuery('')
    setLevel(anyRuntimeLogValue)
    setSource(anyRuntimeLogValue)
    setOnlyCurrentBoot(false)
  }
  const preview = () =>
    void operation.execute(
      'preview',
      async () => setReport(await api.getFeedbackReport()),
      '',
    )
  const typeLabel = feedbackTypes.find((entry) => entry.value === type)?.label ?? feedbackTypes[0].label
  const copyToSupport = () => {
    if (!description.trim()) {
      setDescriptionError('请先描述一下发生了什么')
      formRef.current?.querySelector('textarea')?.focus()
      return
    }
    void operation.execute('send', async () => {
      // 每次复制都现取一份报告：几分钟前预览的那份里没有刚才那次出错。报告生成不出来时
      // 照样把客户写的复制出去、打开客服窗口，不能让一份报告把整条留言卡住（#1104 第 1 条）。
      let attached: string | undefined
      let reportMissing = false
      if (attachReport) {
        try {
          attached = (await api.getFeedbackReport()).text
        } catch {
          reportMissing = true
        }
      }
      await navigator.clipboard.writeText(buildFeedbackMessage({
        type: typeLabel,
        description,
        contact,
        identity: support?.identity,
        lastFailure: support?.lastFailure,
        report: attached,
        reportMissing,
      }))
      support?.open()
      if (reportMissing) toast.show('诊断报告没生成出来，只复制了你写的内容，发给客服就行', 'warn')
      return reportMissing
    }, (reportMissing) => reportMissing ? '' : '已复制，发给客服就行')
  }
  const tries = [
    { id: 'health', title: '工具装不上，或者打开就闪退', action: '先跑一遍检查', go: () => navigate?.('health') },
    ...(ordersVisible === false ? [] : [{ id: 'orders', title: '付了款，余额没变', action: '看我的订单', go: () => navigate?.('account', 'orders') }]),
    { id: 'tutorial', title: '不知道从哪里开始用', action: '看教程', go: () => navigate?.('tutorial') },
    { id: 'mcp', title: '想把 AI 连上浏览器或文件夹', action: '去外接工具', go: () => navigate?.('mcp') },
  ]
  const form = (
    <div className="v2-fb-grid">
      <section
        ref={formRef}
        className="v2-acct-card v2-fb-form"
        aria-label="留言反馈"
        data-testid="feedback-form"
      >
        <div className="v2-fb-field">
          <span id="feedback-type-label">类型</span>
          <Segment options={feedbackTypes} value={type} onChange={setType} label="类型" testId="feedback-type" />
        </div>
        <Textarea
          label="描述一下发生了什么"
          rows={5}
          value={description}
          placeholder="比如：点「打开」后终端闪一下就关了"
          error={descriptionError || undefined}
          onChange={(event) => {
            setDescription(event.target.value)
            if (descriptionError && event.target.value.trim()) setDescriptionError('')
          }}
          testId="feedback-description"
        />
        <Input
          label="联系方式（可选）"
          value={contact}
          placeholder="微信号或邮箱，方便我们回复你"
          onChange={(event) => setContact(event.target.value)}
          testId="feedback-contact"
        />
        <div className="v2-fb-attach">
          <div className="v2-fb-attach-text">
            <strong id="feedback-attach-label">附带诊断报告</strong>
            <p>已自动隐去密钥和个人路径<button type="button" className="v2-fb-link" onClick={preview} data-testid="feedback-attach-preview">预览报告</button></p>
          </div>
          <Switch checked={attachReport} onChange={setAttachReport} aria-label="附带诊断报告" testId="feedback-attach" />
        </div>
        <div className="v2-fb-submit">
          <Button
            variant="primary"
            icon={Copy}
            loading={operation.busy === 'send'}
            onClick={copyToSupport}
            testId="feedback-send"
          >
            复制给客服
          </Button>
        </div>
      </section>
      <div className="v2-fb-side">
        {support && (
          <section className="v2-acct-card is-focus v2-fb-support" data-testid="feedback-support-card">
            <h2>找客服</h2>
            <div className="v2-fb-support-qr">
              {support.qr && <img src={support.qr} alt="微信客服二维码" />}
              <div>
                <strong>微信扫码添加客服</strong>
                <p>装不上、付了没到账，都可以问。</p>
                {support.qrFallback && <p role="alert" data-testid="feedback-support-qr-fallback">{support.qrFallback}</p>}
                <button type="button" className="v2-fb-link" onClick={support.open} data-testid="feedback-support-open">在浏览器打开</button>
              </div>
            </div>
            <SupportIdentity line={support.identity} lastFailure={support.lastFailure} onCopy={support.copyIdentity} testIdPrefix="feedback-support" />
            <button
              type="button"
              className="v2-fb-link"
              onClick={preview}
              disabled={operation.busy === 'preview'}
              data-testid="feedback-preview"
            >
              预览反馈报告
            </button>
          </section>
        )}
        <section className="v2-acct-well v2-fb-try" data-testid="feedback-try">
          <h2>先试试这些</h2>
          {tries.map((entry) => (
            <button key={entry.id} type="button" className="v2-fb-try-item" onClick={entry.go} data-testid={`feedback-try-${entry.id}`}>
              <span>
                <span>{entry.title}</span>
                <small>{entry.action}</small>
              </span>
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          ))}
        </section>
      </div>
    </div>
  )
  const log = (
    <div className="v2-fb-log">
      {writeNotice ? (
        <Notice
          tone="warn"
          title={writeNotice.title}
          body={writeNotice.body}
          testId="feedback-log-write-failed"
          actions={
            navigate ? (
              <Button size="sm" icon={HeartPulse} onClick={() => navigate('health')}>
                去检查页
              </Button>
            ) : undefined
          }
        />
      ) : null}
      <div className="v2-fb-log-tools">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="搜索日志"
          testId="feedback-search"
        />
        <Segment
          options={[
            { value: anyRuntimeLogValue, label: '全部' },
            { value: 'error', label: '错误' },
            { value: 'warn', label: '提醒' },
            { value: 'info', label: '信息' },
          ]}
          value={level}
          onChange={setLevel}
        />
        <Switch
          checked={onlyCurrentBoot}
          onChange={setOnlyCurrentBoot}
          label="只看本次启动"
          testId="feedback-current-boot"
        />
        <span className="v2-fb-log-gap" />
        <Button
          size="sm"
          variant="ghost"
          icon={RefreshCw}
          aria-label="刷新"
          title="刷新"
          loading={resource.loading && Boolean(resource.data)}
          onClick={() => void resource.reload()}
          testId="feedback-refresh"
        />
        <Button
          size="sm"
          icon={FolderOpen}
          onClick={() =>
            void operation.execute(
              'directory',
              () => api.openRuntimeLogDirectory(),
              '',
            )
          }
        >
          打开日志文件夹
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!entries.length || Boolean(resource.error)}
          onClick={() => setClearOpen(true)}
          testId="feedback-clear"
        >
          清除日志
        </Button>
      </div>
      <Chips
        label="按来源筛选"
        options={runtimeLogSourceOptions(resource.data?.entries, source)}
        value={source}
        onChange={setSource}
        testId="feedback-source"
      />
      <Card padding="none" testId="feedback-log-list">
        <ListState
          page="feedback"
          noun="运行日志"
          loading={resource.loading}
          error={resource.error}
          count={list.length}
          query={query}
          filtered={hasRuntimeLogFilter(filter)}
          retry={() => void resource.reload()}
          clear={resetFilters}
          emptyTitle={cleared ? '日志已清空' : undefined}
          emptyDescription={cleared ? '之后的操作会重新记录在这里。' : '软件运行时的事件会记录在这里。'}
          filteredTitle="没有符合条件的日志"
          filteredDescription="换个筛选条件，或者关掉「只看本次启动」。"
          errorDescription="点「重新加载」再试；还不行，点「打开日志文件夹」直接看日志文件。"
        >
          {shownLogs.map(({ entry, time }) => {
            const open = openId === entry.id
            const detailId = `feedback-log-detail-${entry.id}`
            return (
              <div key={entry.id} className={open ? 'v2-feedback-log-entry is-open' : 'v2-feedback-log-entry'}>
                <button
                  type="button"
                  className={logRowClass}
                  aria-expanded={open}
                  aria-controls={open ? detailId : undefined}
                  onClick={() => setOpenId(open ? null : entry.id)}
                  data-testid={`feedback-log-${entry.id}`}
                >
                  <time dateTime={entry.timestamp} title={displayDate(entry.timestamp)}>
                    {time}
                  </time>
                  <span className={`v2-feedback-log-level is-${entry.level}`}>
                    <Pill tone={entry.level === 'error' ? 'bad' : entry.level === 'warn' ? 'warn' : 'neutral'}>
                      {runtimeLogLevelLabels[entry.level] ?? entry.level}
                    </Pill>
                  </span>
                  <span className="v2-feedback-log-source">{runtimeLogAreaLabel(entry)}</span>
                  <span className="v2-feedback-log-message">{runtimeLogDisplayMessage(entry.message)}</span>
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
                {open && (
                  <div className="v2-feedback-log-detail" id={detailId} data-testid="feedback-log-detail">
                    <dl className="v2-business-kv">
                      <dt>时间</dt>
                      <dd>{displayDate(entry.timestamp)}</dd>
                      <dt>来源</dt>
                      <dd>{runtimeLogArea(entry)}</dd>
                      <dt>事件</dt>
                      <dd>{entry.event}</dd>
                      <dt>内容</dt>
                      <dd>{entry.message}</dd>
                    </dl>
                    {entry.detail !== undefined && entry.detail !== null && (
                      <pre className="v2-business-code">{JSON.stringify(entry.detail, null, 2)}</pre>
                    )}
                    <div className="v2-feedback-log-detail-actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={Copy}
                        loading={operation.busy === 'copy-entry'}
                        onClick={() =>
                          void operation.execute(
                            'copy-entry',
                            () => navigator.clipboard.writeText(formatRuntimeLogEntry(entry)),
                            '已复制这一条日志',
                          )
                        }
                        testId="feedback-log-copy"
                      >
                        复制这一条
                      </Button>
                      <span>已隐去密钥</span>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
          {list.length > visibleCount && (
            <button
              type="button"
              className="v2-feedback-log-next"
              onClick={() => setShown({ key: filterKey, count: visibleCount + runtimeLogPage })}
              data-testid="feedback-log-next"
            >
              再显示 {runtimeLogPage} 条
            </button>
          )}
        </ListState>
      </Card>
      <p className="v2-fb-foot">日志只保存在这台电脑上。</p>
    </div>
  )
  return (
    <section
      className="v2-page v2-fb"
      data-page-id="feedback"
      data-testid="page-feedback"
    >
      <PageHead title="反馈与客服" />
      <Tabs
        label="反馈与客服"
        items={feedbackTabs.map((entry) => ({
          value: entry.value,
          label: entry.label,
          panelId: `feedback-panel-${entry.value}`,
          meta: entry.value === 'log' && errorCount > 0
            ? <span className="v2-fb-tab-count" data-testid="feedback-error-count">{errorCount}</span>
            : undefined,
        }))}
        value={tab}
        onChange={(value) => setTab(value === 'log' ? 'log' : 'form')}
        testId="feedback-tabs"
      />
      <ResultNotice
        {...operation}
        onReveal={(path) => api.revealExportedFile(path)}
      />
      {/* 两个页签都挂着、只藏不卸：留言写到一半去翻日志，回来字还在，关窗口时也照样提醒没复制出去。 */}
      <div id="feedback-panel-form" role="tabpanel" aria-label="留言反馈" hidden={tab !== 'form'} data-testid="feedback-panel-form">{form}</div>
      <div id="feedback-panel-log" role="tabpanel" aria-label="运行日志" hidden={tab !== 'log'} data-testid="feedback-panel-log">{log}</div>
      <Dialog
        open={Boolean(report)}
        title="预览反馈报告"
        width={640}
        onClose={() => setReport(null)}
        footer={
          <>
            <Button
              icon={Download}
              loading={operation.busy === 'export'}
              onClick={() =>
                report &&
                void operation.execute(
                  'export',
                  async () => {
                    const result = await api.exportFeedbackReport(report.id)
                    if (result?.regenerated) setReport(result.regenerated)
                    return result
                  },
                  feedbackExportNotice,
                )
              }
            >
              导出文件
            </Button>
            <Button
              icon={Copy}
              loading={operation.busy === 'copy'}
              onClick={() =>
                report &&
                void operation.execute(
                  'copy',
                  async () => {
                    const result = await api.copyFeedbackReport(report.id)
                    if (result.regenerated) setReport(result.regenerated)
                    return result
                  },
                  feedbackCopyNotice,
                )
              }
            >
              复制报告
            </Button>
            <Button onClick={() => setReport(null)}>关闭</Button>
          </>
        }
      >
        <p className="v2-fb-privacy" data-testid="feedback-privacy">
          <ShieldCheck size={16} aria-hidden="true" />
          <span>密钥、密码和用户名都已隐去。发送前再看一眼有没有私有项目名称和地址。</span>
        </p>
        {report?.selfChecked === false && navigate && (
          <Notice
            tone="accent"
            icon={HeartPulse}
            title="报告里还没有检查结果"
            body="点「去检查」，等检查页查完再回来复制或导出，客服能少问你几句。"
            actions={
              <Button
                size="sm"
                icon={HeartPulse}
                onClick={() => {
                  setReport(null)
                  navigate('health')
                }}
                testId="feedback-report-go-check"
              >
                去检查
              </Button>
            }
            testId="feedback-report-unchecked"
          />
        )}
        <ResultNotice
          {...operation}
          onReveal={(path) => api.revealExportedFile(path)}
        />
        <Textarea
          aria-label="预览反馈报告"
          readOnly
          rows={14}
          value={report?.text ?? ''}
          testId="feedback-report-text"
        />
      </Dialog>
      <Confirm
        open={clearOpen}
        title="清除全部运行日志？"
        body={
          <>
            <p>清除后找不回来。要发反馈的话，建议先保留日志。</p>
            <p>仅清除运行日志，不会删除工具配置、账号或对话记录。</p>
            <ResultNotice error={operation.error} detail={operation.detail} />
          </>
        }
        okLabel="清除"
        danger
        loading={operation.busy === 'clear'}
        onOk={() =>
          void operation.execute(
            'clear',
            async () => {
              await api.clearRuntimeLogs()
              setClearOpen(false)
              setOpenId(null)
              await resource.reload()
              // 读回来以后才记：先记的话，重读之前那一帧列表里还是旧日志，马上又被当成「读到了新日志」清掉。
              setCleared(true)
            },
            '日志已清除',
          )
        }
        onClose={() => setClearOpen(false)}
        testId="feedback-clear-confirm"
      />
    </section>
  )
}
