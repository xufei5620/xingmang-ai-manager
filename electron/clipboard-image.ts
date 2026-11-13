/**
 * 图片进出剪贴板（作品菜单「复制」、AI 聊天里 Ctrl+V 贴截图）。Electron 44 起剪贴板只剩按格式
 * （MIME）读写的异步接口，readImage / writeImage 没了（官方破坏性改动「clipboard module
 * rearchitected」）。图片一律以 image/png 进出：写进去的 PNG 由 Chromium 同时放成系统的位图
 * 格式，别的软件照样粘得进去；截图工具、浏览器放进来的位图读出来也是 image/png。
 */

import { fileURLToPath } from 'node:url'

export const CLIPBOARD_IMAGE_TYPE = 'image/png'

export interface ClipboardImageEntry {
  readonly types: readonly string[]
  getType(type: string): Promise<unknown>
}

export interface ClipboardImageSource {
  read(): Promise<readonly ClipboardImageEntry[]>
}

export interface ClipboardImageTarget<Item> {
  write(items: Item[]): Promise<void>
}

/** 剪贴板里那张图的 PNG 字节；没有图返回 null。 */
export async function readClipboardPng(clipboard: ClipboardImageSource): Promise<Buffer | null> {
  for (const item of await clipboard.read()) {
    if (!item.types.includes(CLIPBOARD_IMAGE_TYPE)) continue
    const payload = await item.getType(CLIPBOARD_IMAGE_TYPE)
    if (payload instanceof Blob) return Buffer.from(await payload.arrayBuffer())
  }
  return null
}

/** `createItem` 是 Electron 的 `new ClipboardItem(...)`，测试里换成普通对象。 */
export async function writeClipboardPng<Item>(
  clipboard: ClipboardImageTarget<Item>,
  createItem: (payload: Record<string, Blob>) => Item,
  png: Buffer,
): Promise<void> {
  // Copy into a plain Uint8Array: a Buffer can be a view on a larger shared
  // pool, and the Blob must carry only this image's bytes.
  const blob = new Blob([new Uint8Array(png)], { type: CLIPBOARD_IMAGE_TYPE })
  await clipboard.write([createItem({ [CLIPBOARD_IMAGE_TYPE]: blob })])
}

// 在资源管理器、访达、文件管理器里「复制」的文件不是位图，剪贴板里只有文件的位置（J4）。Electron
// 把它们统一列成 text/uri-list（每行一个 file:// 地址；Linux 实测）。Windows、Mac 再各认一种系统
// 自带的格式兜底：资源管理器的 FileNameW（第一个文件的路径，UTF-16）、访达的 public.file-url。
export const CLIPBOARD_FILE_LIST_TYPE = 'text/uri-list'
const WINDOWS_FILE_NAME_TYPE = 'electron application/osclipboard;format="FileNameW"'
const MAC_FILE_URL_TYPE = 'electron application/osclipboard;format="public.file-url"'
// 一份文件清单写到这么长，复制的文件早就远超一条消息能带的张数了。
const MAX_FILE_LIST_BYTES = 1024 * 1024

function filePathFromUrl(value: string, platform: NodeJS.Platform): string | null {
  if (!/^file:/i.test(value)) return null
  try {
    return fileURLToPath(value, { windows: platform === 'win32' })
  } catch {
    return null
  }
}

/** text/uri-list 的写法：一行一个地址，# 开头的是注释；不是本机文件的地址不要。 */
export function parseClipboardFileList(text: string, platform: NodeJS.Platform): string[] {
  const paths: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim()
    if (!value || value.startsWith('#')) continue
    const filePath = filePathFromUrl(value, platform)
    if (filePath && !paths.includes(filePath)) paths.push(filePath)
  }
  return paths
}

async function readPayload(item: ClipboardImageEntry, type: string): Promise<Buffer | null> {
  if (!item.types.includes(type)) return null
  const payload = await item.getType(type)
  if (!(payload instanceof Blob) || payload.size === 0 || payload.size > MAX_FILE_LIST_BYTES) return null
  return Buffer.from(await payload.arrayBuffer())
}

function untilNul(text: string): string {
  const end = text.indexOf('\0')
  return end < 0 ? text : text.slice(0, end)
}

async function readEntryFilePaths(item: ClipboardImageEntry, platform: NodeJS.Platform): Promise<string[]> {
  const list = await readPayload(item, CLIPBOARD_FILE_LIST_TYPE)
  if (list) {
    const paths = parseClipboardFileList(list.toString('utf8'), platform)
    if (paths.length) return paths
  }
  if (platform === 'win32') {
    const name = await readPayload(item, WINDOWS_FILE_NAME_TYPE)
    const filePath = name ? untilNul(name.toString('utf16le')) : ''
    if (filePath) return [filePath]
  }
  if (platform === 'darwin') {
    const url = await readPayload(item, MAC_FILE_URL_TYPE)
    const filePath = url ? filePathFromUrl(untilNul(url.toString('utf8')).trim(), platform) : null
    if (filePath) return [filePath]
  }
  return []
}

/**
 * 剪贴板里「复制的文件」的路径，按复制时的先后；没有、读不出来都回空数组，从不抛错。
 * 路径只在主进程里从系统剪贴板读，调用方照选文件框选来的路径一样逐个检查后才读。
 */
export async function readClipboardFilePaths(clipboard: ClipboardImageSource, platform: NodeJS.Platform): Promise<string[]> {
  try {
    for (const item of await clipboard.read()) {
      const paths = await readEntryFilePaths(item, platform)
      if (paths.length) return paths
    }
  } catch {
    // A busy or unreadable clipboard simply holds no files for us.
  }
  return []
}
