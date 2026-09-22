import { useEffect, useRef } from 'react'
import { starfieldAnimates, starfieldFrameDue, starfieldLinks, starfieldPixelRatio, type StarfieldLink } from './starfield-plan'

export function Starfield({ paused, quiet = false }: { paused: boolean; quiet?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const host = canvas?.parentElement
    const context = canvas?.getContext('2d')
    if (!canvas || !host || !context) return
    let frame = 0
    let width = 0
    let height = 0
    // CSS HMR can briefly clear custom properties between stylesheet swaps.
    // Keep the canvas drawable during that interval instead of passing an
    // empty string to CanvasGradient/CanvasRenderingContext2D.
    let accent = '#E0BE7C'
    let starColor = '#9FB2C8'
    let dark = false
    let seed = 311
    const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
    const stars = Array.from({ length: quiet ? 70 : 170 }, () => ({ x: random(), y: random(), radius: .4 + random() * 1.2, phase: random() * Math.PI * 2, speed: .4 + random(), gold: random() < .22 }))
    let links: StarfieldLink[] = []
    let horizon: CanvasGradient | null = null
    let reduce = paused
    // 窗口不在前台（失焦、最小化、缩到托盘）时星空停在当前这一帧，回到前台再接着动。
    let foreground = document.visibilityState === 'visible'
    let lastPainted: number | null = null
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const colors = () => {
      const css = getComputedStyle(host)
      const root = document.documentElement.dataset
      dark = root.theme === 'dark'
      const fallbackAccent = dark ? '#E0BE7C' : '#96702C'
      const fallbackStar = dark ? '#9FB2C8' : '#7A705B'
      accent = css.getPropertyValue('--accent').trim() || fallbackAccent
      starColor = css.getPropertyValue(dark ? '--xm-sky' : '--text-3').trim() || fallbackStar
      reduce = !starfieldAnimates({ paused, reducedMotion: root.reducedMotion === 'true', systemReducedMotion: media.matches, lowEndDevice: root.lowEnd === 'true' })
    }
    const paint = (time: number) => {
      context.clearRect(0, 0, width, height)
      context.globalAlpha = (dark ? .16 : .10) * (quiet ? .55 : 1)
      context.fillStyle = horizon ?? 'transparent'
      context.fillRect(0, 0, width, height)
      for (const star of stars) {
        context.globalAlpha = (reduce ? .7 : Math.max(.1, .45 + .4 * Math.sin(time / 900 * star.speed + star.phase))) * (quiet ? dark ? .55 : .32 : dark ? 1 : .55)
        context.fillStyle = star.gold ? accent : starColor
        context.beginPath()
        context.arc(star.x * width, star.y * height, star.radius, 0, Math.PI * 2)
        context.fill()
      }
      const linkAlpha = quiet ? dark ? .05 : .035 : dark ? .1 : .06
      context.strokeStyle = starColor
      context.lineWidth = .6
      for (const link of links) {
        context.globalAlpha = linkAlpha * link.strength
        context.beginPath()
        context.moveTo(link.ax, link.ay)
        context.lineTo(link.bx, link.by)
        context.stroke()
      }
      if (!reduce) {
        const passage = time % 11_000
        if (passage < 1400) {
          const progress = passage / 1400
          const x = width * (.86 - progress * .32), y = height * (.12 + progress * .22)
          const tail = context.createLinearGradient(x, y, x + 80, y - 28)
          tail.addColorStop(0, accent); tail.addColorStop(1, 'transparent')
          context.globalAlpha = Math.sin(progress * Math.PI) * (dark ? .8 : .45) * (quiet ? .6 : 1)
          context.strokeStyle = tail; context.lineWidth = 1.4
          context.beginPath(); context.moveTo(x, y); context.lineTo(x + 80, y - 28); context.stroke()
        }
      }
      context.globalAlpha = 1
    }
    const tick = (time: number) => {
      frame = 0
      if (reduce || !foreground) return
      if (starfieldFrameDue(time, lastPainted)) { lastPainted = time; paint(time) }
      frame = window.requestAnimationFrame(tick)
    }
    const schedule = () => {
      window.cancelAnimationFrame(frame)
      frame = 0
      if (!reduce && foreground) frame = window.requestAnimationFrame(tick)
    }
    const resize = () => {
      width = host.clientWidth; height = host.clientHeight
      const ratio = starfieldPixelRatio(window.devicePixelRatio, width, height)
      canvas.width = width * ratio; canvas.height = height * ratio
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      colors()
      links = starfieldLinks(stars, width, height)
      horizon = context.createRadialGradient(width / 2, height * 1.25, 0, width / 2, height * 1.25, width * .62)
      horizon.addColorStop(0, accent)
      horizon.addColorStop(1, 'transparent')
      lastPainted = null
      paint(0)
      schedule()
    }
    const focus = () => { foreground = document.visibilityState === 'visible'; schedule() }
    const blur = () => { foreground = false; schedule() }
    const visibility = () => { if (document.visibilityState === 'visible') focus(); else blur() }
    const observer = new ResizeObserver(resize)
    const themeObserver = new MutationObserver(resize)
    observer.observe(host)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-skin', 'data-reduced-motion', 'data-low-end'] })
    media.addEventListener('change', resize)
    window.addEventListener('focus', focus)
    window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', visibility)
    resize()
    return () => {
      window.cancelAnimationFrame(frame); observer.disconnect(); themeObserver.disconnect(); media.removeEventListener('change', resize)
      window.removeEventListener('focus', focus); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', visibility)
    }
  }, [paused, quiet])
  return <canvas ref={ref} className={quiet ? 'v2-workspace-starfield' : 'auth-starfield'} aria-hidden="true" data-testid={quiet ? 'shell-starfield' : 'welcome-starfield'} />
}
