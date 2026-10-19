// 一键检测里「电脑里另外设过的设置」那几项（#1070 第 9 步，从 diagnostics.ts 的 runDiagnostics 原样搬来）：环境变量和
// Mac 终端设置文件里另外设的工具地址、密钥（会不会盖过当前账号、Windows 上能不能一键清掉，还有被忽略的 CODEX_HOME）、
// 项目文件夹里的设置、Codex 文件夹里的 .env、Claude Code 跑命令前问不问、个人文件夹里早先留下的项目说明和信任设置。
// 「点这里就好」清环境变量用的名单 environmentOverrideNames 也在这里（diagnostic-fixes.ts 对照它）。
//
// 各类检查共用的那份在 diagnostics-context.ts；这里只 import diagnostics.ts 的类型，免得两个文件互相 require。
import fs from 'node:fs'
import path from 'node:path'
import { readBoundedUtf8FileSync } from './bounded-file'
import { activeProviderIds, cliCatalog, isRetiredProviderId, providerConfigDirectoryNames, type ProviderId } from './catalog'
import type { IgnoredCodexHome, ProviderConfigRoots } from './codex-home'
import { inspectHomeFolderTrust, providerAccountMode, type HomeFolderTrustProvider, type NativeConfigInspection } from './config-files'
import type { CheckDefinition, CheckOutcome, DiagnosticsRelayRoute } from './diagnostics'
import { errorChainText, isRecord, type DiagnosticsContext } from './diagnostics-context'
import { pathForDisplay } from './diagnostics-redaction'
import { hasUntouchedHomeProjectInstructions } from './project-instructions'
import type { RelaySite } from './relay-sites'
import { readSafeUtf8File } from './safe-local-data'
import { parseShellStartupExports, type ShellStartupDialect, type ShellStartupExport } from './shell-startup-exports'
import type { ToolConfigOwnership } from './tool-config-ownership'
import {
  claudePlatformSwitches,
  describeOverride,
  inspectWorkspaceConfigOverrides,
  summarizeWorkspaceOverrides,
  truthySwitch,
} from './workspace-config-overrides'

const MAX_CLAUDE_SETTINGS_BYTES = 256 * 1024

