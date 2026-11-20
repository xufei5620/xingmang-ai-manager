import path from 'node:path'
import {
  ensureSafeDataDirectory,
  readSafeUtf8File,
  removeSafeDataFile,
  writeAtomicSafeUtf8File,
} from './safe-local-data'
import type { SafeStorageLike } from './account-session-store'
import { inspectSafeStorageBackend, resolveCredentialPersistence } from './safe-storage-backend'
import { isRecord } from './input-guards'
import { isRemoteChannelId, isRemoteIdleCloseHours, isRemoteModel, type RemoteChannelId, type RemoteIdleCloseHours } from './codex-remote-channel'

// 手机遥控的两份本地数据：设置（开没开、绑定了谁、工作文件夹，不含密钥）和每个渠道的凭据
// （飞书 App Secret、微信机器人令牌，safeStorage 加密）。凭据是本程序自己连平台用的登录凭据，
// 跟 account-credential-store.ts 同一个口径加密落盘，不是 AGENTS.md「不给 API Key 加密」说的那把。

const settingsFileName = 'settings.json'
const maxSettingsBytes = 64 * 1024
const maxCredentialBytes = 64 * 1024
const settingsLabel = '手机遥控设置'
const credentialLabel = '手机遥控凭据'
const maxDisplayNameLength = 64
const maxUserIdLength = 256
const maxAccountLabelLength = 128
const maxMessageIdLength = 128
/**
 * 每个渠道记下最近处理过的几条消息编号（YR-2）。重开星芒以后只有开启前 1 分钟以内发的还会放行，
 * 要盖住的只是重开前那一两分钟里处理过的，100 条足够。
 */
export const maxRecentMessageIds = 100
/** 电脑上最多加几个干活的文件夹（YF-19）：手机上回「文件夹 2」要好认，列出来一屏看得完。 */
export const maxRemoteWorkspaces = 5

/**
 * 设置文件在、这会儿却读不出来（比如 Windows 上杀毒软件正占着它）时，改设置那一下上屏这句，文件不动（M09）。
 * 以前读不出来就当没设过，下一次改开关拿空设置整份写回，加过的文件夹、绑定的人、自动关的时长全没了。
 */
export const settingsUnreadableMessage = '这次没改成：电脑上保存的手机遥控设置这会儿读不出来，为了不弄丢原来的设置，先没动。请过一会儿再试一次。'

/** 「退出登录」删不掉凭据文件时上屏那句（#1407 P3-6）。比如 Windows 上文件正被杀毒软件占着，重启后再删一般就行。 */
export const credentialRemoveFailedMessage = '没能删掉保存的登录信息，请重启星芒后再点一次退出登录。'

export interface CodexRemoteBoundPeer {
  userId: string
  displayName?: string
  boundAt: number
}

/**
 * 「开没开」不落盘：每次打开星芒遥控都从关着开始，要客户在电脑上点一次才连，
 * 免得开机自启的星芒在没人看着时就把这台电脑交给手机。客户自己打开了「打开星芒时自动打开遥控」
 * （设置里的 autoStart，默认关，YF-9）才替他连，连的也只是配对过人的渠道。
 */
export interface CodexRemoteChannelSettings {
  /** 界面上认账号用的非机密字样（飞书 App ID、微信昵称）。 */
  accountLabel: string | null
  boundPeer: CodexRemoteBoundPeer | null
  /**
   * 绑定的人最近发来、已经处理过的消息编号（YR-2），按先后，最多 maxRecentMessageIds 条。重开星芒以后平台
   * 可能把上次处理过的再送一遍（微信每次打开都从头拉），开启前 1 分钟以内发的还会放行，靠它认出来不再做一遍。
   * 缺省 = 没记过。
   */
  recentMessageIds?: string[]
}

export interface CodexRemoteSettings {
  version: 1
  /** 正在用的那个文件夹。 */
  workspaceDirectory: string | null
  /**
   * 电脑上加过的全部文件夹（YF-19），按加的先后，含正在用的那个，最多 maxRemoteWorkspaces 个；手机上「文件夹 2」
   * 认的就是这个次序。缺省 = 只有 workspaceDirectory 那一个（以前的版本只能选一个）。
   */
  workspaceDirectories?: string[]
  channels: Partial<Record<RemoteChannelId, CodexRemoteChannelSettings>>
  /**
   * 上一条审批用到的编号（0 = 还没有过）。重开星芒接着往下数：手机上还留着上次的「同意 1」，
   * 不能落到这次新的第 1 条头上。
   */
  lastApprovalNumber: number
  /**
   * 「打开星芒时自动打开遥控」（YF-9，yoyo 2026-11-11 亲手打字「遥控自动开，做」）。缺省 = 关：
   * 只有客户在设置里自己打开了才存 true，读回来也只认 true。
   */
  autoStart?: boolean
  /**
   * 「多久没消息就自动关」（YF-10，yoyo 2026-11-11 亲手打字「不自动关」「默认不关」）。缺省 = 不自动关：
   * 只有客户选了 4 小时或 12 小时才存，读回来也只认这两个数。以前的版本固定 4 小时，升上来也是不自动关
   * （yoyo 同日亲手回「老客户也不关」，知道遥控开着电脑不自动睡）。
   */
  idleCloseHours?: RemoteIdleCloseHours
  /**
   * 「手机上用的模型」单独选的型号（yoyo 2026-11-19「改」）。缺省 = 跟电脑上的 Codex 一样：只有客户在电脑上选了
   * 别的才存，读回来也只认长得像型号名的（isRemoteModel）。
   */
  model?: string
}

