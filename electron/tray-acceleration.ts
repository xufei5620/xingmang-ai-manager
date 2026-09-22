/**
 * 托盘右键菜单里的加速那一行（只读状态）和那一项动作（连接 / 断开）。
 *
 * 为什么要有它：「缩到托盘」是关窗口的默认选项之一，用户玩游戏时主窗口一定
 * 是缩着的。今天想停加速得先把窗口叫出来、切到加速页、再点一次，托盘上一个
 * 入口都没有。
 *
 * 三条硬约束：
 * - **不新增第二条连接逻辑**。连接与断开走的就是加速页按钮那条路
 *   （acceleration-service 的 startAcceleration / stopAcceleration），会话、
 *   免费时长计时、加速页上的状态一并照旧；线路与模式用的是用户在加速页上选过
 *   并落了盘的那一套（acceleration-preference-store.ts），与打开 Codex 桌面端时
 *   自动连接（codex-desktop-acceleration.ts）同一口径——没选过才是「智能分配 +
 *   标准模式」，托盘自己不替用户猜，解析交给宿主注入的 connect。
 * - **不新增轮询**。状态只有两个来源：服务每产出一个状态就通知过来
 *   （createAccelerationService 的 onState），以及用户打开托盘菜单时读一次。
 *   主窗口缩起来之后渲染层那边的 15 秒轮询是停的，所以剩余时长按读到的时刻
 *   往前推算一下再显示，只为显示，不作数——真正的计时在主进程里。
 * - **不弹窗**。托盘上的失败只把状态行换成一句短原因，细节留在加速页与运行
 *   日志里；一个连不上的机器不该因为点了托盘就弹出对话框挡在游戏前面。
 *
 * 不含任何 Electron 依赖：状态读取与连接都由宿主注入，好让这一整套判断能脱离
 * 托盘单测。
 */
import { accelerationFailureReason, type AccelerationFailureReason, type AccelerationState } from './acceleration-contract'

export type TrayAccelerationAction = 'start' | 'stop'

export interface TrayAccelerationEntry {
  /** 菜单里那一行只读状态，永远以「加速：」开头。 */
  statusLabel: string
  actionLabel: string
  actionEnabled: boolean
  /** 置灰时仍然给出它本来要做的事，测试与日志据此对账。 */
  action: TrayAccelerationAction | null
}

export interface TrayAccelerationInput {
  signedIn: boolean
  state: AccelerationState | null
  /** 托盘自己发起的连接 / 断开还没回来。 */
  busy: boolean
  /** 上一次托盘操作或状态读取失败后的一句短原因；下一个状态到达就清掉。 */
  failure: string | null
  /** 状态读到之后过了多少秒，只用来把剩余时长显示得不至于太陈旧。 */
  elapsedSeconds?: number
}

const statusPrefix = '加速：'
const connectLabel = '连接加速'
const disconnectLabel = '断开加速'
const retryDisconnectLabel = '重试断开'
const busyLabel = '处理中…'

/**
 * 失败原因在托盘上只有一行的位置，而 accelerationFailureMessages 里每一句都是
 * 给界面写的整句（最长七十来字）。这里按同一个封闭集合另给一份短说法，长的那
 * 份仍然在加速页上显示。无 default 分支：新增一种失败原因时这里编译不过。
 */
const failureSummaries: Record<AccelerationFailureReason, string> = {
  'helper-temp': '系统临时文件夹不可用',
  'helper-launch': '加速组件没能启动',
  'helper-timeout': '加速组件响应超时',
  'helper-data': '本机加速数据目录不可用',
  'proxy-owned': '上次加速仍占用着网络设置',
  'proxy-locked': '系统策略限制，无法修改网络设置',
  'proxy-restore': '上次的网络设置还没还原完',
  'local-data': '本机时长记录读写失败',
  unknown: '连接未成功，请稍后重试',
}

/**
 * 归类不出来的失败只剩错误原文。它们全部是本仓自己写死的中文短句（账号已变更、
 * 线路暂未开通、停止未完成……），但托盘这一行不值得为此冒险：带路径、协议头或
 * 明显超长的一律退回通用说法（I13）。
 */
function shortReason(text: string | null | undefined, fallback: string): string {
  const value = text?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/[。.！!]+$/, '') ?? ''
  if (!value || value.length > 40 || /[\\/]|:\/\//.test(value)) return fallback
  return value
}

