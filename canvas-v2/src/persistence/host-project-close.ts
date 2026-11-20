// 返回项目中心时（桌面 Mac 验收 R3）：存完最后一次再告诉宿主，这个页面不再开着这个项目。
// 桌面主进程按「这个窗口开着哪个项目」决定素材库读哪里，不告诉它，项目中心的只读素材库（主窗口「看做过的图」）
// 列的还是刚离开那个项目的素材。宿主没有这个方法（网页）就什么都不做；宿主回绝或者出错也照常回到项目中心，
// 最坏是宿主那边还跟原来一样记着旧项目。
import type { CanvasHostBridge } from '../host'

export async function closeProjectForHost(host: Pick<CanvasHostBridge, 'closeProject'>, projectId: string): Promise<void> {
  if (!host.closeProject) return
  try {
    await host.closeProject(projectId)
  } catch {
    // The project is already saved; going back must not hinge on the host's bookkeeping.
  }
}
