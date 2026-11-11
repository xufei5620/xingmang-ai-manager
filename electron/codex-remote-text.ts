import { redactSecretPatterns } from './redaction-patterns'
import { redactHomeDirectory } from './startup-log'
import { isRecord } from './input-guards'
import { isServiceUnavailableResponse } from './network-failure'
import { classifyRelayQuotaFailure, relayQuotaFailureMessages } from './relay-quota-failure'
import type { RemoteApprovalKind, RemoteApprovalOutcome, RemoteApprovalRequest } from './codex-remote-channel'

// 手机遥控发到聊天里的字、从聊天里认的指令，飞书、微信共用。字都在这一张表里，改字只改这里。

export const remoteMessages = {
  paired: '配对成功。这台电脑上的 Codex 现在只听你的。直接发消息就能让它干活，发「帮助」看能用的指令。',
  received: '收到，Codex 开始处理。',
  busy: 'Codex 还在处理上一条。等它做完再发，或者发「停止」中断它。',
  emptyAnswer: '这一轮做完了，Codex 没有留下文字回复。',
  interrupted: '已停止。',
  nothingToStop: '现在没有在处理的任务。',
  newThread: '已开始新对话。',
  // 语音、文件这些（YF-14，yoyo 2026-11-11「图片改」）：图片能发了，这句跟着改。
  unsupported: '暂时只支持文字和图片。语音、文件发不过来，请打成字。',
  help: '直接发消息就能让 Codex 干活。\n能用的指令：新对话、停止、状态、文件夹、关闭遥控、重试、帮助。\nCodex 要改文件、跑会改东西的命令时会先问你，回「同意」或「拒绝」；只是看文件不问。',
  closedOnComputer: '手机遥控已在电脑上关闭。',
  // 手机上发「关闭遥控」（Fable 手机遥控 YF-17，yoyo 2026-11-11「第三批改」）：开着的渠道都收到这一句。
  closedFromPhone: '手机遥控已关闭。要再用，请在电脑上的星芒里重新打开。',
  quitting: '电脑上的星芒关了，遥控已停。再打开星芒并打开遥控才能继续。',
  quitAborted: '电脑上的星芒没关成，遥控还开着，可以接着用。',
  stalled: '这件事 1 小时没有任何进展，已经停下。可以重新说一遍要做什么。',
  codexUnavailable: '电脑上的 Codex 没能启动，请在电脑上的星芒里看一下。',
  commandRefused: 'Codex 想运行的命令太长，手机上显示不全，已经替你拒绝了。确实需要的话，请在电脑上直接用 Codex 做这件事。',
  permissionsRefused: 'Codex 想多要一些权限，但要的范围手机上显示不全，已经替你拒绝了。确实需要的话，请在电脑上直接用 Codex 做这件事。',
  staleApprovalCard: '这张卡片已经失效了（处理过、超时了，或者电脑上的星芒重开过），刚才点的没有生效。有要你同意的事会另发新卡片。',
  clockAhead: '电脑上的时间和手机差得太多，这条消息没有执行。请把电脑时间调准后再发。',
  // 以下四句是 0.2.24 深查 D66（手机遥控.md YKS-3、16、18、19），yoyo 11-10「决定单照推荐」。
  codexStarting: '电脑正在准备 Codex，稍等一下；想取消就发「停止」。',
  threadReset: '这是新对话，前面的记不得了。',
  unbound: '电脑上已经把你解绑了，之后发的消息不会再执行。',
  idleClosingSoon: '手机遥控 10 分钟后自动关闭，还要用的话随便回一句就行。',
  // 手机上发「重试」、这次打开以后还没交给 Codex 过一句时（Fable 手机遥控 YF-22，yoyo 2026-11-11「状态重试改」）。
  nothingToRetry: '还没有可以重发的上一条。直接发要做的事就行。',
  // 点的是上一轮留下的进度卡上的「停止」（YF-15，yoyo 2026-11-11「进度改」）：这一轮不停。
  staleProgressCard: '这张卡片是上一轮的，现在这一轮没有停。要停请发「停止」。',
  // 手机上换文件夹（YF-19）：这一轮还没做完（含等你同意）时不换，免得改到一半换了地方。
  workspaceBusy: 'Codex 还在处理上一条，等它做完再换文件夹。',
  // 手机上发图片（YF-14，yoyo 2026-11-11「图片改」）。图和字在聊天里是分开的两条，只有图时先攒着等下一句话。
  imageReceived: '收到图片。再发一句要 Codex 做什么，会跟图片一起交给它。',
  imagesFull: '一次最多带 5 张图片，这张没收。',
  imageTooLarge: '这张图片太大了，电脑没收。请发小一点的，或者截一部分。',
  imagePermissionFeishu: '这张图片电脑没取到。飞书后台要多开一个权限「获取单聊、群组消息」，再发布一个版本。',
  imageFailed: '这张图片电脑没取到，请再发一次。',
} as const

