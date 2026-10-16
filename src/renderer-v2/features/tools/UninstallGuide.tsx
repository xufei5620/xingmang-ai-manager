import type { ExternalToolId } from '../../../../electron/ipc-contract'
import { Button, Dialog } from '../../ui'
import type { WindowOs } from '../app/window-os'
import { spacedName } from './model'

/**
 * 星芒替客户卸不了、要客户自己在系统里删的桌面端：三个外接客户端（主进程从来没有卸它们的
 * 通道），加上 Mac 上的 Codex 桌面端（codexDesktop.uninstall 只在 Windows 为真，Mac 上主进程
 * 直接拒绝）。「安装卸载」页拆掉以后命令行工具的卸载都在卡片「…」里，这几张卡片什么都没有，
 * 客户以为是漏了（yoyo 2026-10-16 选「只给指引」）。
 */
export type UninstallGuideTool = ExternalToolId | 'codexDesktop'

export interface UninstallGuide {
  title: string
  lead: string
  steps: string[]
  after: string
}

/** 系统「已安装的应用」和访达「应用程序」里看到的名字，和卡片上的不一样。Mac 上检测到了就以检测到的为准。 */
const systemNames: Record<UninstallGuideTool, string> = {
  claudeDesktop: 'Claude',
  opencode: 'OpenCode',
  workbuddy: 'WorkBuddy',
  codexDesktop: 'ChatGPT',
}

/**
 * Mac 上主进程报的是认出来的那个 .app 的路径，访达里显示的就是去掉 .app 的文件名。Codex 桌面端
 * 官方包装出来叫 ChatGPT.app，可早先的官方包叫 Codex.app，检测两个都认；写死 ChatGPT 的话，
 * 同时留着 OpenAI 旧聊天程序 ChatGPT.app 的人会照着删错。
 */
function macBundleName(path: string | null | undefined): string | null {
  const base = path?.replace(/\/+$/, '').split('/').pop() ?? ''
  return /^.+\.app$/i.test(base) ? base.slice(0, -4) : null
}

/**
 * 不是管理员的账号，星芒把程序装进他自己的「应用程序」（~/Applications），访达左边那个「应用程序」
 * 是 /Applications，照着找不到。渲染层拿不到主目录，只认 /Users/<名字>/Applications 这种常见的样子，
 * 认不出来照旧写左边那个。
 */
function inUserApplications(path: string | null | undefined): boolean {
  return /^\/Users\/[^/]+\/Applications\/[^/]+\.app\/*$/i.test(path ?? '')
}

/**
 * 卡片上名字为 name 的这个桌面端在这台电脑上该怎么自己卸。星芒自己能卸的（Windows 上的
 * Codex 桌面端）和根本不列这几张卡片的系统（Linux）给 null，菜单里就不加「卸载…」。
 * path 是主进程检测到的位置，Mac 上用来取访达里的名字。
 */
export function buildUninstallGuide(tool: UninstallGuideTool, name: string, os: WindowOs, path?: string | null): UninstallGuide | null {
  const systemName = (os === 'mac' ? macBundleName(path) : null) ?? systemNames[tool]
  const title = `怎么卸载 ${name}`
  const lead = `${spacedName(name)}要在系统里卸载：`
  if (os === 'win') {
    if (tool === 'codexDesktop') return null
    return { title, lead, after: '卸完回到星芒，点首页的「重新检测」。', steps: [
      '打开 Windows「设置 → 应用 → 已安装的应用」（Windows 10 上叫「应用和功能」）。',
      `找到 ${systemName}，点右边的「…」→「卸载」（Windows 10 上先点它，再点「卸载」）。`,
    ] }
  }
  if (os === 'mac') {
    // Mac 上 Codex 桌面端装出来叫 ChatGPT，不点明的话客户在「应用程序」里找不到「Codex」。
    const found = tool === 'codexDesktop' && systemName !== 'Codex' ? `${systemName}（Codex 桌面端在 Mac 上叫这个名字）` : systemName
    return { title, lead, after: '删完回到星芒，点首页的「重新检测」。', steps: [
      // 开着的程序访达不让拖进废纸篓。
      `先退出 ${systemName}（在它的窗口里按 ⌘Q）。`,
      inUserApplications(path) ? '打开访达，按 ⇧⌘H 打开你的个人文件夹，再打开里面的「应用程序」。' : '打开访达，点左边的「应用程序」。',
      `找到 ${found}，把它拖进废纸篓。`,
    ] }
  }
  return null
}

export function UninstallGuideDialog({ guide, onClose }: { guide: UninstallGuide; onClose(): void }) {
  return <Dialog open title={guide.title} width={480} onClose={onClose} testId="uninstall-guide"
    footer={<Button onClick={onClose} testId="uninstall-guide-close">知道了</Button>}>
    <div className="v2-uninstall-guide">
      <p>{guide.lead}</p>
      <ol>{guide.steps.map((step) => <li key={step}>{step}</li>)}</ol>
      <p>{guide.after}</p>
    </div>
  </Dialog>
}
