// 各业务页共用的参数类型 BusinessActions，连同它带着的几样：装工具的结果（ToolInstallOutcome）、反馈与客服页右边
// 那张「找客服」卡（FeedbackSupport）和外面点名要落的页签（FeedbackRequest）。#1070 第 11 步从 pages-maintenance.tsx
// 原样搬来；只有类型，pages-maintenance.tsx 照旧转出，原来从那里 import 的地方不用改。
import type { ReactNode } from 'react'
import type { SettingsGroupId, FeedbackTabValue } from './registry/business'
import type { ActiveProviderId } from '../../electron/catalog'
import type { ToolJob } from './features/tools/useToolbox'
import type { ChatTransfer } from './features/chat/transfer'
import type { V2Bridge, V2Page } from './types'
import type { AppSettingsV2Update, InstallCancelResult } from '../../electron/ipc-contract'
import type { LoginTarget } from './features/auth/api'

type AppSettings = Awaited<ReturnType<V2Bridge['getSettings']>>
// 已下线的 CLI（Gemini，yoyo 2026-10-14）不在这里：本页不再替它安装、检查或写 Key。
type Provider = ActiveProviderId
/**
 * installed：装好了；restart：运行环境要重启电脑才算装完；skipped：没有开始（取消、已在装或要自己下载）；
 * declined：客户在「换成星芒装的」确认框里点了取消，什么都没动，也不用说什么。
 */
