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
  const candidates = claudeDesktopModelCandidates(models, selected)
  const passed = await mapWithConcurrency(candidates, probeConcurrency, async (model) => {
    try {
      return await probe(model)
    } catch {
      return false
    }
  })
  return {
    models: [selected, ...candidates.filter((_model, index) => passed[index])],
    rejected: candidates.filter((_model, index) => !passed[index]),
  }
}
