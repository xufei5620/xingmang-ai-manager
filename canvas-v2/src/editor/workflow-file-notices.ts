// 「保存工作流」「导出工作流」成功后的提示（#4）。两个按钮都交给宿主的 exportProject：网页把工作流文件交给浏览器下载，
// 素材不在里面；桌面弹系统保存对话框，把工作流用到的本地素材一起打包进文件，所以照桌面 v2 编辑器的原句说。
import type { CanvasHostKind } from '../host-kind'

export function workflowSavedNotice(host: CanvasHostKind): string {
  return host === 'desktop' ? '工作流已保存' : '已请求浏览器下载工作流；素材文件需在素材库单独下载'
}

export function workflowExportedNotice(host: CanvasHostKind): string {
  return host === 'desktop' ? '项目和本地素材已导出' : '工作流已导出；素材文件需在素材库单独下载'
}
