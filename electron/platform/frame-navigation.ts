import type { WebContents } from 'electron'

const inlineFrameUrls = new Set(['about:blank', 'about:srcdoc'])

export function shouldPreventMainWindowFrameNavigation(url: string, isMainFrame: boolean): boolean {
  if (isMainFrame) return false
  return !inlineFrameUrls.has(url)
}

export function installMainWindowFrameNavigationGuard(contents: WebContents): void {
  contents.on('will-frame-navigate', (event) => {
    if (shouldPreventMainWindowFrameNavigation(event.url, event.isMainFrame)) event.preventDefault()
  })
}
