import {
  buildGatewayMessagesProbe,
  buildModelCatalogProbe,
  runConnectionProbe,
  type ConnectionProbeBuild,
  type ConnectionProbeDependencies,
  type ConnectionProbeReport,
} from './connection-check'
import { externalClientNames } from './external-client-contract'
import type { ExternalToolId } from './external-tool-config'

/**
 * 三个外部客户端（WorkBuddy / Claude Desktop / OpenCode）的连接自检。
 *
 * 0.2.6 接进来之后，它们的保存流程一直自己承认「未验证实际模型调用」，检查页
 * 的连接自检也只列四个 CLI。用户在客户端里选了模型却得不到回话时，回到本软件
 * 看到的只有一句「已配好」，客服除了让他删掉重配一遍之外没有别的线索。
 *
 * 这里补上的是**能验证的那一半**：把客户端自己的配置文件回读一遍，用里面真正
 * 写着的那把密钥，向该客户端真正会打的那个星芒地址问一次。WorkBuddy 与
 * OpenCode 核对当前账号的模型清单：清单是按令牌分组过滤的，所以密钥、分组、
 * 模型三层一次问完，并且不花额度（与 Codex / Grok / Gemini 三个 CLI 的自检同一
 * 种探测，connection-check.ts）。Claude Desktop 不一样：它自己每次启动都会发一
 * 条一个字的检查消息，那条被拒就弹「凭据被拒」，而清单答不出余额这一层，所以
 * 照它的样子发同一条（gatewayMessagesShape），花它同样的一个字。
 *
 * **不验证的那一半照实说**：客户端里真正聊天时的那些请求（WorkBuddy 的
 * `/chat/completions`、OpenCode 的 `/responses`、Claude Desktop 的会话）本机
 * 发不出来 —— 那是客户端进程在跑，不是本软件。所以成功结论的 evidence 里写明
 * 「客户端里实际发起的对话本机测不到」，不写成「全都正常」。宁可少说，也不
 * 假绿。
 */

export interface ExternalClientCheckResult extends ConnectionProbeReport {
  tool: ExternalToolId
  /**
   * 当前 realm 的站点 id。只给日志和客服排查用：站点切换对用户无感，界面文案
   * 里永远不出现站点名（同 ConnectionCheckResult.siteId）。
   */
  siteId: string
  /** 客户端本身装没装。没装的不值得在检查页占一行，渲染层据此过滤。 */
  installed: boolean
}

/** 探测所需的全部事实，由主进程从本机配置里读出来。含 Key，永不跨 IPC（I3）。 */
export interface ExternalClientProbeInput {
  tool: ExternalToolId
  installed: boolean
  /**
   * 该客户端配置里真正指向的星芒地址，由主进程按当前站点解析。渲染层给不了
   * 这个值，也不该给：地址决定了这把付费密钥会被送到哪台主机。
   */
  baseUrl: string
  /** 配置归属的结论，来自 inspectExternalToolConnection / Claude Desktop 网关。 */
  configurationSource: 'xingmang' | 'other' | 'missing' | 'unknown'
  configurationError?: string | null
  /** 配置里写着的模型；读不到时为 null。 */
  model: string | null
  /** 配置里写着的密钥；只有确认归属当前账号时才取得出来，否则为 null。 */
  apiKey: string | null
  /** Claude Desktop 选的是官方登录：额度走客户自己的订阅，没有星芒这边可测的。缺省 = 不是。 */
  officialAccount?: boolean
  /**
   * Claude Desktop 开机检查拿哪个型号发那一个字（claude-desktop-models.ts）。清单里有好几个型号时它不一定是默认的
   * model：有 Haiku 就先挑 Haiku。缺省 = 和 model 是同一个。
   */
  startupCheckModel?: string | null
}

/**
 * 每个客户端问哪一句。**无 default 分支 + 非 void 返回类型 = 穷尽性保障**
 * （AGENTS.md T2）：加第四个客户端时漏在这里是编译错。
 *
 * WorkBuddy 与 OpenCode 写的是自带 `/v1` 后缀的 codex 地址，拼上 `models` 落到
 * 已实测过的 `/v1/models`。Claude Desktop 的网关地址是站点的 claude 裸域，照它
 * 自己的启动检查发 `/v1/messages`：它弹不弹「凭据被拒」就看这一条。
 */
function probeFor(tool: ExternalToolId, name: string, baseUrl: string, model: string, apiKey: string): ConnectionProbeBuild {
  switch (tool) {
    case 'claudeDesktop':
      return buildGatewayMessagesProbe(name, baseUrl, model, apiKey)
    case 'workbuddy':
      return buildModelCatalogProbe(name, baseUrl, 'models', model, apiKey)
    case 'opencode':
      return buildModelCatalogProbe(name, baseUrl, 'models', model, apiKey)
  }
}

