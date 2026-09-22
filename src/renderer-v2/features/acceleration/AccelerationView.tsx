import { useEffect, useState } from 'react'
import { ArrowUpRight, Check, CircleHelp, Clock3, Globe2, Laptop, Pause, Power, RefreshCw, Route, ScrollText, ShieldAlert, ShieldCheck, Timer, Zap } from 'lucide-react'
import { accelerationConflictDescriptions, accelerationConflictNotice, accelerationTrialSeconds, type AccelerationMode, type AccelerationPhase, type AccelerationState } from '../../../../electron/acceleration-contract'
import { Button, Switch } from '../../ui'
// 落点规则只有 operationLogPage 一份：加速这条线没有 tool，按它的口径永远落
// 「反馈」页的运行日志，而不是「安装卸载」页那张只装当次安装进度的卡。
import { operationLogPage } from '../../operation-error'
import { Globe } from './Globe'
import './acceleration.css'

interface AccelerationViewProps {
  state: AccelerationState | null
  mode: AccelerationMode
  busy: boolean
  signedIn: boolean
  error: string | null
  preview?: boolean
  onModeChange(mode: AccelerationMode): void
  onStart(): void
  /** 用户看过冲突提示后仍要连接：同一次连接，只是跳过检测。 */
  onStartAnyway(): void
  onStop(): void
  onRefresh(): void
  onLogin(): void
  onHelp(): void
  /** 「查看日志」的出口。红条上那句话现在会说出原因，但真正的现场在运行日志里。 */
  onViewLog?(): void
  lines: import('../../../../electron/acceleration-contract').AccelerationLine[]
  selectedLineId: string | null
  linesBusy: boolean
  linesError: string | null
  onSelectLine(lineId: string | null): void
  onPingLine(lineId: string): void
  onRefreshLines(): void
}

