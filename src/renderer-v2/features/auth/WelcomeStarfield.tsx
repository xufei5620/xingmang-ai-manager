import { memo } from 'react'
import { buildWelcomeStarLinks, buildWelcomeStars, welcomeStarGroup, welcomeStarGroupCount } from './welcome-starfield'

const stars = buildWelcomeStars()
const links = buildWelcomeStarLinks(stars)
const groups = Array.from({ length: welcomeStarGroupCount }, (_, group) => stars.filter((star) => welcomeStarGroup(star) === group))

function percent(value: number) {
  return `${(value * 100).toFixed(2)}%`
}

/**
 * 星星和连线只在挂上时画一次（SVG 的坐标用百分比，窗口缩放时跟着走、星星还是圆的）。
 * 会动的只有：每层星星整体的透明度、一颗流星的位置和透明度，都由合成器去算，不重新排版也不重画。
 */
export const WelcomeStarfield = memo(function WelcomeStarfield() {
  return <>
    <div className="auth-stars" aria-hidden="true" data-testid="welcome-starfield">
      <svg className="auth-star-links" width="100%" height="100%">{links.map((link, index) => <line key={index} x1={percent(link.ax)} y1={percent(link.ay)} x2={percent(link.bx)} y2={percent(link.by)} strokeOpacity={link.strength.toFixed(2)} />)}</svg>
    </div>
    {groups.map((group, index) => <svg className="auth-stars-twinkle" data-group={index} width="100%" height="100%" aria-hidden="true" key={index}>{group.map((star, starIndex) => <circle key={starIndex} className={star.gold ? 'auth-star-gold' : undefined} cx={percent(star.x)} cy={percent(star.y)} r={star.radius.toFixed(2)} />)}</svg>)}
    <i className="auth-meteor" aria-hidden="true" />
  </>
})