function normalizedPathKey(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** switch：开关，设成 0、false 这类的等于没设（同 workspace-config-overrides.ts 的 truthySwitch）。 */
type EnvironmentOverrideKind = 'baseUrl' | 'secret' | 'directory' | 'model' | 'switch' | 'other'

interface EnvironmentOverrideVariable {
  name: string
  provider: ProviderId
  kind: EnvironmentOverrideKind
  /**
   * true = 设了（且不指向当前账号）就一定让这个 CLI 绕开本程序写入的配置，请求
   * 发去别处或带着别的 Key——检查结论升为「待处理」，开机提示也会数它。
   * false = 盖不过写入的配置，或只影响模型之类不决定能不能连上的东西，仍是「需留意」。
   */
  breaksAccount: boolean
}

interface EnvironmentOverrideMatch {
  name: string
  provider: ProviderId
  kind: EnvironmentOverrideKind
  /** false = 用户确实设了它，但它指的就是当前账号，不会把请求带去别处。 */
  overriding: boolean
  /** overriding 且这个变量会让 CLI 连不上当前账号（见 breaksAccount）。 */
  breaking: boolean
  /** Mac 上从哪个终端设置文件读到的（`~/.zshrc` 这样，不带用户名）；缺省 = 星芒自己的进程环境里。 */
  shellFile?: string
}

/**
 * 用户自己开终端跑 CLI 时，进程环境里这几个变量的优先级高于配置文件，所以
 * 「配置文件写对了」并不等于「跑起来用的就是当前账号」。这是「我明明配好了却
 * 还是走旧地址」最常见的来源，而检查页此前对此一无所知——四个 PROVIDER_* 项只
 * 看文件。
 *
 * 只读、只提醒：代删别人设的变量等于改用户的机器，而且本进程也删不掉别的 shell
 * 的环境。Grok 的同类变量没有在本仓实测过（`GROK_DISABLE_AUTOUPDATER` 是唯一
 * 核实过的一个，与中转地址无关），按 T12 的口径宁缺勿猜，等实测再补。
 *
 * breaksAccount 的取值是 2026-09-22 在沙箱里实测的（Claude Code 2.1.277、Codex
 * 0.155.1、Gemini CLI 0.60.0；配置按 config-files.ts 的模板写，base URL 指本地假
 * 接口，逐个设变量看请求去了哪、带的是哪把 Key），不是照文档推的：
 * - Claude：settings.json 的 env 段压过进程环境，ANTHROPIC_BASE_URL /
 *   ANTHROPIC_AUTH_TOKEN 设了请求照样发往写入的地址、带写入的 Key。但
 *   ANTHROPIC_API_KEY 会多带一个 `x-api-key` 头，而 new-api 在 /v1/messages 上拿
 *   它顶掉 Authorization（middleware/auth.go），等于换了一把 Key。
 *   CLAUDE_CONFIG_DIR 让 Claude 去别的目录找配置，本程序写的 ~/.claude 整个不读。
 *   CLAUDE_CODE_USE_BEDROCK 这几个开关（claudePlatformSwitches）打开后它改走云厂商，地址和登录都不是当前
 *   账号的。实测的是写在项目设置文件 env 段里的（workspace-config-overrides.ts），进程环境里没单独测，
 *   按同理算（#1157 第 11 条）：星芒写的 settings.json 里没有同名项，盖不住它。
 * - Codex：自定义 model provider 不认 OPENAI_BASE_URL / OPENAI_API_KEY（设了照旧打
 *   config.toml 里的地址、带 auth.json 的 Key）。CODEX_HOME 本程序自己也认
 *   （codex-home.ts），配置就写在它指的地方，所以也不算。
 * - Gemini：~/.gemini/.env 不覆盖已有的进程环境，GOOGLE_GEMINI_BASE_URL 与
 *   GEMINI_API_KEY 都是进程环境说了算。GOOGLE_GEMINI_API_KEY 实测不生效；
 *   GEMINI_MODEL、GOOGLE_GENAI_API_VERSION 只换模型和路径版本，不换账号。
 *   Gemini CLI 下线（2026-10-14）后星芒不再管它的账号，这五个从表里拿掉了，结论留在这里。
 *
 * Mac 上这些多半写在 ~/.zshrc 里，星芒从访达打开，自己的环境里看不到。从星芒打开工具时由启动脚本去掉
 * （provider-launch-service.ts 的 macosShellOverrideVariables，已知45）：breaksAccount 为 true 的都在那份名单里
 * （diagnostics.test.ts 钉着），其中 Claude 的那几个只在用星芒账号时去掉。Windows、Linux 上从星芒打开时
 * Claude 的这几个同样不带（launchExcludedEnvironmentVariables，#1081）。检查页在 Mac 上另去读那几个终端
 * 设置文件，只找 breaksAccount 的那几个（collectMacosShellOverrides）。
 * 改这里的取值时那边一起看。
 */
const ENVIRONMENT_OVERRIDE_VARIABLES: readonly EnvironmentOverrideVariable[] = [
  { name: 'ANTHROPIC_BASE_URL', provider: 'claude', kind: 'baseUrl', breaksAccount: false },
  { name: 'ANTHROPIC_AUTH_TOKEN', provider: 'claude', kind: 'secret', breaksAccount: false },
  { name: 'ANTHROPIC_API_KEY', provider: 'claude', kind: 'secret', breaksAccount: true },
  { name: 'CLAUDE_CONFIG_DIR', provider: 'claude', kind: 'directory', breaksAccount: true },
  ...claudePlatformSwitches.map((name): EnvironmentOverrideVariable => ({ name, provider: 'claude', kind: 'switch', breaksAccount: true })),
  { name: 'OPENAI_BASE_URL', provider: 'codex', kind: 'baseUrl', breaksAccount: false },
  { name: 'OPENAI_API_KEY', provider: 'codex', kind: 'secret', breaksAccount: false },
  { name: 'CODEX_HOME', provider: 'codex', kind: 'directory', breaksAccount: false },
]

/** 与 defaultProxyVariables 同法：Windows 的环境变量名大小写不敏感。 */
function environmentValueFor(env: NodeJS.ProcessEnv, name: string): string {
  const match = Object.entries(env).find(([candidate]) => candidate.toUpperCase() === name)
  return typeof match?.[1] === 'string' ? match[1].trim() : ''
}

function sameHostAs(value: string, expected: string): boolean {
  try {
    const left = new URL(value)
    const right = new URL(expected)
    return left.protocol === right.protocol && left.host.toLowerCase() === right.host.toLowerCase()
  } catch {
    return false
  }
}

/**
 * 工具地址变量指到哪几份地址算「已指向当前账号」（直连适配第二步）。这会儿用的那条线路一直算。
 * 选「自动」时默认线路也一直算：它是客户照旧教程设得最多的地址，「自动」走直连并不说明它不通，
 * 报它只会教人删一个没问题的变量。直连只在这会儿真走直连时才算：「自动」退回了默认线路，说明直连
 * 在这台电脑上连不上，指着直连的变量会让工具跟着连不上。写死「只用直连」的照旧只认直连，多半是
 * 默认线路在他那儿不通才这么选。历史账号先走默认线路（yoyo 10-14），走着它时同样只认默认线路。
 */
export function environmentAccountBaseUrls(
  relaySite: RelaySite,
  relayRoute: Pick<DiagnosticsRelayRoute, 'automatic' | 'primarySite'> | undefined,
): ReadonlyArray<RelaySite['providerBaseUrls']> {
  if (!relayRoute?.automatic) return [relaySite.providerBaseUrls]
  return [relaySite.providerBaseUrls, relayRoute.primarySite.providerBaseUrls]
}

/** 本程序替这个工具写配置的那个目录：变量指的就是它，等于没设。 */
function isProviderConfigDirectory(provider: ProviderId, value: string, userHome: string): boolean {
  return normalizedPathKey(value) === normalizedPathKey(path.join(userHome, providerConfigDirectoryNames[provider]))
}

function collectEnvironmentOverrides(
  env: NodeJS.ProcessEnv,
  accountBaseUrls: ReadonlyArray<RelaySite['providerBaseUrls']>,
  userHome: string,
): EnvironmentOverrideMatch[] {
  const matches: EnvironmentOverrideMatch[] = []
  for (const variable of ENVIRONMENT_OVERRIDE_VARIABLES) {
    const value = environmentValueFor(env, variable.name)
    if (!value) continue
    if (variable.kind === 'switch' && !truthySwitch(value)) continue
    // CODEX_HOME 是本程序自己解析出来再注入进 codexEnv 的（codex-home.ts），所以
    // 诊断拿到的 env 里它永远有值。指到默认位置就是本程序自己写的那份，报它等于
    // 每次检查都给一条假警报；只有指到别处才是用户真的改过。
    if (variable.kind === 'directory' && isProviderConfigDirectory(variable.provider, value, userHome)) continue
    // 指向当前账号的 BASE_URL 不会把请求带去别处，报它只会教用户删一个本来
    // 没问题的变量。Key 和模型不在此列：它们盖掉的是账号和分组本身。
    const overriding = !(variable.kind === 'baseUrl'
      && accountBaseUrls.some((urls) => sameHostAs(value, urls[variable.provider])))
    matches.push({
      name: variable.name,
      provider: variable.provider,
      kind: variable.kind,
      overriding,
      breaking: overriding && variable.breaksAccount,
    })
  }
  return matches
}

interface ShellSettingsFile {
  /** 相对用户主目录。 */
  path: string
  dialect: ShellStartupDialect
}

/**
 * Mac 上「终端」开新窗口时登录 shell 会读的启动文件（已知45）。照别家中转教程配的 Key 多半在 ~/.zshrc，
 * 它排第一；bash、fish 的也看，换过 shell 的电脑上旧文件里常留着。
 */
const macosShellSettingsFiles: readonly ShellSettingsFile[] = [
  { path: '.zshrc', dialect: 'posix' },
  { path: '.zprofile', dialect: 'posix' },
  { path: '.zshenv', dialect: 'posix' },
  { path: '.zlogin', dialect: 'posix' },
  { path: '.bash_profile', dialect: 'posix' },
  { path: '.bash_login', dialect: 'posix' },
  { path: '.profile', dialect: 'posix' },
  { path: '.bashrc', dialect: 'posix' },
  { path: '.config/fish/config.fish', dialect: 'fish' },
]

// 手写的启动文件不会有几百 KB（同 macos-shell-profile.ts）；再大就不是该去读的文件了。
const maximumShellSettingsBytes = 512 * 1024

interface ShellSettingsExports {
  /** `~/.zshrc` 这样写：进报告的只有它，不带用户名。 */
  file: string
  exports: ShellStartupExport[]
}

async function readMacosShellSettings(
  userHome: string,
  names: readonly string[],
  skipped: (file: string, error: unknown) => void,
): Promise<ShellSettingsExports[]> {
  const found: ShellSettingsExports[] = []
  for (const settings of macosShellSettingsFiles) {
    const file = `~/${settings.path}`
    let text: string | null
    try {
      text = await readSafeUtf8File(path.join(userHome, ...settings.path.split('/')), '终端设置文件', maximumShellSettingsBytes)
    } catch (error) {
      // dotfiles 仓库常把 ~/.zshrc 做成指向别处的链接。I8 只放行单链接普通文件，这一项只是提醒，不为它放宽。
      skipped(file, error)
      continue
    }
    if (text === null) continue
    const exports = parseShellStartupExports(text, settings.dialect, names, userHome)
    if (exports.length) found.push({ file, exports })
  }
  return found
}

/**
 * 值同进程环境那边判：空的不算，指向当前账号的地址、指向本程序写的配置目录的不算，看不出值的照报。
 * 不去首尾空白：终端原样交给工具的就是这个字符串。
 */
function overridesFromShellSettings(
  variable: EnvironmentOverrideVariable,
  value: string | null,
  accountBaseUrls: ReadonlyArray<RelaySite['providerBaseUrls']>,
  userHome: string,
): boolean {
  if (value === null) return true
  if (value === '') return false
  if (variable.kind === 'switch') return truthySwitch(value)
  if (variable.kind === 'directory') return !isProviderConfigDirectory(variable.provider, value, userHome)
  if (variable.kind === 'baseUrl') return !accountBaseUrls.some((urls) => sameHostAs(value, urls[variable.provider]))
  return true
}

/**
 * Mac 上终端设置文件里导出的、会让工具绕开当前账号的那几个（已知45）。只看用星芒账号的工具：Claude Code
 * 用客户自己的账号时，那几行多半就是他自己的 Key，从星芒打开也照旧带上（system-service.ts 的
 * macosShellOverrideVariables）。
 * 同一个名字在几个文件里都有，就各报一条，客户照着逐个去删。
 */
async function collectMacosShellOverrides(
  userHome: string,
  relayProviders: ReadonlySet<ProviderId>,
  accountBaseUrls: ReadonlyArray<RelaySite['providerBaseUrls']>,
  skipped: (file: string, error: unknown) => void,
): Promise<EnvironmentOverrideMatch[]> {
  const variables = ENVIRONMENT_OVERRIDE_VARIABLES
    .filter((variable) => variable.breaksAccount && relayProviders.has(variable.provider))
  if (!variables.length) return []
  const found = await readMacosShellSettings(userHome, variables.map((variable) => variable.name), skipped)
  return variables.flatMap((variable) => found
    .filter((settings) => settings.exports.some((exported) => exported.name === variable.name
      && overridesFromShellSettings(variable, exported.value, accountBaseUrls, userHome)))
    .map((settings) => ({
      name: variable.name,
      provider: variable.provider,
      kind: variable.kind,
      overriding: true,
      breaking: true,
      shellFile: settings.file,
    })))
}

/**
 * 星芒是从终端里打开的时候，进程环境里也带着终端设置文件里的那几个：同一个名字只留指明了文件的那几条。
 * 顺序照变量表排，同一个工具的挨在一起。
 */
function withShellSettingsOverrides(
  environment: readonly EnvironmentOverrideMatch[],
  shell: readonly EnvironmentOverrideMatch[],
): EnvironmentOverrideMatch[] {
  const named = new Set(shell.map((match) => match.name))
  const combined = [...environment.filter((match) => !named.has(match.name)), ...shell]
  return ENVIRONMENT_OVERRIDE_VARIABLES.flatMap((variable) => combined.filter((match) => match.name === variable.name))
}

/**
 * Mac 上从星芒打开这个工具时，启动脚本会不会先把它的这几个变量去掉（system-service.ts 的
 * macosShellOverrideVariables）：Claude Code 只在用星芒账号时去掉。只拿来问 breaksAccount 的那几个；
 * 两边对不上时 diagnostics.test.ts 会红。
 */
function droppedByMacosLauncher(provider: ProviderId, relayProviders: ReadonlySet<ProviderId>): boolean {
  return provider === 'claude' && relayProviders.has(provider)
}

/**
 * 检查页「删掉这几项设置」能替用户删的那几个名字：盖过当前账号的地址、密钥、模型。
 * 指向别的文件夹的那两个（CLAUDE_CONFIG_DIR、CODEX_HOME）不删：它们指着用户自己的
 * 一整份配置，删了等于把他原来的设置、记录换了个地方，这个得他自己决定。
 * 改走云厂商的开关也不删：设它的人多半自己在终端里用 Bedrock、Vertex，从星芒打开时已经不带了
 * （#1157 第 11 条），删掉会让他自己那套用不了，同样得他自己决定。
 */
export function clearableEnvironmentOverrides(
  env: NodeJS.ProcessEnv,
  accountBaseUrls: ReadonlyArray<RelaySite['providerBaseUrls']>,
  userHome: string,
): string[] {
  return collectEnvironmentOverrides(env, accountBaseUrls, userHome)
    .filter((match) => match.overriding && match.kind !== 'directory' && match.kind !== 'switch')
    .map((match) => match.name)
}

/** 名单外的名字一律不碰；清除脚本那一侧再对照一遍。 */
export const environmentOverrideNames: readonly string[] = ENVIRONMENT_OVERRIDE_VARIABLES.map((variable) => variable.name)

/** Windows 上有能删的，就在结论里挂上「删掉这几项设置」（details.fix，详情抽屉不显示它）。 */
function withEnvironmentOverrideFix(outcome: CheckOutcome, clearable: boolean): CheckOutcome {
  if (!clearable || outcome.state === 'pass') return outcome
  return { ...outcome, details: { ...outcome.details, fix: 'clear-user-overrides' } }
}

// Mac 上同一个名字可能写在几个终端设置文件里，结论里只说一次。
function namesOf(matches: readonly EnvironmentOverrideMatch[]): string {
  const names = [...new Set(matches.map((match) => match.name))]
  const listed = names.slice(0, 3).join('、')
  return names.length > 3 ? `${listed}等 ${names.length} 项` : listed
}

function toolsOf(matches: readonly EnvironmentOverrideMatch[]): string {
  return [...new Set(matches.map((match) => cliCatalog[match.provider].name))].join('、')
}

/**
 * droppedByLauncher：Mac 上从星芒打开时启动脚本会不会先去掉这一个，去掉的降成「需留意」。
 * Windows、Linux 不传，照旧报「待处理」：Claude 的那两个从星芒打开时同样不带了（#1081），但这里读的是
 * 星芒自己的进程环境，客户自己开命令窗口直接跑工具时拿到的也是这一份，照样绕开当前账号。Mac 降级时那句
 * 说的是「终端设置」，Windows、Linux 要降级得另写一句，#1081 定的是这次不加新字。
 */
function environmentOverrideOutcome(
  matches: readonly EnvironmentOverrideMatch[],
  droppedByLauncher: (match: EnvironmentOverrideMatch) => boolean = () => false,
): CheckOutcome {
  const details: Record<string, boolean | number | string | null> = { count: matches.length }
  matches.forEach((match, index) => {
    // 只有变量名进报告。ANTHROPIC_AUTH_TOKEN 的值本身就是一把 Key，而诊断导出是
    // 要发到客服群里的（I3、I13）——所以这里永远不读也不写它的值。
    const note = !match.overriding
      ? '，已指向当前账号'
      : match.shellFile ? `，在 ${match.shellFile}` : match.breaking ? '，会绕开当前账号' : ''
    details[`variable${index + 1}`] = `${match.name}（${cliCatalog[match.provider].name}${note}）`
  })
  const overriding = matches.filter((match) => match.overriding)
  if (!overriding.length) {
    return {
      state: 'pass',
      summary: matches.length
        ? '电脑里另外设的工具地址也指向当前账号，不影响使用'
        : '没有另外设过工具地址或密钥',
      details,
    }
  }
  const breaking = overriding.filter((match) => match.breaking)
  const reachingTools = breaking.filter((match) => !droppedByLauncher(match))
  if (reachingTools.length) {
    return {
      // 这几个变量实测会让 CLI 绕开写入的配置（见 breaksAccount），用户在终端里
      // 跑就连不上当前账号，所以是「待处理」。本程序仍然不替他删。
      state: 'fail',
      summary: `电脑里另外设了 ${namesOf(reachingTools)}，会让 ${toolsOf(reachingTools)} 不用当前账号的设置。删掉它们再重新打开工具就好；不会删请在「反馈与客服」页导出报告发给客服`,
      details,
    }
  }
  if (breaking.length) {
    return {
      // Mac 上从星芒打开工具时启动脚本已经去掉了这几个（已知45），只有客户自己开终端直接用工具时才绕开
      // 当前账号，所以是「需留意」，开机提示不数它。
      state: 'warn',
      summary: `终端设置里另外设了 ${namesOf(breaking)}：从星芒打开的工具不受影响，自己开终端直接用 ${toolsOf(breaking)} 时会不用当前账号的设置。用不着的话，把这几项从终端设置里删掉`,
      details,
    }
  }
  return {
    // 用「需留意」不是「待处理」：剩下这些实测盖不过写入的配置，或只换模型、不换
    // 账号（见 breaksAccount）。仍提一句，是因为用户换个方式跑（项目里的配置、别的
    // 启动器）时它们可能生效；文案因此用「可能」。
    state: 'warn',
    summary: `电脑里另外设了 ${namesOf(overriding)}，可能会盖过当前账号的设置`,
    details,
  }
}

interface IgnoredCodexHomeFinding {
  /** true = 在软件外面打开的 Codex 读不到本程序替当前账号写好的配置。 */
  blocking: boolean
}

/**
 * 软件自己启动的 Codex 拿到的是注入过的 CODEX_HOME，不受影响；受影响的是用户
 * 从开始菜单、终端这些软件外面打开的 Codex，它读的仍是那个写错的值。Codex 不展开
 * `~` 和 `%USERPROFILE%`，相对路径按当前目录解析，而这类进程的当前目录通常就是
 * 用户目录，所以按用户目录解析一次：落回本程序写配置的那个目录（比如只写了
 * `.codex`）就还连得上，否则就连不上。Codex 根本没接当前账号时，连不连得上
 * 无从谈起，只提醒不算待处理。
 */
function inspectIgnoredCodexHome(
  ignored: IgnoredCodexHome | undefined,
  roots: ProviderConfigRoots,
  codexInspection: NativeConfigInspection | undefined,
): IgnoredCodexHomeFinding | null {
  if (!ignored) return null
  const configured = Boolean(codexInspection?.matchesRelay && codexInspection.hasApiKey)
  const landsOnCodexHome = ignored.reason === 'relative'
    && normalizedPathKey(path.resolve(roots.userHome, ignored.value)) === normalizedPathKey(roots.codexHome)
  return { blocking: configured && !landsOnCodexHome }
}

/**
 * 叠在 environmentOverrideOutcome 之后而不是改它：写错的 CODEX_HOME 不是「盖过
 * 配置」，是「本来要盖、被本程序忽略了」，结论要单独说，其余变量的判定原样保留。
 */
function withIgnoredCodexHome(outcome: CheckOutcome, finding: IgnoredCodexHomeFinding | null): CheckOutcome {
  if (!finding) return outcome
  const previous = outcome.details ?? {}
  const labels = Object.keys(previous)
    .filter((key) => /^variable\d+$/.test(key))
    .sort((left, right) => Number(left.slice(8)) - Number(right.slice(8)))
    .map((key) => previous[key])
  const details: Record<string, boolean | number | string | null> = {
    ...Object.fromEntries(Object.entries(previous).filter(([key]) => !/^variable\d+$/.test(key))),
    count: labels.length + 1,
  }
  // 写错的原值可能带着用户名，和其它变量一样只有名字进报告。
  const ordered = [`CODEX_HOME（${cliCatalog.codex.name}，写得不对，已忽略）`, ...labels]
  ordered.forEach((label, index) => {
    details[`variable${index + 1}`] = label
  })
  const effect = finding.blocking ? '，但在软件外面打开 Codex 会连不上当前账号' : ''
  const others = outcome.state === 'pass' ? '' : `；${outcome.summary}`
  // 连不上当前账号才算「待处理」（开机横幅只数这一档）；软件里打开的 Codex 本来
  // 就不受影响，其余情况只是提醒。其它变量已经判出更重的一档时不往下拉。
  const state = finding.blocking || outcome.state === 'fail' ? 'fail' : 'warn'
  return { state, summary: `电脑里有一个 Codex 的设置写得不对，软件已经忽略它${effect}${others}`, details }
}

/**
 * 本软件写 Claude 配置时本来就会带上 permissions.defaultMode = 'bypassPermissions'
 * （不这么写，用户每跑一条命令都要按一次确认，而这是本产品替客户省掉的门槛之一）。
 * 所以「文件里是 bypass」单独看不说明任何问题：它多半就是我们自己刚写的。只有确认
 * 这份配置是本软件替当前账号写下的（所有权 `account`）才当成正常状态；来源判不准
 * （用户手改过、别的工具写的、没登录、指纹对不上的 `changed`）时照旧提醒，因为那种
 * 情况下用户确实可能不知道自己的 AI 正在不打招呼地执行命令。
 */
function readClaudeBypass(homeDirectory: string, ownership: ToolConfigOwnership | null): CheckOutcome {
  const configPath = path.join(homeDirectory, '.claude', 'settings.json')
  if (!fs.existsSync(configPath)) return { state: 'pass', summary: '跑命令前会先问你' }
  const parsed = JSON.parse(readBoundedUtf8FileSync(
    configPath,
    MAX_CLAUDE_SETTINGS_BYTES,
    'Claude settings.json',
  )) as unknown
  const permissions = isRecord(parsed) && isRecord(parsed.permissions) ? parsed.permissions : null
  const bypass = permissions?.defaultMode === 'bypassPermissions'
  if (!bypass) return { state: 'pass', summary: '跑命令前会先问你', details: { bypass, managed: false } }
  if (ownership === 'account') {
    return {
      state: 'pass',
      summary: '按当前账号的设置，跑命令前不再逐条问你',
      details: { bypass, managed: true },
    }
  }
  return {
    state: 'warn',
    summary: '被设成了跑命令前不问你，这个设置不是星芒写的。留意它会直接执行命令',
    details: { bypass, managed: false },
  }
}

// 「工具名照实写」：Codex 那一份 config.toml 命令行和桌面端共用，所以只写 Codex。
const homeFolderTrustNames: Readonly<Record<HomeFolderTrustProvider, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
}

