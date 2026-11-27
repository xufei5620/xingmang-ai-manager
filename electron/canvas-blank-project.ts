import {
  claimCanvasDefaultProjectFolder,
  describeCanvasDefaultProjectFolderFailure,
  releaseCanvasDefaultProjectFolder,
} from './canvas-default-project-folder'
import { displayCanvasProjectName, type CanvasProjectStore } from './canvas-project-store'
import type { CanvasProjectCreated } from './ipc-contract'

// 主窗口「创作」左栏的「新建画布」（yoyo 2026-11-28 回「新建画布按钮」）：一键建一个空白画布项目，主窗口再把画布开在它上面。
// 跟画布里点「新建项目」走同一套：文件夹建在「文档 › 星芒画布」里、一个项目一个新文件夹、已经在的文件夹不用
// （canvas-default-project-folder.ts），然后登记进当前账号的项目表。
// 入口只有主窗口的一条通道（canvas:create-project），不收任何参数：名字和位置都由这里定，渲染层给不了路径（I5、I8）；
// 画布窗口的宿主通道一条没加（I15）。回的只有编号和名字，不回路径。
// 主窗口被动了手脚以后多出来的：能在「星芒画布」里多建几个空项目（项目表本身有上限），仅此而已。

export interface BlankCanvasProjectOptions {
  projects: Pick<CanvasProjectStore, 'create'>
  /** 新建的项目放在它下面，一个项目一个新文件夹。 */
  defaultProjectsDirectory: () => string
  now?: () => Date
}

export type BlankCanvasProjectCreator = (userId: number) => Promise<CanvasProjectCreated>

function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}

/** 「未命名画布 11 月 27 日 14:30」：带上点的那一刻，连建几个也分得清；以后在画布「项目中心」里改名。 */
export function buildBlankCanvasProjectName(at: Date): string {
  return `未命名画布 ${at.getMonth() + 1} 月 ${at.getDate()} 日 ${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}`
}

export function createBlankCanvasProjectCreator(options: BlankCanvasProjectOptions): BlankCanvasProjectCreator {
  return async function createBlankCanvasProject(userId) {
    const name = buildBlankCanvasProjectName((options.now ?? (() => new Date()))())
    let directory: string
    try {
      directory = claimCanvasDefaultProjectFolder(options.defaultProjectsDirectory(), name)
    } catch (error) {
      throw new Error(`无法在「星芒画布」文件夹中新建项目（${describeCanvasDefaultProjectFolderFailure(error)}）。请打开画布，在「项目中心」中新建。`)
    }
    // 登记没成（项目数到了上限、文件夹被别的项目占着）：刚建的空文件夹收走，原因照它自己的话报。
    try {
      const created = await options.projects.create(userId, name, directory)
      return { projectId: created.project.id, projectName: displayCanvasProjectName(created.project.name) }
    } catch (error) {
      releaseCanvasDefaultProjectFolder(directory)
      throw error
    }
  }
}
