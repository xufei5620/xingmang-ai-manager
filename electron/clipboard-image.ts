/**
 * 图片进出剪贴板（作品菜单「复制」、AI 聊天里 Ctrl+V 贴截图）。Electron 44 起剪贴板只剩按格式
 * （MIME）读写的异步接口，readImage / writeImage 没了（官方破坏性改动「clipboard module
 * rearchitected」）。图片一律以 image/png 进出：写进去的 PNG 由 Chromium 同时放成系统的位图
 * 格式，别的软件照样粘得进去；截图工具、浏览器放进来的位图读出来也是 image/png。
 */

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
