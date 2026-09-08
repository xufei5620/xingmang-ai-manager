export const MAX_AVATAR_FILE_BYTES = 2 * 1024 * 1024
export const AVATAR_IMAGE_SIZE = 256
const MAX_SAVED_AVATAR_LENGTH = 512 * 1024
const PNG_PREFIX = 'data:image/png;base64,'

export interface AvatarIdentity {
  origin: string
  userId: number
}
export interface AvatarCrop {
  zoom: number
  horizontal: number
  vertical: number
}
export const defaultAvatarCrop: AvatarCrop = {
  zoom: 1,
  horizontal: 50,
  vertical: 50,
}

export function avatarStorageKey(identity: AvatarIdentity): string {
  const origin = new URL(identity.origin)
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    !Number.isSafeInteger(identity.userId) ||
    identity.userId < 1
  )
    throw new Error('账号信息尚未确认，请刷新后再设置头像。')
  return `xingmang-v2-avatar:${encodeURIComponent(origin.origin)}:${identity.userId}`
}

export function avatarInitial(name: string): string {
  const trimmed = name.trim()
  return [...trimmed][0]?.toLocaleUpperCase() ?? '星'
}

export function detectAvatarMime(
  bytes: Uint8Array,
): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (
    bytes.length >= 24 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => bytes[index] === value,
    )
  )
    return 'image/png'
  if (
    bytes.length >= 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    return 'image/jpeg'
  if (
    bytes.length >= 16 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  )
    return 'image/webp'
  return null
}

export function avatarCropRectangle(
  width: number,
  height: number,
  crop: AvatarCrop,
) {
  if (
    ![width, height, crop.zoom, crop.horizontal, crop.vertical].every(
      Number.isFinite,
    ) ||
    width <= 0 ||
    height <= 0
  )
    throw new Error('图片裁剪信息无效。')
  const zoom = Math.min(4, Math.max(1, crop.zoom))
  const side = Math.min(width, height) / zoom
  const x = ((width - side) * Math.min(100, Math.max(0, crop.horizontal))) / 100
  const y = ((height - side) * Math.min(100, Math.max(0, crop.vertical))) / 100
  return { x, y, side }
}

export async function decodeAvatarImage(file: File): Promise<ImageBitmap> {
  if (file.size === 0) throw new Error('这张图片是空文件，请重新选择。')
  if (file.size > MAX_AVATAR_FILE_BYTES)
    throw new Error('图片不能超过 2 MB，请换一张较小的图片。')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const type = detectAvatarMime(bytes)
  if (!type || (file.type && file.type !== type))
    throw new Error('请选择 PNG、JPEG 或 WebP 图片。')
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type }), {
      imageOrientation: 'from-image',
    })
  } catch {
    throw new Error('这张图片无法打开，请换一张图片。')
  }
  if (
    bitmap.width < 1 ||
    bitmap.height < 1 ||
    bitmap.width > 16384 ||
    bitmap.height > 16384 ||
    bitmap.width * bitmap.height > 64_000_000
  ) {
    bitmap.close()
    throw new Error('图片尺寸过大，请先缩小后再选择。')
  }
  return bitmap
}

export function drawAvatarCrop(
  canvas: HTMLCanvasElement,
  image: ImageBitmap,
  crop: AvatarCrop,
): void {
  canvas.width = AVATAR_IMAGE_SIZE
  canvas.height = AVATAR_IMAGE_SIZE
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法准备头像预览，请关闭弹窗后重试。')
  const { x, y, side } = avatarCropRectangle(image.width, image.height, crop)
  context.clearRect(0, 0, AVATAR_IMAGE_SIZE, AVATAR_IMAGE_SIZE)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(
    image,
    x,
    y,
    side,
    side,
    0,
    0,
    AVATAR_IMAGE_SIZE,
    AVATAR_IMAGE_SIZE,
  )
}

export function validSavedAvatar(dataUrl: unknown): dataUrl is string {
  if (
    typeof dataUrl !== 'string' ||
    dataUrl.length > MAX_SAVED_AVATAR_LENGTH ||
    !dataUrl.startsWith(PNG_PREFIX)
  )
    return false
  try {
    const bytes = Uint8Array.from(
      atob(dataUrl.slice(PNG_PREFIX.length)),
      (value) => value.charCodeAt(0),
    )
    if (detectAvatarMime(bytes) !== 'image/png') return false
    const data = new DataView(bytes.buffer)
    return (
      data.getUint32(16, false) === AVATAR_IMAGE_SIZE &&
      data.getUint32(20, false) === AVATAR_IMAGE_SIZE
    )
  } catch {
    return false
  }
}

export function readSavedAvatar(
  storage: Pick<Storage, 'getItem'>,
  key: string,
): string | null {
  const source = storage.getItem(key)
  if (!source) return null
  if (source.length > MAX_SAVED_AVATAR_LENGTH + 256)
    throw new Error('本机头像数据无法读取，可以重新设置头像。')
  const record: unknown = JSON.parse(source)
  if (
    !record ||
    typeof record !== 'object' ||
    !('version' in record) ||
    record.version !== 1 ||
    !('dataUrl' in record) ||
    !validSavedAvatar(record.dataUrl)
  )
    throw new Error('本机头像数据无法读取，可以重新设置头像。')
  return record.dataUrl
}

export function writeSavedAvatar(
  storage: Pick<Storage, 'setItem'>,
  key: string,
  dataUrl: string,
): void {
  if (!validSavedAvatar(dataUrl))
    throw new Error('头像预览尚未准备好，请重新选择图片。')
  try {
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        dataUrl,
        updatedAt: new Date().toISOString(),
      }),
    )
  } catch {
    throw new Error(
      '头像没有保存成功，裁剪预览已保留。请释放本机存储空间后重试。',
    )
  }
}
