/**
 * 欢迎页满屏星空的布点，照 0.2.18 那块画布星空：同一个种子、同样 170 颗、22% 是金色的，
 * 离得近的两颗之间连一条淡线。0.2.18 每一帧把整个窗口重画一遍（界面进程约 30%、显卡进程约 70%，
 * 见 批次性能要求 批03），这里只算一次位置交给 SVG 画死，闪烁改成几层整体变透明度，由合成器去做。
 */

export interface WelcomeStar {
  /** 0..1，占欢迎页宽度的比例。 */
  x: number
  /** 0..1，占欢迎页高度的比例。 */
  y: number
  radius: number
  /** 0..1：同一层的星星一起闪，按 0.2.18 每颗星的闪烁快慢分层，快的和快的一层。 */
  speed: number
  gold: boolean
}

export interface WelcomeStarLink {
  ax: number
  ay: number
  bx: number
  by: number
  /** 0..1：1 - 距离 / 连线距离，越近越亮。 */
  strength: number
}

export const welcomeStarCount = 170
export const welcomeStarGroupCount = 5

// 连线按默认窗口（1280×820）量一次距离：窗口拉大缩小时线跟着星星按比例伸缩，不再重算。
const referenceWidth = 1280
const referenceHeight = 820
const linkDistance = 90

/** 和 0.2.18 Starfield 同一个 Lehmer 随机数和取数顺序，星星落在原来的位置上。 */
export function buildWelcomeStars(count = welcomeStarCount, seed = 311): WelcomeStar[] {
  let state = seed
  function random() {
    state = (state * 16807) % 2147483647
    return state / 2147483647
  }
  return Array.from({ length: count }, () => {
    const x = random()
    const y = random()
    const radius = .4 + random() * 1.2
    // 0.2.18 这里还取了一个相位；不用它，但照样取一次，后面的星星才能落在原来的位置上。
    random()
    const speed = random()
    const gold = random() < .22
    return { x, y, radius, speed, gold }
  })
}

export function buildWelcomeStarLinks(stars: readonly WelcomeStar[]): WelcomeStarLink[] {
  const links: WelcomeStarLink[] = []
  for (let i = 0; i < stars.length; i++) {
    for (let j = i + 1; j < stars.length; j++) {
      const a = stars[i], b = stars[j]
      const distance = Math.hypot((a.x - b.x) * referenceWidth, (a.y - b.y) * referenceHeight)
      if (distance > linkDistance) continue
      links.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, strength: 1 - distance / linkDistance })
    }
  }
  return links
}

export function welcomeStarGroup(star: WelcomeStar): number {
  return Math.min(welcomeStarGroupCount - 1, Math.floor(star.speed * welcomeStarGroupCount))
}