/** 成功时本机确实问过的那一句，与 probeFor 一一对应。 */
function verifiedWording(tool: ExternalToolId, name: string, model: string): string {
  switch (tool) {
    case 'claudeDesktop':
      return `已按 ${name} 启动时的检查方式，使用其配置中的密钥向 ${model} 发送一条单字测试消息，服务回复正常`
    case 'workbuddy':
      return `已使用 ${name} 配置中的密钥核对当前账号的可用模型列表，${model} 在列表中`
    case 'opencode':
      return `已使用 ${name} 配置中的密钥核对当前账号的可用模型列表，${model} 在列表中`
  }
}

/** 外部客户端只会停在这两层之前：别的层都得真的发过一次请求才答得出来。 */
type ExternalBlockedLayer = 'unconfigured' | 'config'

function blocked(
  layer: ExternalBlockedLayer,
  summary: string,
  nextStep: string,
  model: string | null,
): ConnectionProbeBuild {
  return { kind: 'blocked', outcome: { layer, summary, nextStep }, model }
}

/**
 * 把「这台机器上这个客户端现在是什么状态」算成一次探测，或者算成一个让请求
 * 没有意义的结论。纯函数：每个分支在测试里就是一条断言。
 */
export function buildExternalClientProbe(input: ExternalClientProbeInput): ConnectionProbeBuild {
  const name = externalClientNames[input.tool]
  const model = input.model
  if (!input.installed) {
    return blocked('unconfigured', `尚未检测到 ${name}`,
      '请先在首页安装该客户端或点击「重新检测」，安装完成后再返回自检', model)
  }
  // 官方登录不是故障，也不该拿留着的那把星芒密钥替它测：和命令行工具切官方后一样，显示成未配置。
  if (input.officialAccount) {
    return blocked('unconfigured', `${name} 当前使用的是您自己的 Claude 账号`,
      '额度使用您自己的官方订阅，不扣除当前账号的余额。如需改用当前账号，请在首页的工具卡片上切换', model)
  }
  if (input.configurationSource === 'unknown') {
    return blocked('config', input.configurationError?.trim() || `${name} 的本地配置无法确认`,
      '请检查配置文件的权限与格式，然后在首页为该客户端重新配置', model)
  }
  if (input.configurationSource === 'missing') {
    return blocked('unconfigured', `尚未为 ${name} 写入星芒配置`,
      '请在首页点击该客户端的「配置」，选择密钥和模型并保存，再返回自检', model)
  }
  if (input.configurationSource === 'other') {
    // 不回显它现在指向哪：那可能是用户自己的另一家服务，本软件没有理由替他
    // 把那个地址念出来，更不会拿那把密钥去发请求。
    const nextStep = '自检仅使用当前账号的密钥向星芒服务发送请求。请先在首页为该客户端重新配置'
    // WorkBuddy、OpenCode 本来就能接别家：客户自己配的不算问题，跟没配一样是灰的、不是黄的
    // （0.2.24 深查决定单 D63）。Claude Desktop 不在那条决定里，照旧。
    if (input.tool !== 'claudeDesktop') return blocked('unconfigured', '当前使用的是您自己的配置', nextStep, model)
    return blocked('config', `${name} 当前的配置不是由当前账号写入的`, nextStep, model)
  }
  if (!input.apiKey || !model) {
    return blocked('config', `${name} 的配置中未读取到可用的密钥或模型`,
      '请在首页为该客户端重新配置，保存后将自动重新检测', model)
  }
  return probeFor(input.tool, name, input.baseUrl, model, input.apiKey)
}

/**
 * 成功时换一套措辞：共用的归因表说的是「连接正常，X 可以直接使用」，那对一个
 * 本软件管不着其请求路径的第三方客户端是过头话。这里只说本机确实问出来的那
 * 几层，剩下的一句写明没验证。
 */
function describeSuccess(tool: ExternalToolId, model: string | null): { summary: string; evidence: string } {
  const label = model ?? '所选模型'
  return {
    summary: `当前账号的密钥和模型 ${label} 都可用`,
    evidence: `${verifiedWording(tool, externalClientNames[tool], label)}；客户端中实际发起的对话由客户端自行发送，本机无法检测`,
  }
}

export async function runExternalClientCheck(
  input: ExternalClientProbeInput,
  siteId: string,
  dependencies: ConnectionProbeDependencies = {},
): Promise<ExternalClientCheckResult> {
  const defaultReport = await runConnectionProbe(buildExternalClientProbe(input), dependencies)
  // 默认型号通了，Claude Desktop 开机检查挑的又是另一个时再照它问一次：它弹不弹「型号被拒」看的是那一个。
  // 那个不通就报那一条，结论里的型号也是它，和 Claude Desktop 横幅上点名的是同一个。
  const startupModel = input.tool === 'claudeDesktop' ? input.startupCheckModel : null
  const report = defaultReport.ok && startupModel && startupModel !== defaultReport.model
    ? await runConnectionProbe(buildExternalClientProbe({ ...input, model: startupModel }), dependencies)
      .then((startup) => startup.ok ? defaultReport : startup)
    : defaultReport
  const success = report.ok ? describeSuccess(input.tool, report.model) : null
  return {
    tool: input.tool,
    siteId,
    installed: input.installed,
    ...report,
    ...(success ? { summary: success.summary, evidence: success.evidence } : {}),
  }
}
