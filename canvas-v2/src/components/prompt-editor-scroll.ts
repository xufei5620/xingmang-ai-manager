interface PromptScrollViewport {
  scrollTop: number
  scrollLeft: number
  offsetWidth: number
  clientWidth: number
}
interface PromptScrollMirror {
  scrollTop: number
  scrollLeft: number
  style: { paddingRight: string }
}

export function synchronizePromptScroll(textarea: PromptScrollViewport, highlight: PromptScrollMirror, contentPaddingRight: number): void {
  // Keep line wraps identical when a platform reserves width for a scrollbar.
  // The editor's content padding is still needed on overlay-scrollbar systems.
  highlight.style.paddingRight = `${Math.max(0, contentPaddingRight) + Math.max(0, textarea.offsetWidth - textarea.clientWidth)}px`
  highlight.scrollTop = textarea.scrollTop
  highlight.scrollLeft = textarea.scrollLeft
}
