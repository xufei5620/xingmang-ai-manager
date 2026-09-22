import { providerIds, type AppConfigSummary, type ConnectionCheckLayer, type ConnectionCheckResult, type ProviderId } from '../../../../electron/ipc-contract'
import type { PageId } from '../../registry/pages'
import { sourceFor } from './model'
import { getSourceMarkerStorage, type SourceMarkerStorage } from './source-marker'

/**
 * 与 electron/connection-check.ts 的 connectionCheckLayerLabels 是有意重复的
 * 字面量：主进程那份 import 了 command-runner（node:*），渲染层值级别引用它
 * 会被 Vite 打进 bundle（I6）。`Record<ConnectionCheckLayer, string>` 让漏键
 * 变成编译错，与 preload.ts 的通道表同一个理由、同一种保障。
 */
export const connectionLayerLabels: Record<ConnectionCheckLayer, string> = {
  unconfigured: '未配置',
  config: '本地配置',
  network: '网络',
  credential: '密钥',
  quota: '额度',
  group: '分组与渠道',
  model: '模型',
  protocol: '协议与端点',
  unknown: '未知',
}

/** 「去处理」该跳到哪一页：把归因直接变成用户的下一次点击。 */
const layerTargets: Record<ConnectionCheckLayer, PageId> = {
  unconfigured: 'home',
  config: 'home',
  network: 'settings',
  credential: 'account',
  quota: 'account',
  group: 'account',
  model: 'home',
  protocol: 'feedback',
  unknown: 'feedback',
}

/**
 * 这两层的下一步就是让客户端对当前账号重新签发一把 Key 再写回配置，所以结果条
 * 上直接给这件事本身，而不是把用户送去账号页自己找（账号页上并没有「写入 Key」
 * 这颗按钮，它在首页的工具行上）。其余各层的下一步不是换 Key，仍旧「去处理」。
 */
const rewritableLayers: ReadonlySet<ConnectionCheckLayer> = new Set<ConnectionCheckLayer>(['credential', 'group'])

/**
 * 主进程给的下一步是「到账号页看看，必要时重新写入」——按钮已经把这件事本身
 * 端到用户面前时，再让他先去别的页面就是自相矛盾。所以只有在给得出这颗按钮时
 * 才换这句话，其余情况仍旧原样转述主进程的结论。
 */
const rewriteNextStep = '当前账号的 Key 需要重新写一次。点「重新写入 Key」，写完会自动再测一遍连接。'

/**
 * 「重新写入 Key」只对星芒来源的工具给得出来：重写流程本身会跳过官方账号与
 * 手填密钥（account-bootstrap.ts 的 accountBootstrapPlan），对这些工具画一颗
 * 按钮出来，用户点下去什么都不会发生。
 */
export function rewritableKeyProviders(
  config: AppConfigSummary | null | undefined,
  storage: SourceMarkerStorage | null = getSourceMarkerStorage(),
): ProviderId[] {
  if (!config) return []
  return providerIds.filter((provider) => sourceFor(config.providers[provider], provider, storage) === 'account')
}

export interface ConnectionCheckView {
  tone: 'ok' | 'warn' | 'bad' | 'neutral'
  /** 结果条上的小标签：正常 / 未配置 / 出问题的那一层。 */
  statusLabel: string
  title: string
  body: string
  /** 站点无感：endpoint 只在失败时展示，成功时没有让用户看地址的理由。 */
  endpoint: string | null
  detail: string | null
  /** 成功时为 null：没有要处理的事就不该出现按钮。 */
  target: PageId | null
  /** 'rewrite-key' 时按钮不再跳页，而是就地对当前账号重新写一次这个工具的 Key。 */
  action: 'rewrite-key' | null
}

export function connectionCheckView(
  result: ConnectionCheckResult,
  options: { canRewriteKey?: boolean } = {},
): ConnectionCheckView {
  if (result.ok) {
    return {
      tone: 'ok',
      statusLabel: '正常',
      title: result.summary,
      // evidence 由主进程给：四个工具的探测形态不同（生成一次 vs 核对模型
      // 清单），渲染层照 provider 猜会在加第五个工具时悄悄说错。
      body: result.evidence ?? '已向星芒服务发过一次最小请求',
      endpoint: null,
      detail: null,
      target: null,
      action: null,
    }
  }
  // 「还没配」不是故障：写成 bad 会让一个只用 Claude Code 的用户在结果页上
  // 看到三条红的，然后来问客服「是不是坏了」。
  if (result.layer === 'unconfigured') {
    return {
      tone: 'neutral',
      statusLabel: connectionLayerLabels.unconfigured,
      title: result.summary,
      body: result.nextStep,
      endpoint: null,
      detail: null,
      target: layerTargets.unconfigured,
      action: null,
    }
  }
  const rewrite = rewritableLayers.has(result.layer) && options.canRewriteKey === true
  return {
    tone: result.layer === 'config' ? 'warn' : 'bad',
    statusLabel: connectionLayerLabels[result.layer],
    // 归因层已经由 statusLabel 显示在工具名旁边，标题不再重复一遍。
    title: result.summary,
    body: rewrite ? rewriteNextStep : result.nextStep,
    endpoint: result.endpoint,
    detail: result.detail,
    target: rewrite ? null : layerTargets[result.layer],
    action: rewrite ? 'rewrite-key' : null,
  }
}
