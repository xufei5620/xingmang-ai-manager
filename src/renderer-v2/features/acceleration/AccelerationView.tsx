import { useEffect, useState } from 'react'
import { ArrowUpRight, ChevronDown, CircleHelp, Globe2, Pause, Power, RefreshCw, ScrollText } from 'lucide-react'
import { accelerationConflictDescriptions, accelerationConflictNotice, type AccelerationBundleCheck, type AccelerationLine, type AccelerationPhase, type AccelerationState } from '../../../../electron/acceleration-contract'
import { Button, Menu, Notice, type MenuItem } from '../../ui'
// 落点规则只有 operationLogSection 一份：加速这条线没有 tool，按它的口径永远落
// 「反馈与客服」页的整份运行日志，不先筛到「安装与更新」。
import { operationLogSection } from '../../operation-error'
import './acceleration.css'

interface AccelerationViewProps {
  state: AccelerationState | null
  busy: boolean
  signedIn: boolean
  error: string | null
  preview?: boolean
  onStart(): void
  /** 用户看过冲突提示后仍要连接：同一次连接，只是跳过检测。 */
  onStartAnyway(): void
  onStop(): void
  onRefresh(): void
  onLogin(): void
  onHelp(): void
  /** 「查看日志」的出口。红条上那句话现在会说出原因，但真正的现场在运行日志里。 */
  onViewLog?(): void
  lines: AccelerationLine[]
  selectedLineId: string | null
  /** 这条选中的线路是上次用过的、这次自动恢复的，不是用户刚点的。 */
  rememberedLine?: boolean
  linesBusy: boolean
  linesError: string | null
  onSelectLine(lineId: string | null): void
  /** 线路菜单最后一项「重新测速」。 */
  onRefreshLines(): void
  /** 加速文件坏了时「检查加速文件」的进度与结果；null = 还没点过。 */
  bundleCheck?: AccelerationBundleCheck | 'checking' | null
  onRecheckBundle?(): void
  onContactSupport?(): void
  onRelaunch?(): void
}

// 客户看到的是「加速开不了」，要说清是本机文件的事、能自己怎么修。不写「重新安装会
// 保留聊天记录和设置」：安装器是否保留还没实测过。
const bundleDamagedLead = '加速用的文件被删掉或改动了，现在开不了加速。'
const bundleDamagedGuide = '多半是杀毒软件把它当成了可疑文件。'
  + '打开杀毒软件的「隔离区」或「恢复区」，把星芒的文件恢复，并把星芒加入信任，然后点「检查加速文件」。'
  + '也可以重新安装一次星芒，装在原来的位置就行。'

export function bundleDamagedNotice(check: AccelerationBundleCheck | 'checking' | null | undefined): { title: string; body: string | null } {
  if (check === 'repaired') return { title: '加速文件恢复了，重新打开星芒后就能用。', body: null }
  if (check === 'damaged') return { title: '加速文件还是不对。请先在杀毒软件里恢复，或者重新安装一次星芒。', body: bundleDamagedGuide }
  return { title: bundleDamagedLead, body: bundleDamagedGuide }
}

/**
 * 卡上说明行里的时长：「2 小时 40 分」「12 分 5 秒」「40 秒」。原来是 00:12:05 那种表，
 * 并进设置卡以后成了一句话里的半句，按说话的样子写。剩余时长往上取整，免得还剩半秒写成 0 秒。
 */
export function formatAccelerationDuration(seconds: number, roundUp = false): string {
  const value = Math.max(0, roundUp ? Math.ceil(seconds) : Math.floor(seconds))
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor(value % 3600 / 60)
  const rest = value % 60
  if (hours) return minutes ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`
  if (minutes) return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`
  return `${rest} 秒`
}

/**
 * 线路按钮上写什么。自动时没连上不知道会选哪条，只写「自动选择」；连上了写出它选的那条和延迟。
 * 手选的那条写名字，测过延迟再带上毫秒。
 */
export function lineButtonText(selectedLineId: string | null, line: AccelerationLine | null | undefined, connected: boolean): string {
  const latency = line?.latencyMs == null ? '' : ` · ${line.latencyMs} ms`
  if (selectedLineId === null) return connected && line ? `自动选择（${line.name}）${latency}` : '自动选择'
  return line ? `${line.name}${latency}` : '自动选择'
}

function describePhase(phase: AccelerationPhase | undefined, signedIn: boolean) {
  if (!signedIn) return '登录后开启'
  switch (phase) {
    case 'active': return '加速已开启'
    case 'connecting': return '正在连接'
    case 'stopping': return '正在停止'
    case 'idle': return '准备就绪'
    case 'unavailable': return '线路准备中'
    case 'exhausted': return '体验已结束'
    case 'error': return '连接未完成'
    default: return '正在读取状态'
  }
}

/**
 * 设置 › 网络加速最上面那张游戏加速卡（v4 批09，原来是一整页）。剩余免费时长、线路、开关、
 * 冲突和加速文件坏了的提示都留着；地球动画、三格详情去掉，计时规则在「使用帮助」里。
 */
