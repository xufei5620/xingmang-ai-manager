import { useEffect, useRef } from 'react'
import type { ThemeMode } from '../../app-shared'

export function WelcomeStarfield({ theme, paused }: { theme: ThemeMode; paused: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    let frame = 0
    let width = 0
    let height = 0
    const stars = Array.from({ length: 72 }, (_, index) => ({
      x: ((index * 163 + 73) % 997) / 997,
      y: ((index * 263 + 31) % 991) / 991,
      size: index % 9 === 0 ? 1.4 : 0.7,
      phase: index * 1.7,
    }))

    const draw = (time: number) => {
      context.clearRect(0, 0, width, height)
      const color = getComputedStyle(canvas).getPropertyValue('--color-accent').trim()
      context.fillStyle = color || (theme === 'dark' ? '#E0BE7C' : '#96702C')
      for (const star of stars) {
        context.globalAlpha = (theme === 'dark' ? 0.3 : 0.15) * (1 + Math.sin(time / 3000 + star.phase) * 0.4)
        context.fillRect(star.x * width, star.y * height, star.size, star.size)
      }
      context.globalAlpha = 1
      if (!paused && !document.hidden) frame = requestAnimationFrame(draw)
    }
    const redraw = () => {
      cancelAnimationFrame(frame)
      const bounds = canvas.getBoundingClientRect()
      width = bounds.width
      height = bounds.height
      const scale = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * scale)
      canvas.height = Math.round(height * scale)
      context.setTransform(scale, 0, 0, scale, 0, 0)
      draw(0)
    }
    const observer = new ResizeObserver(redraw)
    observer.observe(canvas)
    document.addEventListener('visibilitychange', redraw)
    redraw()
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', redraw)
      cancelAnimationFrame(frame)
    }
  }, [theme, paused])

  return <canvas ref={canvasRef} className="welcome-starfield" aria-hidden="true" />
}
