export const providerIds = ['claude', 'codex', 'grok', 'gemini'] as const

export type ProviderId = (typeof providerIds)[number]

// Gemini CLI 下线（yoyo 2026-10-14）：星芒不再显示、安装、签 Key、改配置。它仍留在
// ProviderId 里，因为客户电脑上已经存着按它认的数据——本机 Key 缓存整份校验（认不得
// 就整份作废、全部工具重签）、备份清单、卸载时按工具收回提醒——拿掉会把这些一起弄坏。
// 「替每个工具做点什么」的地方一律走 activeProviderIds；只有读老数据、收拾星芒自己
// 留下的东西才认退役的那几个。
export const retiredProviderIds = ['gemini'] as const satisfies readonly ProviderId[]

export type RetiredProviderId = (typeof retiredProviderIds)[number]

export type ActiveProviderId = Exclude<ProviderId, RetiredProviderId>

export function isRetiredProviderId(value: unknown): value is RetiredProviderId {
  return typeof value === 'string' && (retiredProviderIds as readonly string[]).includes(value)
}

export const activeProviderIds: readonly ActiveProviderId[] = providerIds.filter(
  (provider): provider is ActiveProviderId => !isRetiredProviderId(provider),
)

export function isActiveProviderId(value: unknown): value is ActiveProviderId {
  return isProviderId(value) && !isRetiredProviderId(value)
}

export interface CliDefinition {
  id: ProviderId
  name: string
  company: string
  command: string
  packageName: string
  versionArgs: string[]
}

export const cliCatalog: Record<ProviderId, CliDefinition> = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    company: 'Anthropic',
    command: 'claude',
    packageName: '@anthropic-ai/claude-code',
    versionArgs: ['--version'],
  },
  codex: {
    id: 'codex',
    name: 'Codex CLI',
    company: 'OpenAI',
    command: 'codex',
    packageName: '@openai/codex',
    versionArgs: ['--version'],
  },
  grok: {
    id: 'grok',
    name: 'Grok CLI',
    company: 'xAI',
    command: 'grok',
    packageName: '@xai-official/grok',
    versionArgs: ['--version'],
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini CLI',
    company: 'Google',
    command: 'gemini',
    packageName: '@google/gemini-cli',
    versionArgs: ['--version'],
  },
}

export interface ManagedCliKeyProfile {
  group: string
  keyName: string
}

// The account-side token group each local CLI must use. Kept beside
// providerIds so the main-process provisioning code and renderer UI cannot
// drift onto different group names or provider coverage.
// xm 站 2026-10-14 改了分组本名，10-16 删了老名字（见下面的 retiredAccountGroups）。
// 服务状态文件的分组对照读不到时，这里的名字就是签 Key 的分组，所以必须是新名字。
export const managedCliKeyProfiles: Record<ProviderId, ManagedCliKeyProfile> = {
  claude: { group: 'Claude-MAX', keyName: 'xingmang-desktop-claude' },
  codex: { group: 'GPT', keyName: 'xingmang-desktop-codex' },
  grok: { group: 'Grok', keyName: 'xingmang-desktop-grok' },
  gemini: { group: 'Gemini', keyName: 'xingmang-desktop-gemini' },
}

/**
 * xm 站删掉的老分组名 → 现在的名字。服务端删之前把老名字下的 Key 全挂到了新名字下（Key 本身不变），
 * 所以本机还记着老名字的（托管 Key 缓存、聊天记录里选过的分组）照这张表换成新名字就对得上。
 * 只是 xm 站的名字；历史账号那套后端的分组是另一份，不查这张表。
 */
export const retiredAccountGroups: ReadonlyMap<string, string> = new Map([
  ['Claude-MAX订阅', 'Claude-MAX'],
  ['GPT-中转/订阅', 'GPT'],
  ['Grok-中转/订阅', 'Grok'],
  ['Gemini-中转/订阅', 'Gemini'],
  ['图片模型-中转/订阅', '图片模型'],
  ['视频模型-中转/订阅', '视频模型'],
])

