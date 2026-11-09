import fs from 'node:fs'
import path from 'node:path'
import { ensureSafeDataDirectory } from './safe-local-data'

// 新建画布项目默认放进「文档 › 星芒画布 › 项目名」，不先弹选文件夹的框（画布完善第 3 条）。
// 文件夹名从项目名来，去掉 Windows、Mac 不许出现在文件名里的字符；同名的已经在了就加「 (2)」「 (3)」。
// 每次都新建一个文件夹，已经在的文件夹一律不用：里面可能是别的项目，也可能是客户自己的东西。

const maximumFolderNameLength = 64
const maximumAttempts = 100
const fallbackFolderName = '未命名项目'
// Windows refuses these base names whatever the extension ("CON", "con.txt").
const reservedWindowsName = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i

export function buildCanvasProjectFolderName(projectName: string): string {
  const cleaned = projectName
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    // A leading dot hides the folder on Mac and Linux; Windows drops trailing dots and spaces.
    .replace(/^[. ]+|[. ]+$/g, '')
  const shortened = Array.from(cleaned).slice(0, maximumFolderNameLength).join('').replace(/[. ]+$/, '')
  if (!shortened) return fallbackFolderName
  return reservedWindowsName.test(shortened) ? `${shortened}_` : shortened
}

/**
 * Creates and returns a new, empty folder for a project under rootDirectory.
 * The folder is made without `recursive`, so an existing one is never reused:
 * a name that is taken moves on to the next suffix.
 */
export function claimCanvasDefaultProjectFolder(rootDirectory: string, projectName: string): string {
  ensureSafeDataDirectory(rootDirectory, '「星芒画布」文件夹')
  const base = buildCanvasProjectFolderName(projectName)
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const candidate = path.join(rootDirectory, attempt === 1 ? base : `${base} (${attempt})`)
    try {
      fs.mkdirSync(candidate)
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('「星芒画布」文件夹里同名的项目太多，请换个名字')
}

/**
 * Why the default folder could not be made, in words for the user. System
 * errors carry an English message and the full path; neither belongs on the
 * screen, so they are told apart by code.
 */
export function describeCanvasDefaultProjectFolderFailure(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EPERM' || code === 'EACCES') return '没有权限写入'
  if (code === 'ENOSPC') return '磁盘空间不够'
  if (code === 'EROFS') return '磁盘是只读的'
  if (!code && error instanceof Error && error.message) return error.message
  return '文件夹建不出来'
}

/**
 * Removes a claimed folder the project never moved into, with the empty
 * assets folder creation may have made in it. Only empty folders go.
 */
export function releaseCanvasDefaultProjectFolder(directory: string): void {
  for (const target of [path.join(directory, 'assets'), directory]) {
    try {
      fs.rmdirSync(target)
    } catch {
      // Not empty, or already gone: leave whatever is there.
    }
  }
}
