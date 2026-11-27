import { redactSecretPatterns } from '../../../../electron/redaction-patterns'
import { speaksChinese, userFacingErrorMessage } from '../../business-common'

// 「创作」左栏的「新建画布」（yoyo 2026-11-28 回「新建画布按钮」）：一键建空白画布项目并在画布窗口打开。
// 建项目在主进程（canvas-blank-project.ts），这里只有点了以后要说的那两句。字逐字照方案（0.2.26-方案/画布入口/方案.md）。

/** 主进程没给出能上屏的原话时的兜底句：跟它自己那句同一个说法，原因用「无法创建文件夹」。 */
export const newCanvasFailureMessage = '无法在「星芒画布」文件夹中新建项目（无法创建文件夹）。请打开画布，在「项目中心」中新建。'

/** 没建成：主进程说的中文原话上屏（没有写入权限、磁盘满了、项目数到了上限），别的换成兜底句。 */
export function newCanvasErrorMessage(error: unknown): string {
  const message = userFacingErrorMessage(error)
  return message && speaksChinese(message) ? redactSecretPatterns(message) : newCanvasFailureMessage
}

/** 建好了，可画布窗口正开着别的项目、客户在它的关闭确认里选了留下：项目已经在左边了。 */
export function newCanvasNotOpenedMessage(projectName: string): string {
  return `已新建「${projectName}」，可稍后在左侧列表中打开。`
}