/** 「收到」那句（YF-14）：带着图的说几张，没带图的照旧。 */
export function receivedMessage(imageCount: number): string {
  return imageCount > 0 ? `收到，带着 ${imageCount} 张图片，Codex 开始处理。` : remoteMessages.received
}

/** 飞书进度卡的标题（YF-15，yoyo 2026-11-11「进度改」）：做着的时候、做完、停了、没做完。 */
export const progressCardTitles = {
  running: 'Codex 正在处理',
  done: '做完了',
  stopped: '已停止',
  failed: '没做完',
} as const

/** 进度卡上每一步前面的记号（YF-15）：做完、正在做、还没做。 */
export const progressStepMarks = {
  completed: '✓',
  inProgress: '▶',
  pending: '○',
} as const

/** 进度卡上「停止」那颗按钮（YF-15）：点了跟发「停止」一样。 */
export const progressStopButton = '停止'

const retryPreviewLength = 20

/** 「重试」时先说重发的是哪一句（YF-22）：只带前 20 个字，免得一大段又刷一遍屏。 */
export function retryMessage(text: string): string {
  const characters = [...text.trim().replace(/\s+/g, ' ')]
  const head = characters.slice(0, retryPreviewLength).join('')
  return `再发一次上一条：「${characters.length > retryPreviewLength ? `${head}…` : head}」`
}

/** 闲着自动关时手机上收到的那句（YF-10）：时长跟着设置里选的走；选了「不自动关」时根本不会关，也就不发。 */
export function idleClosedMessage(hours: number): string {
  return `${hours} 小时没有新消息，手机遥控已自动关闭。要再用，请在电脑上的星芒里重新打开。`
}

/** 遥控开着时发的、到电脑时已超过 10 分钟的消息照旧不执行，只给绑定的人回这一句（D66 / YKS-9）。 */
export function staleMessageNotice(minutes: number): string {
  return `这条是 ${minutes} 分钟前发的，那会儿电脑没连上，没有执行。还要做的话请再发一次。`
}

export function turnFailedMessage(reason: string): string {
  return reason ? `这一轮没做完：${reason}` : '这一轮没做完。'
}

/**
 * 这一轮没做完的原因里，客户自己能处理的那几种（D66 / YKS-8）。以前把 Codex 和中转的原话（英文、JSON）
 * 原样发到手机，余额不够也看不出来；认得出的换成下面的大白话，原话只进日志。认不出的照旧发原话，
 * 硬说成「连不上」会让人在跟网络无关的故障上一直等。
 */
export type RemoteTurnFailure = 'balance' | 'keyLimit' | 'login' | 'context' | 'connection'

export const remoteTurnFailureMessages: Readonly<Record<RemoteTurnFailure, string>> = {
  balance: '余额不够了，充值后再发一次。',
  // 单子上的四句里没有这一种（密钥自己设的上限用完了，充值也没用），用软件里已有的那句。
  keyLimit: turnFailedMessage(relayQuotaFailureMessages.keyLimit),
  login: '电脑上的登录失效了，请在电脑上的星芒里重新登录。',
  context: '这段对话太长了，发「新对话」重新开始。',
  connection: '电脑这会儿连不上星芒的线路，过一会儿再发。',
}

interface CodexErrorInfoSummary {
  kind: string
  httpStatusCode: number | null
}

/**
 * Codex's `codexErrorInfo` (checked against rust-v0.167.0,
 * app-server-protocol v2 `CodexErrorInfo`): unit variants arrive as a bare
 * camelCase string ("contextWindowExceeded"), the HTTP ones as a one-key
 * object ({ httpConnectionFailed: { httpStatusCode: 403 } }). Anything else
 * is unknown and yields null.
 */
