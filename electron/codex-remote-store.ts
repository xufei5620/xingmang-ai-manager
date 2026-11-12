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
import { isRemoteChannelId, isRemoteIdleCloseHours, type RemoteChannelId, type RemoteIdleCloseHours } from './codex-remote-channel'

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
/** 电脑上最多加几个干活的文件夹（YF-19）：手机上回「文件夹 2」要好认，列出来一屏看得完。 */
export const maxRemoteWorkspaces = 5

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
  if (isRecord(value.channels)) {
    for (const [id, raw] of Object.entries(value.channels)) {
      if (!isRemoteChannelId(id) || !isRecord(raw)) continue
      settings.channels[id] = {
        accountLabel: boundedString(raw.accountLabel, maxAccountLabelLength),
        boundPeer: parseBoundPeer(raw.boundPeer),
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

  async readSettings(): Promise<CodexRemoteSettings> {
    if (this.settings) return this.settings
    const content = await readSafeUtf8File(this.settingsPath(), settingsLabel, maxSettingsBytes).catch(() => null)
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

  updateSettings(mutate: (settings: CodexRemoteSettings) => void): Promise<CodexRemoteSettings> {
    return this.enqueue(async () => {
      const current = structuredClone(await this.readSettings())
      mutate(current)
      const next = parseCodexRemoteSettings(current)
      ensureSafeDataDirectory(this.directory, settingsLabel)
      await writeAtomicSafeUtf8File(this.settingsPath(), `${JSON.stringify(next, null, 2)}\n`, settingsLabel)
      this.settings = next
      return next
    })
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