function formatDuration(seconds: number | null, roundUp = false) {
  if (seconds === null || !Number.isFinite(seconds)) return '--:--:--'
  const value = Math.max(0, roundUp ? Math.ceil(seconds) : Math.floor(seconds))
  return [Math.floor(value / 3600), Math.floor(value % 3600 / 60), value % 60].map(part => String(part).padStart(2, '0')).join(':')
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

export function AccelerationView({ state, mode, busy, signedIn, error, preview, onModeChange, onStart, onStartAnyway, onStop, onRefresh, onLogin, onHelp, onViewLog, lines, selectedLineId, linesBusy, linesError, onSelectLine, onPingLine, onRefreshLines }: AccelerationViewProps) {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden)
  const [linePickerOpen, setLinePickerOpen] = useState(false)
  useEffect(() => {
    function updateVisibility() { setVisible(!document.hidden) }
    document.addEventListener('visibilitychange', updateVisibility)
    return () => document.removeEventListener('visibilitychange', updateVisibility)
  }, [])

  const phase = state?.phase
  const localDevelopment = state?.entitlementSource === 'local-development'
  const localDevice = state?.entitlementSource === 'local-device'
  const tunAvailable = state?.supportedModes?.includes('tun') ?? true
  const conflicts = state?.conflicts ?? []
  // 冲突有自己的提示块（带「仍然连接」），不要再在下面重复一条通用错误。
  const notice = conflicts.length ? null : (error || state?.error)?.replaceAll('系统代理', '网络设置').replaceAll('代理', '网络连接')
  const stopRetry = phase === 'stopping' && Boolean(notice) && !busy
  const active = phase === 'active'
  const transitioning = phase === 'connecting' || (phase === 'stopping' && !stopRetry)
  const unavailable = phase === 'unavailable'
  const exhausted = phase === 'exhausted'
  const modeLocked = active || phase === 'stopping' || transitioning || busy || !tunAvailable
  const lineLocked = active || phase === 'connecting' || phase === 'stopping' || busy
  const displayLine = active || phase === 'stopping' ? state?.line : lines.find(line => line.id === selectedLineId)
  const effectiveMode = (active || transitioning) && state ? state.mode : mode
  const remaining = signedIn ? state?.remainingSeconds ?? null : null
  const total = state?.totalSeconds ?? accelerationTrialSeconds
  const totalMinutes = total / 60
  const ratio = remaining === null || total <= 0 ? 0 : Math.min(1, Math.max(0, remaining / total))
  const used = remaining === null ? null : Math.max(0, total - remaining)
  const phaseLabel = describePhase(phase, signedIn)
  const actionLabel = !signedIn ? '登录领取免费体验' : stopRetry ? '重试停止' : active ? '停止加速' : phase === 'connecting' ? '正在连接…' : phase === 'stopping' ? '正在停止…' : exhausted ? '免费体验已用完' : unavailable ? '线路准备中' : !state ? '正在读取状态…' : '开始加速'
  const actionDisabled = signedIn && (busy || transitioning || unavailable || exhausted || !state)
  const quotaNote = !signedIn ? '每个账号可领取 20 分钟免费体验' : active ? '按实际连接时长计时，停止后保留剩余额度' : exhausted ? '感谢体验，了解后续服务请联系帮助与客服' : unavailable ? '服务准备完成后即可开启，当前不消耗时长' : '连接成功才计时，随时停止，剩余下次继续'

  return <section className="acceleration-page" data-testid="acceleration-page" data-phase={phase ?? 'loading'} data-motion={visible ? 'running' : 'paused'}>
    <header className="acceleration-heading">
      <div><div className="acceleration-heading-title"><h1>游戏加速</h1>{(preview || localDevelopment) && <span className="acceleration-preview">{localDevelopment ? '本机联调' : '交互预览'}</span>}</div><p>{localDevelopment ? '游戏加速连接测试，时长仅在本机记录。' : '选择游戏加速线路，按需连接，随时停止。'}</p></div>
      <Button variant="ghost" icon={CircleHelp} onClick={onHelp} testId="acceleration-help-open">使用帮助</Button>
    </header>

    <div className="acceleration-workbench">
      <section className="acceleration-stage" aria-label="网络连接状态">
        <div className="acceleration-stage-top"><span className="acceleration-eyebrow"><Globe2 size={15} aria-hidden="true" /> GAME CONNECT</span><span className="acceleration-stage-scope"><Laptop size={14} aria-hidden="true" />{effectiveMode === 'tun' ? '增强模式' : '标准模式'}</span></div>
        <div className="acceleration-stage-title"><h2>连接热爱，准备开局。</h2><p>{active ? '加速连接已就绪，返回游戏继续体验。' : '从这里出发，连接你的游戏世界。'}</p></div>
        <div className="acceleration-orb"><Globe /></div>
        <div className="acceleration-route-info">
          <div className="acceleration-route-icon"><Route size={18} aria-hidden="true" /></div>
          <div className="acceleration-route-name"><span>加速线路</span><strong data-testid="acceleration-line-current">{displayLine?.name ?? '智能分配'}{displayLine?.region && <small>{displayLine.region}</small>}</strong></div>
          <div className="acceleration-route-latency"><span>连接延迟</span><strong>{displayLine?.latencyMs == null ? '—' : <>{displayLine.latencyMs}<small> ms</small></>}</strong></div>
        </div>
        {!active && signedIn && <div className="acceleration-line-picker"><Button variant="ghost" size="sm" icon={Route} disabled={lineLocked} onClick={() => setLinePickerOpen(value => !value)} aria-expanded={linePickerOpen} testId="acceleration-line-picker-toggle">{linePickerOpen ? '收起线路' : '选择加速线路'}</Button>{linePickerOpen && <div className="acceleration-line-list" role="listbox" aria-label="加速线路选择">
          <div className="acceleration-line-list-head"><span>{linesBusy ? '正在检测线路…' : `${lines.length} 条可用线路`}</span><Button variant="ghost" size="xs" icon={RefreshCw} onClick={onRefreshLines} loading={linesBusy} aria-label="刷新线路列表" /></div>
          <div className={`acceleration-line-option acceleration-line-auto${selectedLineId === null ? ' is-selected' : ''}`} role="option" aria-selected={selectedLineId === null} data-testid="acceleration-line-auto">
            <button type="button" disabled={lineLocked} onClick={() => onSelectLine(null)}><strong>智能分配</strong><small>连接时自动测速，选择最快可用线路</small></button>
            {selectedLineId === null && <Check size={16} aria-hidden="true" />}
          </div>
          {lines.map(line => <div className={`acceleration-line-option${selectedLineId === line.id ? ' is-selected' : ''}`} role="option" aria-selected={selectedLineId === line.id} data-testid={`acceleration-line-option-${line.id}`} key={line.id}><button type="button" disabled={lineLocked} onClick={() => onSelectLine(line.id)}><strong>{line.name}</strong><small>{line.region}</small></button><span>{line.latencyMs == null ? '未检测' : `${line.latencyMs} ms`}</span><Button variant="ghost" size="xs" disabled={lineLocked} onClick={() => { void onPingLine(line.id) }} loading={linesBusy} aria-label={`检测${line.name}延迟`}>Ping</Button></div>)}
          {linesError && <span className="acceleration-line-error" role="alert">{linesError}</span>}
        </div>}</div>}
        <div className="acceleration-stage-bottom"><span role="status"><span className="acceleration-status-dot" />{phaseLabel}</span>{(unavailable || exhausted) && signedIn ? <Button variant="ghost" size="sm" icon={exhausted ? ArrowUpRight : RefreshCw} loading={busy} onClick={exhausted ? onHelp : onRefresh} testId="acceleration-status-refresh">{exhausted ? '帮助与客服' : '刷新线路状态'}</Button> : <span>{!state?.line ? '线路信息将在连接后显示' : active ? '连接状态由服务实时确认' : '等待建立连接'}</span>}</div>
      </section>

      <section className="acceleration-console" aria-label="免费加速额度与操作">
        <div className="acceleration-console-top"><span><Zap size={15} aria-hidden="true" />{localDevelopment ? '本机测试额度' : '免费体验'}</span><span className="acceleration-quota-badge">{totalMinutes} 分钟</span></div>
        <div className="acceleration-quota">
          <svg className="acceleration-quota-ring" viewBox="0 0 220 220" aria-hidden="true"><circle className="acceleration-quota-track" cx="110" cy="110" r="96" /><circle className="acceleration-quota-ticks" cx="110" cy="110" r="85" /><circle className="acceleration-quota-progress" cx="110" cy="110" r="96" pathLength="100" strokeDasharray={`${ratio * 100} 100`} transform="rotate(-90 110 110)" /></svg>
          <div className="acceleration-quota-label"><span>{!signedIn ? '登录领取时长' : remaining === null ? '剩余额度待确认' : localDevelopment ? '剩余测试时长' : '剩余免费时长'}</span><strong data-testid="acceleration-quota-remaining" aria-label={`剩余${localDevelopment ? '测试' : '免费'}时长 ${formatDuration(remaining, true)}`}>{formatDuration(remaining, true)}</strong><small>{active ? <><span className="acceleration-status-dot" />正在计时</> : <><Pause size={12} aria-hidden="true" />{remaining === null ? '尚未开始计时' : exhausted ? '额度已用完' : '未计时'}</>}</small></div>
        </div>
        <div className="acceleration-primary-action"><Button variant={active || stopRetry ? 'secondary' : 'primary'} icon={active || stopRetry ? Pause : Power} loading={signedIn && (busy || transitioning)} disabled={actionDisabled} onClick={!signedIn ? onLogin : active || stopRetry ? onStop : onStart} testId={active || stopRetry ? 'acceleration-session-stop' : 'acceleration-session-start'}>{actionLabel}</Button></div>
        <p className="acceleration-quota-note">{quotaNote}</p>
        <div className="acceleration-mode"><div><strong>TUN 模式</strong><p>{!tunAvailable ? '暂未开放' : modeLocked ? '停止加速后可切换模式' : mode === 'tun' ? '扩展游戏与应用的连接范围' : '开启后可扩展连接范围'}</p></div><Switch checked={effectiveMode === 'tun'} onChange={checked => onModeChange(checked ? 'tun' : 'system-proxy')} disabled={modeLocked} aria-label="TUN 模式" testId="acceleration-mode-toggle" /></div>
      </section>
    </div>

    {conflicts.length > 0 && <div className="acceleration-conflict" role="alert" data-testid="acceleration-conflict">
      <ShieldAlert size={16} aria-hidden="true" />
      <div className="acceleration-conflict-text">
        <strong>{accelerationConflictNotice}</strong>
        <span>{conflicts.map(kind => accelerationConflictDescriptions[kind]).join('；')}。关掉之后再点「开始加速」会重新检测。</span>
      </div>
      <Button variant="secondary" size="sm" icon={Power} onClick={onStartAnyway} disabled={actionDisabled} testId="acceleration-conflict-force">仍然连接</Button>
    </div>}

    {notice && <div className="acceleration-error" role="alert"><CircleHelp size={16} aria-hidden="true" /><span>{notice}</span>{onViewLog && operationLogPage({ message: notice }) === 'feedback' && <Button variant="ghost" size="sm" icon={ScrollText} onClick={onViewLog} testId="acceleration-error-log">查看日志</Button>}<Button variant="ghost" size="sm" icon={RefreshCw} onClick={onRefresh} disabled={busy}>重新检查</Button></div>}

    <div className="acceleration-details" aria-label="加速使用信息">
      <div><span className="acceleration-detail-icon"><Timer size={19} aria-hidden="true" /></span><div><span>本次连接</span><strong data-testid="acceleration-session-duration">{formatDuration(signedIn && state ? state.sessionSeconds : null)}</strong></div><small>{active ? '已连接时长' : '连接后开始计时'}</small></div>
      <div><span className="acceleration-detail-icon"><Clock3 size={19} aria-hidden="true" /></span><div><span>累计使用</span><strong data-testid="acceleration-usage-total">{formatDuration(used)}</strong></div><small>停止后不扣时</small></div>
      <div><span className="acceleration-detail-icon"><ShieldCheck size={19} aria-hidden="true" /></span><div><span>{localDevelopment ? '本机测试规则' : '免费额度规则'}</span><strong>随用随停，保留剩余</strong></div><small><Check size={12} aria-hidden="true" />{localDevelopment ? `本机记录 ${totalMinutes} 分钟，非服务端权益` : localDevice ? `每账号在本机累计 ${totalMinutes} 分钟，不每日重置` : `每账号累计 ${totalMinutes} 分钟，不每日重置`}</small></div>
    </div>
  </section>
}