export type ToolInstallOutcome = 'installed' | 'restart' | 'skipped' | 'declined'
/** 「找客服」卡上的几样：二维码按当前账号换，身份行和最近一次出错由 App 算好（同帮助与客服弹窗）。 */
export interface FeedbackSupport {
  qr?: string
  /** 二维码没生成出来时那一句；缺省 = 没出错。 */
  qrFallback?: string | null
  identity: string
  lastFailure?: string
  open: () => void
  copyIdentity: () => void
}
/** sequence 每次加一：已经在那个页签上、再点一次「查看日志」也照样清掉筛选、选好来源。 */
export interface FeedbackRequest {
  sequence: number
  tab: FeedbackTabValue
  /** 装工具没装上时的「查看日志」：来源先选好「安装与更新」。 */
  installLog?: true
}
export type BusinessActions = {
  /** 第二个参数是要落的分页、分组或那一页里的某一行；缺省 = 只跳页。 */
  navigate?: (page: V2Page, section?: string) => void
  openLogin?: (target?: LoginTarget) => void
  /** 个人中心「当前登录」里的「切换账号」：弹出切换账号框；缺省 = 按钮点不了。 */
  switchAccount?: () => void
  openHelp?: () => void
  onAccountChanged?: () => void
  onSettingsChanged?: (settings: AppSettings) => void
  openConfig?: (provider: Provider) => void
  /** 设置页的「新手引导」：真的重开四步引导，而不是跳去静态教程页（A8）。 */
  openGuide?: () => void
  /** 设置页的「重看界面导览」：回到首页重播首页上那几条操作提示（A8）。 */
  replayTour?: () => void
  /**
   * 页面里装好了运行环境（精选、外接工具页的「自动安装 Python」）以后叫一声，由 App 重新检测，首页跟着变；
   * 不叫的话首页还写 Python「未安装」。装工具不用它：走 installTool，装完还要写 Key。页面先叫它、再读本页：
   * 本页那次读接上 App 刚起的那一轮检测，不另起一轮。
   * 缺省 = 只刷新本页（旧行为）。
   */
  onSystemChanged?: () => void
  /**
   * 首页那条完整的安装：缺 Node.js / Python 先装运行环境，装完写 Key、刷新检测。
   * 以前「安装卸载」页自己直接调主进程装工具，没装 Node.js 的人只看到「未检测到
   * npm」（全面检测 Q33）；有了它就只走这一条。
   */
  installTool?: (tool: Provider | 'codexDesktop') => Promise<ToolInstallOutcome>
  /** 与 installTool 配对的取消：首页那条安装在准备运行环境时会说明为什么不能取消。 */
  cancelToolInstall?: (tool: Provider | 'codexDesktop') => Promise<InstallCancelResult>
  /**
   * 首页那份正在跑的任务（按工具编号）。扩展页拿它画「安装中」，检查页拿它让运行环境那几行的按钮转圈；
   * 在首页点的安装这几页也看得到。缺省 = 只看这一页自己发起的那次。
   */
  toolJobs?: Readonly<Record<string, ToolJob>>
  /**
   * 连接自检的密钥 / 分组层给出的「重新写入密钥」：复用装完工具后那条同样的重写
   * 流程（App 的 syncAfterToolInstalled），失败时把主进程的原话抛出来，页面照实显示。
   */
  onRewriteKey?: (provider: Provider) => Promise<boolean>
  /** 哪几个工具的配置确实来自当前账号——只有它们重写得动（见 rewritableKeyProviders）。 */
  rewritableKeys?: readonly Provider[]
  /**
   * 检查页 Node.js、Python、Git 那几行的「安装」（第 10 批从「安装卸载」页挪过来）：走首页运行环境卡那一条，
   * 装完要重启电脑时弹重启框、检测跟着重跑。缺省 = 那几行不给「安装」，「安装指南」照旧。
   */
  onInstallRuntime?: (runtime: 'node' | 'python' | 'git') => void
  /** 检查页「换成新版」「换成新版 Node.js」：先弹确认框再换（同错误框里那一颗）。缺省 = 不给这颗按钮。 */
  onReplaceNode?: () => void
  /** 反馈与客服页右边那张「找客服」卡，跟帮助与客服弹窗是同一份。缺省 = 没有这张卡。 */
  support?: FeedbackSupport
  /** 外面点名要落的反馈与客服页签（「查看日志」「运行日志」）。缺省 = 留言反馈。 */
  feedbackRequest?: FeedbackRequest
  /** 「先试试这些」里给不给「看我的订单」：历史账号没有订单。缺省 = 给。 */
  ordersVisible?: boolean
  /**
   * App 手里最新的界面缩放（'auto' 表示自动）。在设置页开着时按 Ctrl 加号，设置页那一栏
   * 要跟着变；缺省 = 不同步，只用设置页自己读到的那份（旧行为）。
   */
  uiScale?: NonNullable<AppSettingsV2Update['uiScale']>
  /** 设置页「搬到新电脑」里聊天记录那一半；没登录时没有（聊天记录按账号分开存）。 */
  chatTransfer?: ChatTransfer
  /**
   * App 手里最新的设置。「启动时检查新版本」「自动更新」在设置页、版本更新卡（更新气泡里也有
   * 「自动更新」）各有一个开关，哪边改了另一边要跟着变；缺省 = 只用页面自己读到的那份（旧行为）。
   */
  appSettings?: AppSettings
  /** 有新版本（发现了、在下或下好了）：设置左栏「版本更新」后面带个点。缺省 = 不带。 */
  updateAvailable?: boolean
  /** 游戏加速开着：设置左栏「网络加速」后面带个绿点。缺省 = 不带。 */
  accelerating?: boolean
  /**
   * 设置 › 网络加速最上面那张游戏加速卡，由 App 画：连接挂在 App 上（托盘、到期提醒、Codex 桌面端
   * 自动连接都连着它）。参数是这张卡此刻在不在眼前，不在时剩余时长不跟着每秒走。缺省 = 没有这张卡。
   */
  accelerationCard?: (shown: boolean) => ReactNode
  /** 设置现在摆着哪一组（搜索时 null）：App 据此判断人是不是就在「版本更新」，不再弹同一件事的更新气泡。 */
  onSettingsGroupChange?: (group: SettingsGroupId | null) => void
  /**
   * 外壳告诉页面「现在显示的是你」。去过的页面换走时只藏起来、不卸载（App.tsx 的 visitedPages），
   * 再显示时页面自己重读一次（useReloadWhenShown），和点页头那颗按钮一样；缺省 = 不重读（旧行为）。
   */
  active?: boolean
}