export function AccelerationView({ state, busy, signedIn, error, preview, onStart, onStartAnyway, onStop, onRefresh, onLogin, onHelp, onViewLog, lines, selectedLineId, rememberedLine, linesBusy, linesError, onSelectLine, onRefreshLines, bundleCheck, onRecheckBundle, onContactSupport, onRelaunch }: AccelerationViewProps) {
  // 点过「开启加速」、又回到准备就绪还挂着出错条：状态写「上次没连上」，再点「开启加速」或「重新检查」就恢复。
  const [startTried, setStartTried] = useState(false)

  const phase = state?.phase
  const localDevelopment = state?.entitlementSource === 'local-development'
  const conflicts = state?.conflicts ?? []
  // 冲突有自己的提示块（带「仍然连接」），不要再在下面重复一条通用错误。
  // 主进程给的每一句都已经是写给客户看的话，这里原样显示；原来把「代理」机械换成
  // 「网络连接」，造出过「加速网络连接连通性验证失败」这种读不通的句子。
  const notice = conflicts.length ? null : error || state?.error
  const stopRetry = phase === 'stopping' && Boolean(notice) && !busy
  const active = phase === 'active'
  const transitioning = phase === 'connecting' || (phase === 'stopping' && !stopRetry)
  const unavailable = phase === 'unavailable'
  // 本机加速文件坏了：等多久都不会好，与「线路准备中」分开说。
  const bundleDamaged = signedIn && unavailable && state?.unavailableReason === 'bundle-damaged'
  const damagedNotice = bundleDamaged ? bundleDamagedNotice(bundleCheck) : null
  const exhausted = phase === 'exhausted'
  const failedStart = startTried && phase === 'idle' && Boolean(notice) && !busy
  useEffect(() => { if (phase === 'active') setStartTried(false) }, [phase])
  function start() { setStartTried(true); onStart() }
  function startAnyway() { setStartTried(true); onStartAnyway() }
  function refresh() { setStartTried(false); onRefresh() }
  // 免费时长用完：不再给换线路；主按钮直接去「帮助与客服」。连着的时候线路按钮照样摆着，写的是连上的那条，只是点不了。
  const linePickerShown = signedIn && !exhausted
  const contactInstead = exhausted && signedIn && Boolean(onContactSupport)
  const lineLocked = active || phase === 'connecting' || phase === 'stopping' || busy
  const connected = active || phase === 'stopping'
  const displayLine = connected ? state?.line : lines.find(line => line.id === selectedLineId)
  const measured = lines.filter(line => line.latencyMs != null)
  const fastest = measured.length > 1 ? measured.reduce((best, line) => (line.latencyMs ?? Infinity) < (best.latencyMs ?? Infinity) ? line : best) : null
  const lineItems: Array<MenuItem | 'divider'> = [
    { label: '自动选择', description: '连接时选最快的线路', checked: selectedLineId === null, testId: 'acceleration-line-auto', onSelect: () => onSelectLine(null) },
    ...lines.map((line): MenuItem => ({
      label: line.name,
      ...(line.region ? { description: line.region } : {}),
      hint: line.latencyMs == null ? '未检测' : line.id === fastest?.id ? `最快 · ${line.latencyMs} ms` : `${line.latencyMs} ms`,
      checked: selectedLineId === line.id,
      testId: `acceleration-line-option-${line.id}`,
      onSelect: () => onSelectLine(line.id),
    })),
    'divider',
    { label: '重新测速', icon: RefreshCw, disabled: linesBusy, testId: 'acceleration-line-refresh', onSelect: onRefreshLines },
  ]
  const remaining = signedIn ? state?.remainingSeconds ?? null : null
  const phaseLabel = bundleDamaged ? '加速文件损坏' : failedStart ? '上次没连上' : describePhase(phase, signedIn)
  const actionLabel = !signedIn ? '登录领取免费体验' : stopRetry ? '重试停止' : active ? '停止加速' : phase === 'connecting' ? '正在连接…' : phase === 'stopping' ? '正在停止…' : contactInstead ? '联系客服' : exhausted ? '免费体验已用完' : bundleDamaged ? '暂时开不了加速' : unavailable ? '线路准备中' : !state ? '正在读取状态…' : '开启加速'
  const actionDisabled = signedIn && !contactInstead && (busy || transitioning || unavailable || exhausted || !state)
  const quotaNote = !signedIn ? '每个账号可领取 20 分钟免费体验' : active ? '按实际连接时长计时，停止后保留剩余额度' : exhausted ? '免费体验已经用完，后续服务请联系客服' : bundleDamaged ? '修好之前不计时' : unavailable ? '服务准备完成后即可开启，当前不消耗时长' : '连接成功才计时，随时停止，剩余下次继续'
  const action = !signedIn ? onLogin : active || stopRetry ? onStop : contactInstead && onContactSupport ? onContactSupport : start
  // 说明行的后半句：知道还剩多少就写多少，不知道（没登录、用完、准备中、文件坏了）照旧说计时规则。
  const remainingShown = remaining !== null && !exhausted && !unavailable
  const remainingText = remainingShown
    ? <>{localDevelopment ? '剩余测试时长' : '剩余免费时长'} <span data-testid="acceleration-quota-remaining">{formatAccelerationDuration(remaining, true)}</span></>
    : quotaNote
  const intro = localDevelopment ? '游戏加速连接测试，时长仅在本机记录' : '为游戏走一条更快的线路，当前账号的 AI 工具照常直连'
  // 标题已经说了「已开启」、按钮写着「开启加速」时，状态那几个字只留给读屏；别的状态（准备中、文件坏了、没连上）照常露出来。
  const phaseQuiet = active || (phase === 'idle' && !failedStart && signedIn)

  return <section className={active ? 'acceleration-card is-active' : 'acceleration-card'} data-testid="acceleration-page" data-phase={phase ?? 'loading'} aria-labelledby="acceleration-card-title">
    <div className="acceleration-card-main">
      <div className="acceleration-tile" aria-hidden="true"><Globe2 size={24} /></div>
      <div className="acceleration-copy">
        <div className="acceleration-title">
          <h2 id="acceleration-card-title">{active ? '游戏加速已开启' : '游戏加速'}</h2>
          {(preview || localDevelopment) && <span className="acceleration-preview">{localDevelopment ? '本机联调' : '交互预览'}</span>}
          <span className={phaseQuiet ? 'acceleration-phase xm-visually-hidden' : 'acceleration-phase'} role="status" data-testid="acceleration-phase">{phaseLabel}</span>
          <Button variant="ghost" size="xs" icon={CircleHelp} onClick={onHelp} testId="acceleration-help-open">使用帮助</Button>
        </div>
        <p className="acceleration-lead">
          {active && state
            ? <>已连接 <span data-testid="acceleration-session-duration">{formatAccelerationDuration(state.sessionSeconds)}</span>，{remainingText}</>
            : <>{intro}，{remainingText}</>}
        </p>
        {linePickerShown && <div className="acceleration-line-row">
          <span>线路</span>
          <Menu label="选择线路" align="start" items={lineItems} panelClassName="acceleration-line-menu"
            anchor={<Button size="sm" iconRight={ChevronDown} disabled={lineLocked} testId="acceleration-line-picker-toggle"><span data-testid="acceleration-line-current">{lineButtonText(selectedLineId, displayLine, connected)}</span></Button>} />
          {!connected && rememberedLine && <span className="acceleration-line-remembered" data-testid="acceleration-line-remembered">已选中你上次用的线路</span>}
        </div>}
        {linesError && linePickerShown && <p className="acceleration-line-error" role="alert">{linesError}</p>}
        {bundleDamaged
          ? <p className="acceleration-status-hint">照下面的办法处理后点「检查加速文件」</p>
          : unavailable && signedIn && <Button variant="ghost" size="xs" icon={RefreshCw} loading={busy} onClick={refresh} testId="acceleration-status-refresh">刷新线路状态</Button>}
      </div>
      <Button variant={active || stopRetry ? 'secondary' : 'primary'} icon={active || stopRetry ? Pause : contactInstead ? ArrowUpRight : Power} loading={signedIn && !contactInstead && (busy || transitioning)} disabled={actionDisabled} onClick={action} testId={active || stopRetry ? 'acceleration-session-stop' : contactInstead ? 'acceleration-contact-support' : 'acceleration-session-start'}>{actionLabel}</Button>
    </div>

    {conflicts.length > 0 && <Notice tone="warn" testId="acceleration-conflict" title={accelerationConflictNotice}
      body={`${conflicts.map(kind => accelerationConflictDescriptions[kind]).join('；')}。关掉之后再点「开启加速」会重新检测。`}
      actions={<Button size="sm" icon={Power} onClick={startAnyway} disabled={actionDisabled} testId="acceleration-conflict-force">仍然连接</Button>} />}

    {damagedNotice && <Notice tone="bad" testId="acceleration-bundle-damaged" title={damagedNotice.title} body={damagedNotice.body}
      actions={<>
        {bundleCheck === 'repaired'
          ? onRelaunch && <Button size="sm" icon={Power} onClick={onRelaunch} testId="acceleration-bundle-relaunch">现在重新打开</Button>
          : onRecheckBundle && <Button size="sm" icon={RefreshCw} loading={bundleCheck === 'checking'} onClick={onRecheckBundle} testId="acceleration-bundle-recheck">检查加速文件</Button>}
        {onContactSupport && <Button variant="ghost" size="sm" icon={ArrowUpRight} onClick={onContactSupport} testId="acceleration-bundle-support">联系客服</Button>}
      </>} />}

    {notice && <Notice tone="bad" testId="acceleration-error" title={notice} body={null}
      actions={<>
        {onViewLog && operationLogSection({ message: notice }) === 'log' && <Button variant="ghost" size="sm" icon={ScrollText} onClick={onViewLog} testId="acceleration-error-log">查看日志</Button>}
        <Button variant="ghost" size="sm" icon={RefreshCw} onClick={refresh} disabled={busy}>重新检查</Button>
        {phase === 'error' && onContactSupport && <Button variant="ghost" size="sm" icon={ArrowUpRight} onClick={onContactSupport} testId="acceleration-error-support">联系客服</Button>}
      </>} />}
  </section>
}