/**
 * 「个人文件夹里早先留下的设置」（已知36）。#321 以前客户选个人文件夹打开工具时，星芒往
 * 那里放过一份 AGENTS.md、替工具记过「信任整个个人文件夹」，之后不再放也不再记，已经留下
 * 的没有任何地方提一句。说明还是星芒那份、客户没改过的才提，并给「挪开这份说明」；信任只
 * 说一声、不给按钮，同「Claude 跑命令前要不要先问你」那项的口径。两样都有时两段连着说。
 * 「有的工具会连它一起读」「可能不会先问」是推测（只有 Gemini CLI 在不是 git 仓库的项目里
 * 一路往上读到个人文件夹这一点有把握），所以字里留着「有的」「可能」。
 */
export function homeFolderLeftoversOutcome(input: {
  untouchedInstructions: boolean
  trustedBy: readonly HomeFolderTrustProvider[]
}): CheckOutcome {
  const parts: string[] = []
  if (input.untouchedInstructions) {
    parts.push('个人文件夹里有一份星芒早先放的项目说明（AGENTS.md）。在个人文件夹下打开项目时，'
      + '有的工具会连它一起读、照它办事，比如改代码前先等你确认。不需要的话点「挪开这份说明」。')
  }
  if (input.trustedBy.length) {
    const names = input.trustedBy.map((provider) => homeFolderTrustNames[provider]).join('、')
    const pronoun = input.trustedBy.length > 1 ? '它们' : '它'
    parts.push(`${names} 记着“信任整个个人文件夹”：个人文件夹下的项目，${pronoun}打开时可能不会先问一句信不信得过。`)
  }
  const details: Record<string, boolean | number | string | null> = {
    untouchedInstructions: input.untouchedInstructions,
    trustedBy: input.trustedBy.join(',') || null,
  }
  // 「挪开这份说明」：改个名留在原处，不删（diagnostic-fixes.ts）。信任那半不给按钮。
  if (input.untouchedInstructions) details.fix = 'set-aside-home-agents-md'
  return parts.length
    ? { state: 'warn', summary: parts.join(''), details }
    : { state: 'pass', summary: '没有早先留下的项目说明和信任设置', details }
}