/** 托盘操作抛出来的失败收成一句短话。 */
export function describeTrayAccelerationFailure(error: unknown): string {
  const reason = accelerationFailureReason(error)
  if (reason) return failureSummaries[reason]
  return shortReason(error instanceof Error ? error.message : null, failureSummaries.unknown)
}

function remainingLabel(seconds: number | null, elapsedSeconds: number): string {
  if (seconds === null || !Number.isFinite(seconds)) return '剩余时长待确认'
  const left = Math.max(0, seconds - Math.max(0, elapsedSeconds))
  return left < 60 ? '剩余不到 1 分钟' : `剩余 ${Math.floor(left / 60)} 分钟`
}

function exhausted(state: AccelerationState): boolean {
  return state.phase === 'exhausted' || state.remainingSeconds === 0
}

/** 状态行与动作项的全部判断都在这一个纯函数里。 */
export function buildTrayAccelerationEntry(input: TrayAccelerationInput): TrayAccelerationEntry {
  const busyEntry = { actionLabel: busyLabel, actionEnabled: false }
  if (!input.signedIn) {
    return { statusLabel: `${statusPrefix}未登录，登录后可用`, actionLabel: connectLabel, actionEnabled: false, action: 'start' }
  }
  if (input.busy) {
    const stopping = input.state?.phase === 'active' || input.state?.phase === 'stopping'
    return { statusLabel: `${statusPrefix}${stopping ? '正在断开' : '正在连接'}`, ...busyEntry, action: stopping ? 'stop' : 'start' }
  }
  const state = input.state
  if (!state) {
    const label = input.failure ? `${statusPrefix}${input.failure}` : `${statusPrefix}正在读取状态`
    return { statusLabel: label, actionLabel: connectLabel, actionEnabled: false, action: 'start' }
  }
  if (state.phase === 'connecting') return { statusLabel: `${statusPrefix}正在连接`, ...busyEntry, action: 'start' }
  if (state.phase === 'active') {
    return {
      statusLabel: `${statusPrefix}已连接 · ${remainingLabel(state.remainingSeconds, input.elapsedSeconds ?? 0)}`,
      actionLabel: disconnectLabel, actionEnabled: true, action: 'stop',
    }
  }
  if (state.phase === 'stopping') {
    // 停止失败过一次的会话仍然停在 stopping，加速页此时给的是「重试停止」。
    // 托盘照它来，否则这一行会永远灰着，用户只能回主窗口才能再试一次。
    const failed = input.failure ?? (state.error ? shortReason(state.error, failureSummaries.unknown) : null)
    if (failed) return { statusLabel: `${statusPrefix}${failed}`, actionLabel: retryDisconnectLabel, actionEnabled: true, action: 'stop' }
    return { statusLabel: `${statusPrefix}正在断开`, ...busyEntry, action: 'stop' }
  }
  if (state.phase === 'unavailable') {
    return { statusLabel: `${statusPrefix}线路准备中`, actionLabel: connectLabel, actionEnabled: false, action: 'start' }
  }
  if (exhausted(state)) {
    return { statusLabel: `${statusPrefix}当前账号的免费时长已用完`, actionLabel: connectLabel, actionEnabled: false, action: 'start' }
  }
  if (state.conflicts?.length) {
    // 冲突要用户先关掉别的代理，或者在加速页上按「仍然连接」确认一次；托盘不做
    // 这个确认，所以这里只报状态，把人引回加速页。
    return { statusLabel: `${statusPrefix}检测到其他代理或 VPN，请到加速页处理`, actionLabel: connectLabel, actionEnabled: false, action: 'start' }
  }
  const failure = input.failure ?? (state.error ? shortReason(state.error, failureSummaries.unknown) : null)
  return {
    statusLabel: `${statusPrefix}${failure ?? '未连接'}`,
    actionLabel: connectLabel, actionEnabled: true, action: 'start',
  }
}

