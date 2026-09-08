import { useEffect, useRef } from 'react'

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
    let reduce = paused
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const colors = () => {
      const css = getComputedStyle(host)
      dark = document.documentElement.dataset.theme === 'dark'
      const fallbackAccent = dark ? '#E0BE7C' : '#96702C'
      const fallbackStar = dark ? '#9FB2C8' : '#7A705B'
      accent = css.getPropertyValue('--accent').trim() || fallbackAccent
      starColor = css.getPropertyValue(dark ? '--xm-sky' : '--text-3').trim() || fallbackStar
      reduce = paused || document.documentElement.dataset.reducedMotion === 'true' || media.matches
    }
    const draw = (time: number) => {
      context.clearRect(0, 0, width, height)
      const horizon = context.createRadialGradient(width / 2, height * 1.25, 0, width / 2, height * 1.25, width * .62)
      horizon.addColorStop(0, accent)
      horizon.addColorStop(1, 'transparent')
      context.globalAlpha = (dark ? .16 : .10) * (quiet ? .55 : 1)
      context.fillStyle = horizon
      context.fillRect(0, 0, width, height)
      for (const star of stars) {
        context.globalAlpha = (reduce ? .7 : Math.max(.1, .45 + .4 * Math.sin(time / 900 * star.speed + star.phase))) * (quiet ? dark ? .55 : .32 : dark ? 1 : .55)
        context.fillStyle = star.gold ? accent : starColor
        context.beginPath()
        context.arc(star.x * width, star.y * height, star.radius, 0, Math.PI * 2)
        context.fill()
      }
      for (let i = 0; i < stars.length; i++) {
        for (let j = i + 1; j < stars.length; j++) {
          const a = stars[i], b = stars[j]
          const distance = Math.hypot((a.x - b.x) * width, (a.y - b.y) * height)
          if (distance > 90) continue
          context.globalAlpha = (quiet ? dark ? .05 : .035 : dark ? .1 : .06) * (1 - distance / 90)
          context.strokeStyle = starColor
          context.lineWidth = .6
          context.beginPath()
          context.moveTo(a.x * width, a.y * height)
          context.lineTo(b.x * width, b.y * height)
          context.stroke()
        }
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
        frame = window.requestAnimationFrame(draw)
      }
      context.globalAlpha = 1
    }
    const resize = () => {
      window.cancelAnimationFrame(frame)
      width = host.clientWidth; height = host.clientHeight
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = width * ratio; canvas.height = height * ratio
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      colors(); draw(0)
    }
    const observer = new ResizeObserver(resize)
    const themeObserver = new MutationObserver(resize)
    observer.observe(host)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-skin', 'data-reduced-motion'] })
    media.addEventListener('change', resize)
    resize()
    return () => { window.cancelAnimationFrame(frame); observer.disconnect(); themeObserver.disconnect(); media.removeEventListener('change', resize) }
  }, [paused, quiet])
  return <canvas ref={ref} className={quiet ? 'v2-workspace-starfield' : 'auth-starfield'} aria-hidden="true" data-testid={quiet ? 'shell-starfield' : 'welcome-starfield'} />
}
