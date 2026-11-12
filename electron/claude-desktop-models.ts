import { mapWithConcurrency } from './async-map'
import { isCliModelName, sortClaudeModelsNewestFirst } from './cli-model-defaults'

// Claude Desktop 的型号菜单就是配置里 inferenceModels 那份清单：3.6556.2 安装包里网关的
// adminListObviatesDiscovery 在清单写满完整型号名时跳过 /v1/models，菜单里只有清单上的那几个，第一个是默认。
// #746 起只写选中的一个，客户在 Claude Desktop 里就换不了型号。
//
// 0.2.12（#685）把这把密钥列着的 claude-* 全写进去，出过「型号被拒、发消息没回复」：Claude Desktop 每次启动
// 拿清单里的一个型号发一个字检查（挑法见 claudeDesktopStartupCheckModel，有 Haiku 先挑 Haiku），起标题这类
// 后台小活也先用最小的那档，而中转的型号列表里列着的不一定发得通。所以这里只放保存时照它那条检查发一个字
// 试通了的型号。

// 菜单里最多放几个，连同选中的那个。保存时每个都要试一次，放多了保存要多等。
const maximumModels = 8
// 开机补型号（claude-desktop-model-topup.ts）只加不减，账号每上一个新型号菜单就长一格。长到这么多就不再补，
// 免得菜单越攒越长；客户在星芒里重新保存一次，菜单回到最新的 maximumModels 个。
export const claudeDesktopTopUpMaximumModels = 12
// 同时试几个：一次只试一个，8 个要等好几秒；全部一起发又像一阵突发请求。
const probeConcurrency = 3
// 和 3.6556.2 安装包里判微调型号的写法一样，那种型号开机检查排在后面。
const fineTunedModelPattern = /ft_snap|fine.?tun|:ft-/i

/**
 * 除了选中的那个，还有哪些型号拿去试：这把密钥列着的 claude-* 型号，名字认得出（会原样写进配置、发给中转），
 * 版本新的排前面，连同选中的一共最多 maximumModels 个。分组里型号多到放不下时先舍掉老的。
 */
export function claudeDesktopModelCandidates(models: readonly string[], selected: string): string[] {
  const others = [...new Set(models)].filter((model) => model !== selected && /^claude-/i.test(model) && isCliModelName(model))
  return sortClaudeModelsNewestFirst(others).slice(0, maximumModels - 1)
}

/**
 * Claude Desktop 开机那条检查拿清单里哪个型号发（3.6556.2 安装包里网关的 probeInference）：名字里带 haiku 的
 * 先挑，没有看 sonnet，再没有看 opus；同一档里挑名字最短的（一样短取靠前的），微调型号排后；三档都没有用第一个。
 * 它回 400/404 就弹「型号被拒」，401/403 弹「凭据被拒」，跟默认型号通不通无关。清单是空的时为 null。
 */
export function claudeDesktopStartupCheckModel(models: readonly string[]): string | null {
  for (const tier of ['haiku', 'sonnet', 'opus']) {
    const matches = models.filter((model) => model.toLowerCase().includes(tier))
    if (!matches.length) continue
    const regular = matches.filter((model) => !fineTunedModelPattern.test(model))
    return (regular.length ? regular : matches).reduce((shortest, model) => shortest.length <= model.length ? shortest : model)
  }
  return models[0] ?? null
}

export interface ClaudeDesktopModelSelection {
  /** 写进配置的清单：选中的排第一（Claude Desktop 拿它当默认），后面是试通了的。 */
  models: string[]
  /** 试过没通的，只进运行日志。 */
  rejected: string[]
}

/**
 * 保存 Claude Desktop 配置时写哪几个型号。选中的那个照旧写（客户自己挑的，保存后的复测会照实说通不通），
 * 其余候选逐个交给 probe 发一个字，回 true 的才放进清单；probe 抛错算没通。一个都没通就和以前一样只有选中的。
 */
export async function resolveClaudeDesktopModels(
  selected: string,
  models: readonly string[],
  probe: (model: string) => Promise<boolean>,
): Promise<ClaudeDesktopModelSelection> {
  const tried = await probeClaudeDesktopModels(claudeDesktopModelCandidates(models, selected), probe)
  return { models: [selected, ...tried.passed], rejected: tried.rejected }
}

/**
 * 把 candidates 逐个交给 probe 发一个字（最多同时 probeConcurrency 个），按原来的先后分成通了的和没通的；probe 抛错
 * 算没通。保存配置和开机补型号共用这一份，两边试的规矩一样。
 */
export async function probeClaudeDesktopModels(
  candidates: readonly string[],
  probe: (model: string) => Promise<boolean>,
): Promise<{ passed: string[]; rejected: string[] }> {
  const passed = await mapWithConcurrency(candidates, probeConcurrency, async (model) => {
    try {
      return await probe(model)
    } catch {
      return false
    }
  })
  return {
    passed: candidates.filter((_model, index) => passed[index]),
    rejected: candidates.filter((_model, index) => !passed[index]),
  }
}

/**
 * 开机补型号拿哪几个去试：menu 是菜单里现在的型号（第一项是默认），按今天保存会挑的那几个算
 * （claudeDesktopModelCandidates），去掉菜单里已经有的，再去掉 known 里的。known 是上一次补的时候这把密钥列着的型号
 * （那次试过没通的不算，下次还试）：它们不是新上的，不在菜单里是客户自己拿掉的、菜单满了，或者本来就排不进最新那几个，
 * 不再补。没有记录时为 null，这次照保存的挑法补一遍。菜单没有型号（由 Claude Desktop 自己问网关要）或者已经满了，
 * 一个都不试。
 */
export function claudeDesktopTopUpCandidates(
  menu: readonly string[],
  offered: readonly string[],
  known: readonly string[] | null,
): string[] {
  const [selected] = menu
  if (selected === undefined || menu.length >= claudeDesktopTopUpMaximumModels) return []
  return claudeDesktopModelCandidates(offered, selected).filter((model) => !menu.includes(model) && !known?.includes(model))
}
