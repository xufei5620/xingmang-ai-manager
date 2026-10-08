import type { AccountSessionState } from '../../../../electron/ipc-contract'
import { redactSecretPatterns } from '../../../../electron/redaction-patterns'
import { Button } from '../../ui'
import type { WindowOs } from './window-os'

const osLabels: Record<WindowOs, string> = { win: 'Windows', mac: 'macOS', linux: 'Linux' }

export interface SupportIdentityInput {
  signedIn: boolean
  account: Pick<NonNullable<AccountSessionState['account']>, 'userId' | 'username'> | null | undefined
  version: string | undefined
  os: WindowOs
  /** 只有 Linux 用：发行版和芯片（「Ubuntu 24.04.1 LTS · 64 位」）。光写 Linux 客服还得再问一轮。 */
  systemDetail?: string | undefined
}

/** 「复制给客服」里 Linux 后面括号那一段，和检查页「操作系统」一项同一套叫法。 */
export function linuxSystemDetail(systemLabel: string | undefined, architecture: string | undefined): string | undefined {
  const chip = architecture === 'arm64' ? 'ARM 芯片' : architecture === 'x64' ? '64 位' : architecture
  const detail = [systemLabel, chip].filter(Boolean).join(' · ')
  return detail || undefined
}

function supportSystemLabel(input: SupportIdentityInput): string {
  return input.os === 'linux' && input.systemDetail ? `Linux（${input.systemDetail}）` : osLabels[input.os]
}

/**
 * 客服每次都要先问一轮「账号是什么、用的哪一版、Windows 还是 Mac」，小白常答不上
 * 版本号。这一行让用户原样复制发过去。只写账号名、账号 ID、版本和系统：不写邮箱，
 * 也不写站点名（界面以「当前账号」为主语）。历史账号那边拿不到可靠的数字 ID 时
 * 只写账号名，不拿 0 或 NaN 冒充。
 */
export function buildSupportIdentityLine(input: SupportIdentityInput): string {
  const app = input.version ? `星芒AI管理工具 ${input.version}` : '星芒AI管理工具'
  return [supportAccountLabel(input), app, supportSystemLabel(input)].join(' · ')
}

function supportAccountLabel(input: SupportIdentityInput): string {
  const name = input.signedIn ? input.account?.username.trim() : undefined
  const id = input.signedIn ? input.account?.userId : undefined
  return !name ? '未登录'
    : typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? `账号 ${name}（ID ${id}）` : `账号 ${name}`
}

/**
 * 一次失败里客服要的几样东西。`reason` 是错误框认出来的那句（认不出时为空），
 * `detail` 是被兜底句换掉的原话（见 business-common 的 operationFailureFrom）。
 */
export interface SupportFailure {
  at: Date
  /** 用户点的是哪件事（「打开 Codex 桌面端」）；确认框之类没有名字的操作缺省。 */
  action?: string | undefined
  message: string
  reason?: string | undefined
  detail?: string | undefined
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function supportTime(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/**
 * 「复制给客服」一次带走的内容：你是谁、哪一版、什么系统、什么时候、做了什么、为什么
 * 没成。以前这几样分在帮助框、错误框和反馈页三处，客户只能截图。
 *
 * 整段再过一遍日志和反馈报告用的同一张 Key 打码表（redaction-patterns.ts）：原话里
 * 偶尔带着 `sk-…` 或 `Bearer …`，复制出去就进了客服群（I13）。
 */
export function buildSupportBundle(input: SupportIdentityInput, failure: SupportFailure): string {
  const lines = [
    '星芒AI管理工具 · 给客服的信息',
    supportAccountLabel(input),
    `版本 ${input.version ?? '未知'} · ${supportSystemLabel(input)}`,
    `时间 ${supportTime(failure.at)}`,
  ]
  if (failure.action) lines.push(`做什么：${failure.action}`)
  const outcome = supportOutcome(failure)
  if (outcome) lines.push(`结果：${outcome}`)
  const reason = supportReason(failure)
  if (reason) lines.push(`原因：${reason}`)
  if (failure.detail) lines.push(`原话：${failure.detail}`)
  return redactSecretPatterns(lines.join('\n'))
}

/** 上屏那句只是「{动作}没有完成」时不再重复一遍；主进程写好的中文整句才算结果。 */
function supportOutcome(failure: SupportFailure): string | undefined {
  return failure.action && failure.message === `${failure.action}没有完成` ? undefined : failure.message
}

function supportReason(failure: SupportFailure): string | undefined {
  return failure.reason ?? (failure.detail ? '没认出是哪一类问题，原话在下面' : undefined)
}

/** 帮助框身份行下面那一行：「最近一次出错：14:37 打开 Codex 桌面端：……」。 */
export function buildLastFailureLine(failure: SupportFailure): string {
  const time = `${pad(failure.at.getHours())}:${pad(failure.at.getMinutes())}`
  const what = failure.action ?? failure.message
  const why = failure.reason ?? (failure.action ? supportOutcome(failure) : undefined) ?? failure.detail
  return redactSecretPatterns(why ? `最近一次出错：${time} ${what}：${why}` : `最近一次出错：${time} ${what}`)
}

export function SupportIdentity({ line, lastFailure, onCopy }: { line: string; lastFailure?: string | undefined; onCopy: () => void }) {
  return <div className="v2-support-identity" data-testid="support-identity">
    <p>找客服时把这行一起发过去：</p>
    <div><code data-testid="support-identity-line">{line}</code><Button size="sm" onClick={onCopy}>复制</Button></div>
    {lastFailure && <p data-testid="support-last-failure">{lastFailure}</p>}
  </div>
}
