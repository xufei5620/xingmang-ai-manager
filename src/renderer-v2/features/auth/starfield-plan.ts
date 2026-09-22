export interface StarfieldStar {
  x: number
  y: number
  radius: number
  phase: number
  speed: number
  gold: boolean
}

export interface StarfieldLink {
  ax: number
  ay: number
  bx: number
  by: number
  // 0..1: 1 - distance / linkDistance. The caller multiplies it by the theme alpha.
  strength: number
}

export interface StarfieldMotionInput {
  paused: boolean
  reducedMotion: boolean
  systemReducedMotion: boolean
  lowEndDevice: boolean
}

// 30 帧对「星星闪一闪」这种慢变化已经看不出区别，却能把重画次数砍掉一半。
export const starfieldFrameIntervalMs = 1000 / 30
// requestAnimationFrame 的时间戳会有 1~2 毫秒抖动；不留余量的话 60Hz 屏幕上
// 有一半「该画」的帧会被判成早到，实际掉到 20 帧。
const frameJitterMs = 4
const linkDistance = 90
// 1440×900 的窗口在 2 倍屏上的物理像素：默认大小（1280×820）和常见的拉大一点
// 都不受影响；只有把窗口铺满 4K 屏这类情况才封顶——画布再大也看不出更清楚的星星，
// 只会让每次清屏重画的像素翻倍。
const maxBackingPixels = 2880 * 1800

export function starfieldAnimates(input: StarfieldMotionInput) {
  return !input.paused && !input.reducedMotion && !input.systemReducedMotion && !input.lowEndDevice
}

export function starfieldFrameDue(time: number, lastPainted: number | null) {
  return lastPainted === null || time - lastPainted >= starfieldFrameIntervalMs - frameJitterMs
}

export function starfieldPixelRatio(devicePixelRatio: number, width: number, height: number) {
  const ratio = Math.min(devicePixelRatio || 1, 2)
  const area = width * height
  if (area <= 0 || area * ratio * ratio <= maxBackingPixels) return ratio
  return Math.max(1, Math.sqrt(maxBackingPixels / area))
}

// 星星的位置只跟窗口大小有关，连线也就只需要在尺寸变化时算一次，
// 不必每一帧都把所有两两距离重算一遍。
export function starfieldLinks(stars: readonly StarfieldStar[], width: number, height: number) {
  const links: StarfieldLink[] = []
  for (let i = 0; i < stars.length; i++) {
    for (let j = i + 1; j < stars.length; j++) {
      const a = stars[i], b = stars[j]
      const distance = Math.hypot((a.x - b.x) * width, (a.y - b.y) * height)
      if (distance > linkDistance) continue
      links.push({ ax: a.x * width, ay: a.y * height, bx: b.x * width, by: b.y * height, strength: 1 - distance / linkDistance })
    }
  }
  return links
}
