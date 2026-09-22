import fs from 'node:fs/promises'
import path from 'node:path'

interface ExportedFileInfo {
  isFile(): boolean
}

export interface ExportedFileProbe {
  lstat?: (target: string) => Promise<ExportedFileInfo>
}

/**
 * Check a just-exported file before asking the desktop shell to select it.
 * The caller has already required that this exact path came back from one of
 * our own save-dialog exports, so this only answers "is what we wrote still
 * there": `lstat` (not `stat`) so a file swapped for a link after the export
 * is not followed somewhere else. `showItemInFolder` only selects the item and
 * never runs it, which is why nothing stricter than a plain file is required.
 */
export async function resolveRevealableExportedFile(
  filePath: string,
  probe: ExportedFileProbe = {},
): Promise<string> {
  if (!path.isAbsolute(filePath)) throw new Error('导出文件的位置不完整，没法定位。')
  const resolved = path.resolve(filePath)
  let info: ExportedFileInfo
  try {
    info = await (probe.lstat ?? fs.lstat)(resolved)
  } catch {
    throw new Error('导出的文件已经不在原来的位置了，可能被移动或删除。')
  }
  if (!info.isFile()) throw new Error('原来的位置现在不是导出的那个文件了，没有打开。')
  return resolved
}
