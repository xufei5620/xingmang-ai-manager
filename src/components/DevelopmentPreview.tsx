import { useEffect, useState } from 'react'
import { WelcomePage } from './welcome/WelcomePage'
import { initialTheme, type ThemeMode } from '../app-shared'

/**
 * Vite's standalone browser entry has no Electron preload bridge. Keep that
 * case useful for visual QA without weakening the packaged app's IPC boundary
 * or login gate: the real App is still mounted whenever the bridge exists.
 */
export function DevelopmentPreview() {
  const [theme, setTheme] = useState<ThemeMode>(() => (
    typeof window === 'undefined' ? 'dark' : initialTheme()
  ))
  const [notice, setNotice] = useState('开发预览：登录与安装操作需要在 Electron 窗口中执行。')

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.dataset.skin = theme === 'dark' ? 'obsidian' : 'dawn'
    document.documentElement.style.colorScheme = theme
    try {
      window.localStorage.setItem('xingmang-theme-v2', theme)
    } catch {
      // The preview remains usable when local storage is unavailable.
    }
  }, [theme])

  return (
    <div className="development-preview" data-development-preview="true">
      <WelcomePage
        theme={theme}
        onRegister={() => setNotice('开发预览：请在 Electron 窗口中完成注册。')}
        onLogin={() => setNotice('开发预览：请在 Electron 窗口中完成登录。')}
        onOpenSupport={() => setNotice('开发预览：客服入口需要 Electron 外部链接能力。')}
      />
      <div className="development-preview-notice" role="status" aria-live="polite">{notice}</div>
      <button
        type="button"
        className="development-preview-theme"
        aria-label={`切换到${theme === 'dark' ? '亮色' : '暗色'}预览`}
        title={`切换到${theme === 'dark' ? '亮色' : '暗色'}预览`}
        onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
      >
        {theme === 'dark' ? '亮色预览' : '暗色预览'}
      </button>
    </div>
  )
}
