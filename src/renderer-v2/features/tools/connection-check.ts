import type { ConnectionCheckLayer, ConnectionCheckResult } from '../../../../electron/ipc-contract'
import type { PageId } from '../../registry/pages'

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
}

export function connectionCheckView(result: ConnectionCheckResult): ConnectionCheckView {
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
    }
  }
  return {
    tone: result.layer === 'config' ? 'warn' : 'bad',
    statusLabel: connectionLayerLabels[result.layer],
    // 归因层已经由 statusLabel 显示在工具名旁边，标题不再重复一遍。
    title: result.summary,
    body: result.nextStep,
    endpoint: result.endpoint,
    detail: result.detail,
    target: layerTargets[result.layer],
  }
}
