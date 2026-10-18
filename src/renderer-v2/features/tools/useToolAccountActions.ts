import { useCallback, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { AccountSessionState, AccountSourceSwitchResult, AccountSourceTarget } from '../../../../electron/ipc-contract'
import { offersCodexDesktopRestart } from '../../../../electron/running-tools'
import type { LatestRequest } from '../../latest-request'
import type { ToolConfigConfirmation } from '../../pages-account'
import { tools } from '../../registry/tools'
import type { AuthMode } from '../auth'
import { markDiagnosticsStale } from '../app/environment-status'
import type { AppToast, Toolbox, ToolsApi } from '../app/runtime-context'
import type { ConfigSaveOutcome } from './ConfigDialog'
import { brokenConfigDetails, brokenConfigOf, brokenConfigRepairTarget, providerFor, spacedName, type ToolId } from './model'
import { applyManualSourceMarker, getSourceMarkerStorage } from './source-marker'
import { jobToolName } from './tool-jobs'

interface ToolAccountActionsOptions {
  toolsApi: ToolsApi
  toolbox: Toolbox
  toast: AppToast
  session: AccountSessionState
  mounted: RefObject<boolean>
  accountEpoch: LatestRequest
  configTool: ToolId | null
  setConfigTool: Dispatch<SetStateAction<ToolId | null>>
  setAuth: Dispatch<SetStateAction<AuthMode | null>>
  setCcSwitchReminder: Dispatch<SetStateAction<boolean>>
  setSwitchRestartOffer: Dispatch<SetStateAction<AccountSourceTarget | null>>
}

/** 首页工具卡上改配置的那几件：切到当前账号 / 切回官方、就用现在这份、修提醒设置、重置坏掉的配置，以及配置弹窗保存之后。 */
export function useToolAccountActions({ toolsApi, toolbox, toast, session, mounted, accountEpoch, configTool, setConfigTool, setAuth, setCcSwitchReminder, setSwitchRestartOffer }: ToolAccountActionsOptions) {
  const [toolConfigConfirmed, setToolConfigConfirmed] = useState<ToolConfigConfirmation | null>(null)
  /**
   * 首页「就用现在这份」：用户自己改过配置又不想被提醒时，把这个工具记成手动来源。
   * 写的是配置对话框里「自己填写密钥」同一个本机标记，所以以后在配置里改回星芒
   * 账号时会被自动清掉，不需要另开一条通道来撤销。
   */
  const keepCurrentToolConfig = useCallback(async (tool: ToolId) => {
    const provider = providerFor(tool)
    const current = toolbox.snapshot?.config.providers[provider]
    if (!current) throw new Error('请先完成工具检测')
    const warning = applyManualSourceMarker(getSourceMarkerStorage(), current.baseUrl, provider, true)
    if (warning) toast.show(warning, 'warn')
    else toast.show(`好的，${spacedName(tools.find((entry) => entry.id === tool)?.name ?? '工具')}就用现在这份配置，不再提醒`, 'ok')
    await toolbox.refreshConfig().catch(() => undefined)
  }, [toast, toolbox.refreshConfig, toolbox.snapshot])
  /**
   * 首页「切到当前账号 / 切回官方账号」。主进程一次做完备份、写入、自检和失败
   * 回滚，成功与失败都只说一句话；失败的那句走统一的错误条（perform）。
   */
  const switchToolAccount = useCallback(async (tool: ToolId, target: AccountSourceTarget): Promise<AccountSourceSwitchResult | null> => {
    if (target === 'account' && (!session.authenticated || !session.account)) { setAuth('login'); return null }
    const provider = providerFor(tool)
    // CC Switch 还开着的话，它切供应商、退出时写回接管前的备份，都会把刚写好的配置
    // 改回去。一闪而过的提示容易看漏，改完用一个要点「知道了」的框说（方案盘查第 5 条）；
    // 退不退由用户定。
    const ccSwitchLeftover = target === 'account' && Boolean(toolbox.snapshot?.config.providers[provider].ccSwitchLeftover)
    // 引导要按这次的结果决定第 4 步怎么说（自检没通过时不能写「已准备好」）。
    const outcome: { result?: AccountSourceSwitchResult } = {}
    // 登记成工具行上的任务（全面检测 Q35）：切换要备份、写入、自检，失败还要回滚，
    // 一次得好几秒。以前没有忙态，连点两下就是两次切换叠在一起跑；现在同一个工具
    // 在切的时候行上显示「切换中」、菜单收起，再点也进不来。
    await toolbox.run(`switch:${tool}`, target === 'account' ? '正在改用当前账号' : '正在切回官方账号', async () => {
      try {
        const result = await toolsApi.switchSource(tool, target)
        outcome.result = result
        // 与配置对话框保存时一样：换了来源就清掉「自己填写密钥」的本机标记。
        const baseUrl = toolbox.snapshot?.config.providers[provider].baseUrl
        const markerWarning = baseUrl ? applyManualSourceMarker(getSourceMarkerStorage(), baseUrl, provider, false) : ''
        toast.show(result.message, result.loginRequired || (target === 'account' && !result.verified) ? 'warn' : 'ok')
        if (markerWarning) toast.show(markerWarning, 'warn')
        if (ccSwitchLeftover) setCcSwitchReminder(true)
        // Codex CLI 与 Codex 桌面端读的是同一份配置：从哪一行点的，两行都一起换了。
        if (provider === 'codex' && target === 'account') toast.show('Codex CLI 和 Codex 桌面端共用一份设置，已一起改好。', 'neutral')
        if (provider === 'codex' && offersCodexDesktopRestart(result.runningTools)) setSwitchRestartOffer(target)
      } finally {
        await toolbox.refresh(true).catch(() => undefined)
      }
    })
    return outcome.result ?? null
  }, [session.account, session.authenticated, toast, toolbox.refresh, toolbox.run, toolbox.snapshot, toolsApi, setAuth, setCcSwitchReminder, setSwitchRestartOffer])
  /**
   * 首页「提醒设置要修」的「修好它」。主进程先备份、只改钩子与状态行、再查一遍；
   * 没修好会抛中文原因，走统一的错误条（perform）。
   */
  const repairToolHooks = useCallback(async (tool: ToolId) => {
    await toolbox.run(`repair-hooks:${tool}`, '正在修提醒设置', async () => {
      try {
        await toolsApi.repairHooks(tool)
        toast.show('提醒设置已改好，原来的设置已备份。', 'ok')
      } finally {
        await toolbox.refreshConfig().catch(() => undefined)
      }
    })
  }, [toast, toolbox.refreshConfig, toolbox.run, toolsApi])
  /**
   * 首页「配置文件坏了」的「修好它」：工具自己都读不了它的配置（Codex 的 config.toml、auth.json，
   * Claude Code 的 settings.json）。做的就是配置里「高级」的「重置为初始状态」：主进程
   * 先备份、再按现在用的账号整份重新生成。看得出原来用官方登录的照旧用官方账号，其余按当前账号
   * （brokenConfigRepairTarget）；没登录就先去登录。
   */
  const repairBrokenToolConfig = useCallback(async (tool: ToolId): Promise<boolean> => {
    const provider = providerFor(tool)
    const config = toolbox.snapshot?.config.providers[provider]
    if (!config) throw new Error('请先完成工具检测')
    // 按钮只在坏了时给；这期间重新检测过、文件已经好了，就不用再重置一次。
    const broken = brokenConfigOf(config, provider)
    if (!broken) return false
    const target = brokenConfigRepairTarget(broken, config)
    if (target === 'account' && (!session.authenticated || !session.account)) { setAuth('login'); return false }
    let written = false
    // 按工具家族登记：两行 Codex 共用一份配置，一行在修时另一行也是「修复中」，不会两次重置叠着跑。
    await toolbox.run(`repair-config:${provider}`, brokenConfigDetails[broken], async () => {
      try {
        if (target === 'official') await toolsApi.official(tool, 'reset')
        else {
          // 还读得出模型的照旧用它，同配置里的重置；读不出就用账号的默认模型。
          const result = await toolsApi.configureManaged(tool, config.model.trim() || undefined, 'reset')
          if (result.failed.length) throw new Error(result.failed.map((item) => item.message).join('；'))
          if (!result.configured.includes(provider)) throw new Error('工具没有返回配置写入结果，请重新检测后再试。')
        }
        written = true
        // 与配置对话框重置时一样：整份重新生成了，「自己填写密钥」的本机标记跟着清掉。
        const markerWarning = config.baseUrl ? applyManualSourceMarker(getSourceMarkerStorage(), config.baseUrl, provider, false) : ''
        toast.show(`已重置 ${spacedName(jobToolName(tool) ?? tool)}的配置，原来的配置已备份`, 'ok')
        if (markerWarning) toast.show(markerWarning, 'warn')
      } finally {
        await toolbox.refresh(true).catch(() => undefined)
      }
    })
    return written
  }, [session.account, session.authenticated, toast, toolbox.refresh, toolbox.run, toolbox.snapshot, toolsApi, setAuth])
  // 设置窗口写进了新 Key：读回配置成功才告诉密钥页，好收起那条「还在用刚撤销的密钥」（#546）。
  // 读回失败就不收，警告宁可多留一会儿。
  function confirmToolKeyWritten(tool: ToolId) {
    const sameAccount = accountEpoch.capture()
    const provider = providerFor(tool)
    void toolsApi.readConfig().then((config) => {
      if (!mounted.current || !sameAccount() || config.providers[provider].configurationOwnership === 'missing') return
      setToolConfigConfirmed((current) => ({ provider, sequence: (current?.sequence ?? 0) + 1 }))
    }, () => undefined)
  }
  function finishConfigSave(warning?: string, outcome: ConfigSaveOutcome = 'saved') {
    const sameAccount = accountEpoch.capture()
    const name = configTool ? jobToolName(configTool) ?? configTool : '工具'
    markDiagnosticsStale()
    setConfigTool(null)
    // 配置弹窗的保存不带连接自检（主进程只写文件），这里不说「自检通过」。
    toast.show(outcome === 'reset' ? `已重置 ${spacedName(name)}的配置，原来的配置已备份` : outcome === 'official' ? '已切回官方账号，原来的配置已备份' : `${spacedName(name)}的配置已保存`, 'ok')
    if (warning) toast.show(warning, 'warn')
    void toolbox.refresh(true).catch(() => {
      if (mounted.current && sameAccount()) {
        toast.show('配置已保存，但最新状态没有读到。请重新检测，无需重复保存。', 'warn')
      }
    })
  }
  return { toolConfigConfirmed, keepCurrentToolConfig, switchToolAccount, repairToolHooks, repairBrokenToolConfig, confirmToolKeyWritten, finishConfigSave }
}