export function buildOverrideChecks(context: DiagnosticsContext): CheckDefinition[] {
  const {
    dependencies, env, userHome, providerRoots, codexHome, displayRoots, platform,
    toolSite, toolRoute, providerInspections, sanitize, log,
  } = context
  const accountBaseUrls = environmentAccountBaseUrls(toolSite, toolRoute)
  // 只看配过的工具：没配过的工具谈不上「盖过当前账号」。管理策略不看工作目录，
  // 所以没选过文件夹时 Claude 那一份照查。
  const workspaceOverrideOutcome = (): CheckOutcome => {
    const workspace = typeof dependencies.workspace === 'string' ? dependencies.workspace.trim() : ''
    const workspaceChecked = workspace !== '' && path.isAbsolute(workspace) && fs.existsSync(workspace)
    const overrides = activeProviderIds.flatMap((provider) => {
      const inspection = providerInspections.get(provider)
      if (!inspection?.exists) return []
      const found = inspectWorkspaceConfigOverrides(provider, workspaceChecked ? workspace : userHome, {
        platform,
        home: userHome,
        codexHome,
        current: {
          baseUrl: inspection.baseUrl,
          apiKey: inspection.apiKey,
          authType: inspection.authType,
          codexAuthMode: inspection.codexAuthMode,
        },
        ...(dependencies.claudeManagedDirectory ? { claudeManagedDirectory: dependencies.claudeManagedDirectory } : {}),
      })
      return workspaceChecked ? found : found.filter((entry) => entry.scope === 'managed')
    })
    const summary = summarizeWorkspaceOverrides(overrides, {
      toolName: (provider) => cliCatalog[provider].name,
      describe: (override) => describeOverride(override, workspaceChecked ? workspace : userHome, userHome, platform),
      workspaceChecked,
    })
    return {
      ...summary,
      details: {
        ...(workspaceChecked ? { workspace: pathForDisplay(workspace, displayRoots) } : {}),
        ...summary.details,
      },
    }
  }

  return [
    {
      code: 'PROVIDER_ENVIRONMENT_OVERRIDE',
      title: '电脑里另外设过的工具地址或密钥',
      run: async () => {
        const relayProviders = new Set(activeProviderIds.filter((provider) => {
          const inspection = providerInspections.get(provider)
          return inspection !== undefined && providerAccountMode(inspection) === 'relay'
        }))
        const environment = collectEnvironmentOverrides(env, accountBaseUrls, userHome)
        // 读不了是哪个文件、为什么，只进日志不进报告；原文里可能带着用户名，先脱敏。
        const skipped = (file: string, error: unknown): void => {
          log?.('info', 'diagnostics.shell-settings.skipped', '终端设置文件没读', { file, raw: sanitize(errorChainText(error)) })
        }
        const matches = platform === 'darwin'
          ? withShellSettingsOverrides(
            environment,
            await collectMacosShellOverrides(userHome, relayProviders, accountBaseUrls, skipped),
          )
          : environment
        return withIgnoredCodexHome(
          withEnvironmentOverrideFix(
            environmentOverrideOutcome(
              matches,
              (match) => platform === 'darwin' && droppedByMacosLauncher(match.provider, relayProviders),
            ),
            platform === 'win32' && clearableEnvironmentOverrides(env, accountBaseUrls, userHome).length > 0,
          ),
          inspectIgnoredCodexHome(dependencies.ignoredCodexHome, providerRoots, providerInspections.get('codex')),
        )
      },
    },
    {
      code: 'WORKSPACE_CONFIG_OVERRIDE',
      title: '项目文件夹里的设置',
      run: () => workspaceOverrideOutcome(),
    },
    {
      code: 'CODEX_DOTENV',
      title: 'Codex 文件夹里的额外设置',
      run: () => {
        const envPath = path.join(codexHome, '.env')
        const exists = fs.existsSync(envPath)
        const details: Record<string, boolean | number | string | null> = { exists, path: pathForDisplay(envPath, displayRoots) }
        // 有这份文件时给「挪开这份设置」：改个名留在原处，不删（diagnostic-fixes.ts）。
        if (exists) details.fix = 'set-aside-codex-dotenv'
        return {
          state: exists ? 'warn' : 'pass',
          summary: exists ? 'Codex 文件夹里有一份额外设置，可能盖过当前账号的连接' : 'Codex 文件夹里没有额外设置',
          details,
        }
      },
    },
    {
      code: 'CLAUDE_BYPASS_PERMISSIONS',
      title: 'Claude Code 跑命令前要不要先问你',
      run: () => readClaudeBypass(userHome, dependencies.readClaudeConfigOwnership?.() ?? null),
    },
    {
      code: 'HOME_FOLDER_LEFTOVERS',
      title: '个人文件夹里早先留下的设置',
      run: () => homeFolderLeftoversOutcome({
        untouchedInstructions: hasUntouchedHomeProjectInstructions(userHome),
        // Gemini CLI 下线后星芒不再提它记着的信任：那是客户自己的工具设置，星芒也不再从这里打开它。
        trustedBy: inspectHomeFolderTrust(providerRoots).filter((provider) => !isRetiredProviderId(provider)),
      }),
    },
  ]
}
