// 「保存工作流」「导出工作流」成功后的提示（#4）。两个按钮都交给宿主的 exportProject：网页把工作流文件交给浏览器下载，
// 素材不在里面；桌面弹系统保存对话框，把工作流用到的本地素材一起打包进文件，所以照桌面 v2 编辑器的原句说。
// 桌面的项目包只带图片（桌面 electron/canvas-project-package.ts），视频、音频留在本机素材库里；
// 工作流里有它们时照实说，免得客户以为都带走了，换台电脑才发现那几个节点是空的（桌面 #1368 第 14 条）。
import type { CanvasHostKind } from '../host-kind'
import type { WorkflowFile } from '../model'

const desktopMediaLeftBehind = '；视频、音频不在文件里，换电脑打开前先在素材库另存出来'

export function workflowSavedNotice(host: CanvasHostKind, hasVideoOrAudio = false): string {
  if (host !== 'desktop') return '已请求浏览器下载工作流；素材文件需在素材库单独下载'
  return hasVideoOrAudio ? `工作流已保存${desktopMediaLeftBehind}` : '工作流已保存'
}

export function workflowExportedNotice(host: CanvasHostKind, hasVideoOrAudio = false): string {
  if (host !== 'desktop') return '工作流已导出；素材文件需在素材库单独下载'
  return hasVideoOrAudio ? `项目和图片已导出${desktopMediaLeftBehind}` : '项目和本地素材已导出'
}

/** Whether a saved file leaves a local video or audio behind: any node whose result is one. */
export function workflowHasVideoOrAudio(workflow: Pick<WorkflowFile, 'nodes'>): boolean {
  return workflow.nodes.some((node) => {
    const result = node.data.result
    return Boolean(result?.assetId) && (result?.kind === 'video' || result?.kind === 'audio')
  })
}
