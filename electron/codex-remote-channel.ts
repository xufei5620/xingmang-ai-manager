// 手机遥控 Codex 的渠道接口：飞书、微信这类聊天渠道只管「收消息、发消息」，配对、审批、
// 会话、脱敏、启停都在底座（codex-remote-service.ts）里做，两个渠道守的是同一条安全底线。
//
// Security posture shared by every channel: whoever can make the bound chat
// account send a message can make Codex act on this computer. The core
// therefore owns every decision -- who is bound, which approvals are pending,
// what text leaves the machine -- and a channel only translates between its
// platform and these shapes. A channel must never execute, approve or reply on
// its own, must never log message text (I13), and must hand the core only what
// it received from the platform.

/** 渠道列表。加一个渠道先加在这里，编译器会带着把工厂和界面补齐。 */
export const remoteChannelIds = ['feishu'] as const

export type RemoteChannelId = typeof remoteChannelIds[number]

export function isRemoteChannelId(value: unknown): value is RemoteChannelId {
  return typeof value === 'string' && (remoteChannelIds as readonly string[]).includes(value)
}

/** 平台给的发送人。userId 是平台里稳定的那个编号（飞书 open_id、微信 iLink 的用户编号）。 */
export interface RemotePeer {
  channel: RemoteChannelId
  userId: string
  /** 平台给的昵称，只用来在界面上认人，绝不参与判断是不是绑定的那个人。 */
  displayName?: string
}

interface RemoteInboundBase {
  peer: RemotePeer
  /** 只有一对一私聊为 true；群里来的消息底座一律丢掉。 */
  direct: boolean
  /**
   * 回这条消息要带的平台句柄（微信的 context_token、飞书的 message_id）。底座不解读它，
   * 往这个人回消息时原样交还 send()。没有就不填。
   */
  replyContext?: string
}

export interface RemoteInboundText extends RemoteInboundBase {
  kind: 'text'
  /** 平台的消息编号，底座拿它去重（长轮询重连、飞书重投都会送重）。 */
  messageId: string
  text: string
}

/** 有按钮的渠道（飞书卡片）点了按钮。没按钮的渠道不用发这个：回「同意 3」这类文字由底座认。 */
export interface RemoteInboundApproval extends RemoteInboundBase {
  kind: 'approval'
  approvalId: string
  decision: RemoteApprovalDecision
}

export type RemoteInbound = RemoteInboundText | RemoteInboundApproval

export type RemoteApprovalDecision = 'accept' | 'decline'

export type RemoteApprovalKind = 'command' | 'file-change' | 'other'

/** 底座发出的审批请求，跟渠道无关。渠道自己决定画成按钮还是文字。 */
export interface RemoteApprovalRequest {
  /** 底座编的短编号（"1"、"2"…），一次会话里不重复。 */
  approvalId: string
  kind: RemoteApprovalKind
  /** 要跑的命令或要改的文件，已脱敏、已截断。 */
  summary: string
  /** 工作目录，主目录已换成 ~。 */
  cwd?: string
  /** Codex 自己说的理由，已脱敏、已截断。 */
  reason?: string
}

export interface RemoteOutboundText {
  kind: 'text'
  /** 已脱敏、已按渠道的长度上限切好的纯文本。 */
  text: string
}

export interface RemoteOutboundApproval {
  kind: 'approval'
  request: RemoteApprovalRequest
  /** 底座写好的纯文字版（含「回 同意 1 / 拒绝 1」），没按钮的渠道直接发它。 */
  text: string
}

export type RemoteOutbound = RemoteOutboundText | RemoteOutboundApproval

export type RemoteChannelState =
  | 'stopped'
  | 'connecting'
  | 'connected'
  /** 凭据失效（微信令牌过期、飞书密钥被重置），要客户在电脑上重新登录或重新填。 */
  | 'needs-login'
  | 'error'

export interface RemoteChannelStatus {
  state: RemoteChannelState
  /** 能上屏的中文原因，不带平台原文里的令牌和消息内容。 */
  message?: string
}

export interface RemoteChannelCapabilities {
  /** 能不能发带按钮的审批（飞书卡片）。 */
  approvalButtons: boolean
  /** 一条文本消息最多多少个字（按 JS 字符串长度算），底座据此切分。 */
  maxTextLength: number
}

export interface RemoteChannelHandlers {
  onInbound(message: RemoteInbound): void
  onStatus(status: RemoteChannelStatus): void
}

export interface RemoteChannelAdapter {
  readonly id: RemoteChannelId
  readonly capabilities: RemoteChannelCapabilities
  /** 连上平台开始收消息；断了自己重连。凭据不对时报 needs-login，不要无限重试。 */
  start(handlers: RemoteChannelHandlers): Promise<void>
  /** 停掉连接和所有定时器；可以重复调用。 */
  stop(): Promise<void>
  /** 发一条消息给这个人；replyContext 是这个人最近一条入站消息带来的那个。失败就抛，底座记日志。 */
  send(peer: RemotePeer, message: RemoteOutbound, replyContext?: string): Promise<void>
}

export type RemoteChannelLogLevel = 'info' | 'warn' | 'error'

/** 只许记事件名和不含消息正文、令牌的小字段（I13）。 */
export type RemoteChannelLogDetail = Record<string, string | number | boolean | null>

export interface RemoteChannelDependencies {
  /** 主进程给的 fetch（走系统代理，'manual' 重定向已修好）。请求一律用 codex-remote-http.ts。 */
  fetch: typeof fetch
  /** 读、写这个渠道自己的凭据（JSON 字符串，底座用 safeStorage 加密落盘）。 */
  readCredential(): Promise<string | null>
  writeCredential(value: string | null): Promise<void>
  log(level: RemoteChannelLogLevel, event: string, detail?: RemoteChannelLogDetail): void
  now(): number
}