export function emptyCodexRemoteSettings(): CodexRemoteSettings {
  return { version: 1, workspaceDirectory: null, channels: {}, lastApprovalNumber: 0 }
}

export function emptyChannelSettings(): CodexRemoteChannelSettings {
  return { accountLabel: null, boundPeer: null }
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null
}

function parseBoundPeer(value: unknown): CodexRemoteBoundPeer | null {
  if (!isRecord(value)) return null
  const userId = boundedString(value.userId, maxUserIdLength)
  if (!userId || typeof value.boundAt !== 'number' || !Number.isFinite(value.boundAt)) return null
  const displayName = boundedString(value.displayName, maxDisplayNameLength)
  return { userId, boundAt: value.boundAt, ...(displayName ? { displayName } : {}) }
}

/** 把这条消息编号记到最后（记过的挪到最后），只留最近 maxRecentMessageIds 条；编号太长的不记。 */
export function appendRecentMessageId(list: readonly string[] | undefined, messageId: string): string[] {
  const next = (list ?? []).filter((entry) => entry !== messageId)
  if (boundedString(messageId, maxMessageIdLength)) next.push(messageId)
  return next.slice(-maxRecentMessageIds)
}

function parseRecentMessageIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  let list: string[] = []
  for (const entry of value) {
    const messageId = boundedString(entry, maxMessageIdLength)
    if (messageId) list = appendRecentMessageId(list, messageId)
  }
  return list
}

/** 读回来的设置当外来输入：认不出的字段丢掉，坏了就当没设过（同 I5 的口径）。 */
export function parseCodexRemoteSettings(value: unknown): CodexRemoteSettings {
  const settings = emptyCodexRemoteSettings()
  if (!isRecord(value) || value.version !== 1) return settings
  const workspace = boundedString(value.workspaceDirectory, 4096)
  settings.workspaceDirectory = workspace && path.isAbsolute(workspace) ? workspace : null
  if (Array.isArray(value.workspaceDirectories)) {
    const list: string[] = []
    for (const entry of value.workspaceDirectories) {
      const directory = boundedString(entry, 4096)
      if (directory && path.isAbsolute(directory) && !list.includes(directory) && list.length < maxRemoteWorkspaces) list.push(directory)
    }
    // 正在用的那个一定在单子上；单子满了也不挤掉它，挤掉最后加的那个。
    if (settings.workspaceDirectory && !list.includes(settings.workspaceDirectory)) {
      list.splice(maxRemoteWorkspaces - 1, list.length, settings.workspaceDirectory)
    }
    if (list.length > 1) settings.workspaceDirectories = list
  }
  const lastApprovalNumber = value.lastApprovalNumber
  if (typeof lastApprovalNumber === 'number' && Number.isSafeInteger(lastApprovalNumber) && lastApprovalNumber > 0) {
    settings.lastApprovalNumber = lastApprovalNumber
  }
  if (value.autoStart === true) settings.autoStart = true
  if (isRemoteIdleCloseHours(value.idleCloseHours)) settings.idleCloseHours = value.idleCloseHours
  if (isRemoteModel(value.model)) settings.model = value.model
  if (isRecord(value.channels)) {
    for (const [id, raw] of Object.entries(value.channels)) {
      if (!isRemoteChannelId(id) || !isRecord(raw)) continue
      const recentMessageIds = parseRecentMessageIds(raw.recentMessageIds)
      settings.channels[id] = {
        accountLabel: boundedString(raw.accountLabel, maxAccountLabelLength),
        boundPeer: parseBoundPeer(raw.boundPeer),
        ...(recentMessageIds.length > 0 ? { recentMessageIds } : {}),
      }
    }
  }
  return settings
}

/** 电脑上加过的文件夹（YF-19），正在用的那个在里面；一个都没加过是空的。 */
export function remoteWorkspaceList(settings: Pick<CodexRemoteSettings, 'workspaceDirectory' | 'workspaceDirectories'>): string[] {
  if (settings.workspaceDirectories?.length) return [...settings.workspaceDirectories]
  return settings.workspaceDirectory ? [settings.workspaceDirectory] : []
}

