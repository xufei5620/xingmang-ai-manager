// 主窗口业务通道的处理器：「创作 › 作品库」（融合第 3 步）。只有「列出来」这一条；看图、放视频走 xingmang-asset:
// 协议，另存、用播放器打开用对话和视频已有的那几条，每一条都在主进程按当前账号再认一次。
// 第 5 步起连画布项目文件夹里生成的一起列（options.accountAssets）；通道还是这一条，没有新增。
import { parseAiLibraryListInput } from '../parsers/ai-library'
import type { IpcHandlerContext } from './context'

export function registerAiLibraryHandlers(ctx: IpcHandlerContext): void {
  const { options, registerTrustedHandler, accountService } = ctx
  registerTrustedHandler('library:list', (_event, input: unknown) => {
    if (!options.mediaAssets && !options.accountAssets) throw new Error('作品库未就绪')
    const query = parseAiLibraryListInput(input)
    const session = accountService.getSessionState()
    const userId = session.authenticated ? session.account?.userId : undefined
    if (!userId) throw new Error('请先登录星芒账号')
    if (options.accountAssets) return options.accountAssets.listLibrary(userId, query)
    // 没接画布项目的那一层（测试、预览）：只有 AI 作品文件夹，按项目看的那一种列不了。
    const { canvasProjectId, ...global } = query
    if (canvasProjectId !== undefined || !options.mediaAssets) throw new Error('作品库未就绪')
    return options.mediaAssets.listOwnedLibrary(userId, global)
  })
}