/** 老名字换成现在的名字；不是老名字的原样返回。 */
export function currentAccountGroupName(group: string): string {
  return retiredAccountGroups.get(group) ?? group
}

export const sub2ApiManagedCliKeyProfiles: Record<ProviderId, ManagedCliKeyProfile> = {
  claude: { group: 'Claude-MAX(不限客户端)', keyName: 'xingmang-desktop-claude' },
  codex: { group: 'Codex_pro', keyName: 'xingmang-desktop-codex' },
  grok: { group: 'grok-heavy', keyName: 'xingmang-desktop-grok' },
  gemini: { group: 'Gemini', keyName: 'xingmang-desktop-gemini' },
}

export function resolveManagedCliKeyProfiles(siteId?: string): Record<ProviderId, ManagedCliKeyProfile> {
  return siteId === 'solov-api' ? sub2ApiManagedCliKeyProfiles : managedCliKeyProfiles
}

// new-api 按 UTF-8 字节数限令牌名 50（rc.44 controller/token.go AddToken 的 len(token.Name) > 50），
// 用户名最长 20 个字、可以是中文，所以按字节截，不按字数截。
const accountKeyNameMaxBytes = 50

function utf8Length(text: string): number {
  let bytes = 0
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0
    bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4
  }
  return bytes
}

function truncateUtf8(text: string, maxBytes: number): string {
  let kept = ''
  let bytes = 0
  for (const char of text) {
    bytes += utf8Length(char)
    if (bytes > maxBytes) break
    kept += char
  }
  return kept
}

/**
 * 星芒在 xm 站新签的密钥叫「用户名-分组」，比如 yoyo-Claude-MAX：站长在后台的令牌和日志里一眼看出是谁的、
 * 哪个分组的（yoyo 10-16）。suffix 接在分组后面，AI 对话签的是 yoyo-GPT-对话，跟同分组命令行工具的分开。
 * 以前签好的不改名。太长先截用户名，分组尽量留全。用户名或分组是空的返回 null，调用方照旧用原来的名字。
 * 历史账号那套后端不走这里。
 */
export function buildAccountKeyName(username: string, group: string, suffix?: string): string | null {
  const user = username.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!user || !group.trim()) return null
  const tail = `-${group.trim()}${suffix ? `-${suffix}` : ''}`
  const head = truncateUtf8(user, accountKeyNameMaxBytes - utf8Length(tail))
  return (head ? `${head}${tail}` : truncateUtf8(`${user}${tail}`, accountKeyNameMaxBytes)).trim()
}

// 老板拍板(2026-08-10):中转与账号后端统一到 new-api 生产实例
// xm.solov.cc——CLI 的 AI 请求和注册/登录/Key 签发从此同域。原
// api.solov.cc 不再出现在任何写入 CLI 的配置里;老用户配置里的旧域会被
// matchesRelay 判为不匹配,走登录→重新写 Key 的迁移路径。老板拍板
// (2026-08-12):Codex 与 Grok 使用 /v1,Claude 与 Gemini 使用裸域。
export const providerBaseUrls: Record<ProviderId, string> = {
  claude: 'https://xm.solov.cc',
  codex: 'https://xm.solov.cc/v1',
  grok: 'https://xm.solov.cc/v1',
  gemini: 'https://xm.solov.cc',
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && providerIds.includes(value as ProviderId)
}

// 每个 CLI 在用户主目录下的配置目录名。主进程的 providerConfigRoot 与 v2
// 渲染层的工具注册表都读这一张表,免得同一个目录在两侧各写一遍、加第五个
// CLI 时只改了其中一处(审查总表 R-S11)。Codex 是唯一可被 CODEX_HOME 改写
// 落点的工具,这里给出的仍是它的默认目录名。
export const providerConfigDirectoryNames: Record<ProviderId, string> = {
  claude: '.claude',
  codex: '.codex',
  grok: '.grok',
  gemini: '.gemini',
}