export interface TrayAccelerationCoordinatorOptions {
  getAccountScope(): string | null
  readState(scope: string): Promise<AccelerationState>
  /** 第二个参数是托盘手上这一份状态：宿主据此判断记住的模式当前支不支持。 */
  connect(scope: string, state: AccelerationState | null): Promise<AccelerationState>
  disconnect(scope: string): Promise<AccelerationState>
  /** 有任何变化就重建一次菜单，托盘那边照抄余额的做法。 */
  onChanged(): void
  now?(): number
  log?(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void
}

export interface TrayAccelerationCoordinator {
  entry(): TrayAccelerationEntry
  /** 服务每产出一个状态就送进来，包括加速页自己的连接与断开。 */
  observe(state: AccelerationState): void
  /** 打开托盘菜单时读一次；永不抛错，也不等它。 */
  refresh(): void
  /** 点了菜单里那一项：连着就断开，没连就连接。永不抛错。 */
  toggle(): Promise<void>
  /** 切换账号：上一个账号的状态一律作废。 */
  reset(): void
}

export function createTrayAccelerationCoordinator(options: TrayAccelerationCoordinatorOptions): TrayAccelerationCoordinator {
  const now = options.now ?? (() => Date.now())
  let state: AccelerationState | null = null
  let measuredAt = now()
  let failure: string | null = null
  let busy = false
  let reading: Promise<void> | null = null

  function log(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void {
    try { options.log?.(level, event, message, detail) }
    catch { /* 记日志失败不能反过来挡住托盘。 */ }
  }

  function changed(): void {
    try { options.onChanged() }
    catch (error) { log('warn', 'acceleration.tray.refresh.failed', '托盘菜单刷新失败', { cause: error instanceof Error ? error.message : String(error) }) }
  }

  function accept(next: AccelerationState): void {
    // 已经切过账号的状态不许覆盖当前这一份，否则托盘会显示上一个账号的剩余时长。
    if (next.scope !== options.getAccountScope()) return
    // 自己读的那一份也会先经由 onState 到达，同一个对象不必重建两次菜单。
    if (state === next) return
    state = next
    measuredAt = now()
    failure = null
    changed()
  }

  function current(): TrayAccelerationEntry {
    return buildTrayAccelerationEntry({
      signedIn: options.getAccountScope() !== null,
      state, busy, failure,
      elapsedSeconds: Math.max(0, now() - measuredAt) / 1000,
    })
  }

  return {
    entry: current,
    observe(next) { accept(next) },
    refresh() {
      const scope = options.getAccountScope()
      if (!scope) {
        if (state || failure) { state = null; failure = null; changed() }
        return
      }
      if (busy || reading) return
      // 用户打开菜单、读还没回来就点了连接：那一份读到的是「未连接」，落回来会
      // 把刚连上的状态又盖成未连接。toggle 与 reset 都会把 reading 清掉，所以
      // 这里认一次身份就够——不是当前这次读，结果一律丢弃。
      const pending = Promise.resolve().then(async () => {
        try {
          const next = await options.readState(scope)
          if (reading === pending) accept(next)
        } catch (error) {
          if (reading !== pending || options.getAccountScope() !== scope) return
          failure = describeTrayAccelerationFailure(error)
          changed()
        }
      })
      reading = pending
      void pending.finally(() => { if (reading === pending) reading = null }).catch(() => undefined)
    },
    async toggle() {
      const action = current()
      if (!action.actionEnabled || !action.action) return
      const scope = options.getAccountScope()
      if (!scope) return
      busy = true
      failure = null
      reading = null
      changed()
      try {
        const next = action.action === 'start' ? await options.connect(scope, state) : await options.disconnect(scope)
        if (next.scope === scope && options.getAccountScope() === scope) { state = next; measuredAt = now() }
        log('info', action.action === 'start' ? 'acceleration.tray.connected' : 'acceleration.tray.disconnected',
          action.action === 'start' ? '从托盘连接加速' : '从托盘断开加速', { phase: next.phase })
      } catch (error) {
        if (options.getAccountScope() === scope) failure = describeTrayAccelerationFailure(error)
        log('warn', action.action === 'start' ? 'acceleration.tray.connect.failed' : 'acceleration.tray.disconnect.failed',
          action.action === 'start' ? '从托盘连接加速未成功' : '从托盘断开加速未成功',
          { cause: error instanceof Error ? error.message : String(error) })
      } finally {
        busy = false
        changed()
      }
    },
    reset() {
      state = null
      failure = null
      reading = null
      changed()
    },
  }
}
