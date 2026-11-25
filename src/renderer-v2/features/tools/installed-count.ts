import type { AntigravityPresentation } from './antigravity'
import type { ToolPresentation } from './model'

/**
 * 首页工具区标题旁的「已安装 N 个」和状态栏的「已装 N 个工具」都用这一个数。以前两处各数各的：
 * 首页算了 Antigravity 两张卡和正在装的，状态栏没算，同一屏上一个写 5、一个写 3，客户以为有工具装坏了。
 * 按首页工具区里摆出来的卡数：命令行工具和 Codex 桌面端、外部客户端、Antigravity 两张；已经装好的，
 * 加上这会儿正在装的（首页那张卡已经显示进度，不当成没装）。
 */
export function installedToolCount(
  tools: readonly Pick<ToolPresentation, 'id' | 'status'>[],
  external: readonly { id: string; status: { installed: boolean } }[],
  antigravity: readonly Pick<AntigravityPresentation, 'id' | 'installed'>[],
  jobs: Readonly<Record<string, unknown>>,
): number {
  const running = (id: string) => Boolean(jobs[id])
  return tools.filter((tool) => tool.status.installed || running(tool.id)).length
    + external.filter((tool) => tool.status.installed || running(tool.id)).length
    + antigravity.filter((card) => card.installed || running(card.id)).length
}