function readCodexErrorInfo(value: unknown): CodexErrorInfoSummary | null {
  if (typeof value === 'string' && value) return { kind: value, httpStatusCode: null }
  if (!isRecord(value)) return null
  const entries = Object.entries(value)
  if (entries.length !== 1) return null
  const [kind, detail] = entries[0]
  const status = isRecord(detail) ? detail.httpStatusCode : null
  return { kind, httpStatusCode: typeof status === 'number' && Number.isInteger(status) ? status : null }
}

/**
 * A relay answer Codex did not expect becomes `unexpected status 403 Forbidden: <body>`
 * (UnexpectedResponseError's Display); the body is where new-api and Sub2API
 * say whose money ran out, so the classifier reads the status from there when
 * codexErrorInfo carries none.
 */
function statusInMessage(message: string): number | null {
  const match = /unexpected status (\d{3})(?!\d)/.exec(message)
  return match ? Number(match[1]) : null
}

// Codex's transport-level failures. With no HTTP status the request never got
// an answer; with one, only a gateway-class answer counts as "cannot reach".
const connectionErrorKinds: ReadonlySet<string> = new Set([
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts',
])

export function classifyRemoteTurnFailure(message: string, codexErrorInfo: unknown): RemoteTurnFailure | null {
  const info = readCodexErrorInfo(codexErrorInfo)
  const status = info?.httpStatusCode ?? statusInMessage(message)
  // 余额、密钥那几句以服务端写死的原话为准（relay-quota-failure.ts），排在笼统的「连不上」前面。
  const quota = status === null ? null : classifyRelayQuotaFailure(status, message)
  if (quota === 'balance' || quota === 'keyLimit') return quota
  if (quota === 'keyInvalid' || info?.kind === 'unauthorized') return 'login'
  if (info?.kind === 'contextWindowExceeded') return 'context'
  if (info?.kind === 'serverOverloaded') return 'connection'
  if (info && connectionErrorKinds.has(info.kind)) {
    if (info.httpStatusCode === null || isServiceUnavailableResponse({ status: info.httpStatusCode, json: false })) return 'connection'
  }
  return null
}

export function approvalAcceptedMessage(id: string): string {
  return `已同意第 ${id} 条。`
}

export function approvalDeclinedMessage(id: string): string {
  return `已拒绝第 ${id} 条。`
}

export function approvalExpiredMessage(id: string, minutes: number): string {
  return `第 ${id} 条等了 ${minutes} 分钟没回，已自动拒绝。`
}

/** 等你同意的快过期时提醒一次（Fable 手机遥控 YF-20，yoyo 2026-11-11「第三批改」）。 */
export function approvalExpiringMessage(id: string, minutesLeft: number): string {
  return `第 ${id} 条还在等你，${minutesLeft} 分钟后自动拒绝。回「同意 ${id}」或「拒绝 ${id}」。`
}

export function unknownApprovalMessage(id: string): string {
  return `没有第 ${id} 条等你同意的操作。`
}

export function whichApprovalMessage(ids: readonly string[]): string {
  return `现在有 ${ids.length} 条等你同意（${ids.join('、')}），请回「同意 编号」或「拒绝 编号」。`
}

export interface RemoteStatusSummary {
  workspace: string
  running: boolean
  pendingApprovals: number
  /** 这一轮从收到那一刻起过了多久；不在处理时不看（YF-18）。 */
  runningForMs?: number
  /** Codex 计划里正在做的那一步（turn/plan/updated）；没报过计划时不填，就不写「做到…」。 */
  step?: string | null
  /** 账号余额（美元）；没登录、读不到时不填，就没有这一行。 */
  balanceUsd?: number | null
  /** 设置里选的「多久没消息就自动关」；选了「不自动关」（null）就没有这一行。 */
  idleCloseHours?: number | null
}

/**
 * 电脑上打开遥控、第一次连上时给配对过的人发的这一句（Fable 手机遥控 YF-11，yoyo 2026-11-11「第三批改」）。
 * workspace 是已换成 ~ 的工作文件夹，跟「状态」里那行同一种写法。
 */
export function remoteOpenedMessage(workspace: string): string {
  return `电脑上的手机遥控打开了，可以发消息了。工作文件夹：${workspace}`
}