export class CodexRemoteStore {
  private writeQueue: Promise<void> = Promise.resolve()
  private settings: CodexRemoteSettings | null = null
  /** Linux 没有密钥环时凭据只留在这次运行的内存里。 */
  private readonly memoryCredentials = new Map<RemoteChannelId, string>()

  constructor(
    private readonly directory: string,
    private readonly storage: SafeStorageLike,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  /**
   * 给界面和收消息用：读不出来时先当没设过，但不记下来，下次再读（M09）。要改设置走 updateSettings，
   * 它读不出来就不改。
   */
  async readSettings(): Promise<CodexRemoteSettings> {
    try {
      return await this.loadSettings()
    } catch {
      return emptyCodexRemoteSettings()
    }
  }

  updateSettings(mutate: (settings: CodexRemoteSettings) => void): Promise<CodexRemoteSettings> {
    return this.enqueue(async () => {
      const current = structuredClone(await this.loadSettings())
      mutate(current)
      const next = parseCodexRemoteSettings(current)
      ensureSafeDataDirectory(this.directory, settingsLabel)
      await writeAtomicSafeUtf8File(this.settingsPath(), `${JSON.stringify(next, null, 2)}\n`, settingsLabel)
      this.settings = next
      return next
    })
  }

  /**
   * 「还没有这个文件」（第一次用）和「文件在、这会儿读不出来」是两回事（M09）：前者就是没设过，记下来；
   * 后者抛 settingsUnreadableMessage、什么都不记，免得把读失败当成空设置存着，下一次改开关整份写回去。
   * 文件读出来了但内容坏了，照旧当没设过（parseCodexRemoteSettings 的口径），不然这份设置永远改不了。
   */
  private async loadSettings(): Promise<CodexRemoteSettings> {
    if (this.settings) return this.settings
    let content: string | null
    try {
      content = await readSafeUtf8File(this.settingsPath(), settingsLabel, maxSettingsBytes)
    } catch (error) {
      // 查的时候还在、打开时已经没了，跟没有一样。
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(settingsUnreadableMessage, { cause: error })
      content = null
    }
    let parsed: unknown = null
    if (content) {
      try {
        parsed = JSON.parse(content)
      } catch {
        parsed = null
      }
    }
    this.settings = parseCodexRemoteSettings(parsed)
    return this.settings
  }

  /** 这台电脑能不能把凭据存到下次打开：durable 能，session-only 只到这次关掉，unavailable 存不了。 */
  credentialPersistence(): 'durable' | 'session-only' | 'unavailable' {
    const backend = inspectSafeStorageBackend(this.storage)
    if (resolveCredentialPersistence(this.platform, backend) === 'session-only') return 'session-only'
    return backend === 'ok' ? 'durable' : 'unavailable'
  }

  async readCredential(channel: RemoteChannelId): Promise<string | null> {
    const persistence = this.credentialPersistence()
    if (persistence === 'session-only') return this.memoryCredentials.get(channel) ?? null
    if (persistence === 'unavailable') return null
    const content = await readSafeUtf8File(this.credentialPath(channel), credentialLabel, maxCredentialBytes).catch(() => null)
    if (!content) return null
    try {
      return this.storage.decryptString(Buffer.from(content, 'base64'))
    } catch {
      return null
    }
  }

  writeCredential(channel: RemoteChannelId, value: string | null): Promise<void> {
    return this.enqueue(async () => {
      const persistence = this.credentialPersistence()
      if (value === null) {
        this.memoryCredentials.delete(channel)
        try {
          await removeSafeDataFile(this.credentialPath(channel), credentialLabel)
        } catch (error) {
          // 查的时候还在、删的时候已经没了，也算删掉了。别的失败不能当成功：凭据还留在电脑上，
          // 下次打开照样登着，客户却以为退出了。原来的错误挂在 cause 上进运行日志。
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
          throw new Error(credentialRemoveFailedMessage, { cause: error })
        }
        return
      }
      if (persistence === 'unavailable') throw new Error('这台电脑没法安全保存密码，凭据没有保存。')
      if (persistence === 'session-only') {
        this.memoryCredentials.set(channel, value)
        return
      }
      ensureSafeDataDirectory(this.directory, credentialLabel)
      await writeAtomicSafeUtf8File(
        this.credentialPath(channel),
        this.storage.encryptString(value).toString('base64'),
        credentialLabel,
      )
    })
  }

  private settingsPath(): string {
    return path.join(this.directory, settingsFileName)
  }

  private credentialPath(channel: RemoteChannelId): string {
    return path.join(this.directory, `credential-${channel}.bin`)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation, operation)
    this.writeQueue = next.then(() => undefined, () => undefined)
    return next
  }
}