/** 「状态」里「已经多久」那种写法（YF-18）：已经不到 1 分钟、已经 6 分钟、已经 1 小时 5 分钟。 */
export function remoteRunningForText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return '已经不到 1 分钟'
  if (minutes < 60) return `已经 ${minutes} 分钟`
  const rest = minutes % 60
  return rest ? `已经 ${Math.floor(minutes / 60)} 小时 ${rest} 分钟` : `已经 ${Math.floor(minutes / 60)} 小时`
}

/** 美元金额跟电脑上同一种写法：带千分位、两位小数（renderer-v2 的 dollars()）。 */
export function remoteDollars(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const maxStatusStepLength = 30

/**
 * 「状态」的回复（YF-18，yoyo 2026-11-11「状态重试改」）：以前只有工作文件夹和「现在」两行，
 * 现在「现在」带上跑了多久、做到哪一步，再加余额和还有多久自动关，最多四行。读不到的那一样不写。
 * 「状态」这一句本身就让自动关的计时重新起算，所以剩下的总是设置里那个整时长。
 */
export function statusMessage(status: RemoteStatusSummary): string {
  let now = '空闲'
  if (status.pendingApprovals > 0) now = `等你同意 ${status.pendingApprovals} 条`
  else if (status.running) {
    const step = status.step ? status.step.replace(/\s+/g, ' ').trim() : ''
    now = `正在处理，${remoteRunningForText(status.runningForMs ?? 0)}`
    if (step) now += `，做到「${truncateRemoteText(step, maxStatusStepLength)}」`
  }
  const lines = [`工作文件夹：${status.workspace}`, `现在：${now}`]
  if (typeof status.balanceUsd === 'number' && Number.isFinite(status.balanceUsd)) lines.push(`余额：${remoteDollars(status.balanceUsd)}`)
  if (status.idleCloseHours) lines.push(`再过 ${status.idleCloseHours} 小时没新消息就自动关`)
  return lines.join('\n')
}

/**
 * 没有能原地更新的卡片的渠道（微信）每满 5 分钟发的那句（YF-15，yoyo 2026-11-11「进度改」）。
 * 步骤是 Codex 计划里正在做的那一步，没报计划就不写「现在这一步」。
 */
export function progressTextMessage(runningForMs: number, step: string | null): string {
  const shown = step ? step.replace(/\s+/g, ' ').trim() : ''
  const head = `还在做，${remoteRunningForText(runningForMs)}。`
  return shown ? `${head}现在这一步：${truncateRemoteText(shown, maxStatusStepLength)}` : head
}

/**
 * 手机上发「文件夹」的回复（YF-19）：电脑上加过的一个一行，正在用的标出来；不止一个时说怎么切，
 * 举的例子是第一个没在用的。只有一个时说去电脑上加。
 */
export function workspaceListMessage(folders: readonly string[], current: string | null): string {
  const lines = folders.map((folder, index) => `${index + 1}. ${folder}${folder === current ? '（正在用）' : ''}`)
  const other = folders.findIndex((folder) => folder !== current)
  if (folders.length > 1 && other >= 0) lines.push(`回「文件夹 ${other + 1}」切过去。`)
  else lines.push('要换别的，先在电脑上「干活的文件夹」那里添加。')
  return lines.join('\n')
}

/** 手机上切好了文件夹（YF-19）：新文件夹从新对话开始，前面说的 Codex 不记得。 */
export function workspaceSwitchedMessage(folder: string): string {
  return `已切到 ${folder}，从新对话开始。`
}

/** 切的就是正在用的那个（YF-19）。 */
export function workspaceAlreadyInUseMessage(folder: string): string {
  return `现在用的就是 ${folder}。`
}

/** 「文件夹 N」没有第 N 个（YF-19）。 */
export function workspaceMissingMessage(index: number): string {
  return `没有第 ${index} 个文件夹。发「文件夹」看有哪些。`
}

/** 要切过去的文件夹被移走、删掉了（YF-19）：手机上没法重新选，让他回电脑上看。 */
export function workspaceUnusableMessage(folder: string): string {
  return `${folder} 现在打不开了，可能被移走或删掉了。先在电脑上看一下。`
}

/** 做完小结里「用时」那种写法（YF-16）：45 秒、3 分 20 秒、1 小时 5 分。 */
export function remoteTookText(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${minutes} 分`
  return minutes % 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${Math.floor(minutes / 60)} 小时`
}

const maxSummaryFileNames = 3

/**
 * 做完以后接在 Codex 回答后面的那一行（YF-16，yoyo 2026-11-11「状态重试改」）：用了多久、改了哪些文件。
 * fileNames 是这一轮真改成了的文件，只写文件名不写路径，最多列 3 个，其余说「另外 N 个」。
 */
export function turnSummaryLine(tookMs: number, fileNames: readonly string[]): string {
  const took = `用时 ${remoteTookText(tookMs)}`
  if (!fileNames.length) return `${took}。`
  const shown = fileNames.slice(0, maxSummaryFileNames).join('、')
  const more = fileNames.length > maxSummaryFileNames ? `，另外 ${fileNames.length - maxSummaryFileNames} 个` : ''
  return `${took}，改了 ${fileNames.length} 个文件：${shown}${more}。`
}

const approvalTitles: Record<RemoteApprovalKind, string> = {
  command: 'Codex 想运行命令',
  'terminal-input': 'Codex 想往正在运行的程序里输入',
  network: 'Codex 想连网站',
  'file-change': 'Codex 想改文件',
  other: 'Codex 想做一件需要你同意的事',
}

export function approvalTitle(kind: RemoteApprovalKind): string {
  return approvalTitles[kind]
}

/** 没有按钮的渠道发这一段；有按钮的渠道也把它当卡片正文。 */
export function formatApprovalText(request: RemoteApprovalRequest): string {
  return `${formatApprovalBody(request)}\n回「同意 ${request.approvalId}」或「拒绝 ${request.approvalId}」。`
}

/** 审批的正文（要做什么、在哪、为什么），不带「回 同意 N」那句：处理过的卡片只留这些（YK-8，「同意卡改」一并批的）。 */
export function formatApprovalBody(request: RemoteApprovalRequest): string {
  const lines = [`${approvalTitle(request.kind)}（第 ${request.approvalId} 条）：`]
  if (request.summary) lines.push(request.summary)
  if (request.cwd) lines.push(`在：${request.cwd}`)
  if (request.reason) lines.push(`原因：${request.reason}`)
  return lines.join('\n')
}

/** 处理过的审批卡的标题（YK-8，yoyo 2026-11-11「同意卡改」）。 */
export function approvalOutcomeTitle(outcome: RemoteApprovalOutcome, id: string): string {
  if (outcome === 'accepted') return `已同意（第 ${id} 条）`
  if (outcome === 'expired') return `没回，已自动拒绝（第 ${id} 条）`
  return `已拒绝（第 ${id} 条）`
}

/** 改文件审批卡上一行说的那个文件，路径已经换成手机上显示的样子。 */
export interface RemoteFileChangeLine {
  /** Codex 的 PatchChangeKind；老版本 Codex 不给时是 null，只列路径。 */
  kind: 'add' | 'delete' | 'update' | null
  path: string
  /** 改完挪到的位置（Update 带 move_path 时）。 */
  movePath?: string
  /** 加了、删了多少行；Codex 没给改动内容时不填，这一行就不带行数。 */
  added?: number
  removed?: number
}

/**
 * 改文件卡片上的一行（D66 / YKS-10）：前面写新建、删除、改、挪到，后面带「+12 -3 行」。
 * 删文件和改一行以前在手机上长得一样，客户没法判断该不该同意。
 */
export function formatFileChangeLine(change: RemoteFileChangeLine): string {
  let line = change.path
  if (change.kind === 'add') line = `新建 ${change.path}`
  else if (change.kind === 'delete') line = `删除 ${change.path}`
  else if (change.kind === 'update') line = change.movePath ? `${change.path} 挪到 ${change.movePath}` : `改 ${change.path}`
  return change.added === undefined || change.removed === undefined ? line : `${line} +${change.added} -${change.removed} 行`
}

export type RemoteCommand =
  | { kind: 'prompt'; text: string }
  | { kind: 'new-thread' }
  | { kind: 'stop' }
  | { kind: 'status' }
  | { kind: 'help' }
  | { kind: 'close' }
  | { kind: 'retry' }
  /** 「文件夹」列出电脑上加过的，「文件夹 2」切到第 2 个（YF-19）；index 从 1 数。 */
  | { kind: 'folders' }
  | { kind: 'use-folder'; index: number }
  | { kind: 'approval'; decision: 'accept' | 'decline'; approvalId?: string }

const plainCommands: Record<string, RemoteCommand['kind']> = {
  新对话: 'new-thread',
  停止: 'stop',
  状态: 'status',
  帮助: 'help',
  关闭遥控: 'close',
  重试: 'retry',
  文件夹: 'folders',
}

/**
 * 只认整条消息就是指令的（前面可以带 / 或全角／）。「同意」「拒绝」只在有等你同意的操作时才算指令，
 * 别的时候照常交给 Codex：「拒绝」两个字本身也可能是客户想说的话。
 */
export function parseRemoteCommand(text: string, hasPendingApprovals: boolean): RemoteCommand {
  const trimmed = text.trim()
  const bare = trimmed.replace(/^[/／]\s*/, '')
  const plain = plainCommands[bare]
  if (plain === 'new-thread' || plain === 'stop' || plain === 'status' || plain === 'help' || plain === 'close' || plain === 'retry' || plain === 'folders') return { kind: plain }
  const folder = /^文件夹\s*(\d{1,2})$/.exec(bare)
  if (folder) return { kind: 'use-folder', index: Number(folder[1]) }
  if (hasPendingApprovals) {
    const match = /^(同意|拒绝)(?:\s*(?:第\s*)?(\d{1,4})\s*条?)?$/.exec(bare)
    if (match) {
      return {
        kind: 'approval',
        decision: match[1] === '同意' ? 'accept' : 'decline',
        ...(match[2] ? { approvalId: String(Number(match[2])) } : {}),
      }
    }
  }
  return { kind: 'prompt', text: trimmed }
}

/** 配对码只认整条消息就是这 6 位数字（中间、两边的空格不算）。 */
export function normalizePairingAttempt(text: string): string | null {
  const compact = text.replace(/\s+/g, '')
  return /^\d{6}$/.test(compact) ? compact : null
}

export interface RemoteRedactionOptions {
  /** 一定要遮住的原值：当前 Codex 用的密钥、渠道自己的密钥。 */
  secrets: readonly string[]
  homeDirectory: string
  platform?: NodeJS.Platform
}

/**
 * 主目录换成 ~。redactHomeDirectory 在 Windows、Mac 上写 %USERPROFILE%，那是给客服看日志的；
 * 手机上给客户自己看，统一写 ~ 好认。
 */
export function remoteDisplayPath(text: string, homeDirectory: string, platform?: NodeJS.Platform): string {
  return redactHomeDirectory(text, homeDirectory, platform).split('%USERPROFILE%').join('~')
}

/** 发出电脑的每一段字都过这里（I13）：认得出形状的密钥、点名的原值、主目录路径。 */
export function redactRemoteText(text: string, options: RemoteRedactionOptions): string {
  let result = text
  const secrets = [...new Set(options.secrets.filter((secret) => secret.length >= 6))]
    .sort((left, right) => right.length - left.length)
  for (const secret of secrets) result = result.split(secret).join('[已隐去]')
  result = redactSecretPatterns(result).split('[REDACTED]').join('[已隐去]')
  return remoteDisplayPath(result, options.homeDirectory, options.platform)
}

export function truncateRemoteText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`
}

/**
 * 按渠道的长度上限切成几条，尽量在换行处断开；超过条数上限的部分不发，最后一条末尾说明。
 * 一次回答最多发这么几条，免得一个超长输出刷屏、吃光飞书免费版的调用次数。
 */
export function splitRemoteText(text: string, maxLength: number, maxChunks: number): string[] {
  const chunks: string[] = []
  let rest = text.trim()
  const notice = '\n…（后面太长，没有发完，请到电脑上看）'
  while (rest && chunks.length < maxChunks) {
    if (rest.length <= maxLength) {
      chunks.push(rest)
      rest = ''
      break
    }
    const window = rest.slice(0, maxLength)
    const breakAt = window.lastIndexOf('\n')
    const cut = breakAt > maxLength / 2 ? breakAt : maxLength
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest && chunks.length) {
    const last = chunks[chunks.length - 1]
    chunks[chunks.length - 1] = `${last.slice(0, Math.max(0, maxLength - notice.length))}${notice}`
  }
  return chunks
}
