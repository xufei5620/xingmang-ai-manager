// 宿主桥 —— 隔离窗口里由 canvas-preload 暴露的 window.xingmangCanvasHost。
// v2 沿用 v1 的 5 能力面(I15:能力只减不增);开发态(vite dev,无宿主)
// 降级到浏览器行为,保证画布可以脱离桌面端独立开发调试。

export interface CanvasHostBridge {
  getAuthToken(): Promise<{ baseUrl: string; apiKey: string } | null>
  saveFile(input: { defaultFileName: string; content: string }): Promise<{ saved: boolean }>
  pickFile(): Promise<{ name: string; content: string } | null>
  notify(message: string): Promise<void>
  openExternal(url: string): Promise<void>
}

declare global {
  interface Window {
    xingmangCanvasHost?: CanvasHostBridge
  }
}

export function hostBridge(): CanvasHostBridge {
  const native = window.xingmangCanvasHost
  if (native) return native
  return {
    async getAuthToken() {
      return null
    },
    async saveFile({ defaultFileName, content }) {
      const blob = new Blob([content], { type: 'application/json' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = defaultFileName
      link.click()
      URL.revokeObjectURL(link.href)
      return { saved: true }
    },
    async pickFile() {
      return new Promise((resolve) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'application/json'
        input.onchange = async () => {
          const file = input.files?.[0]
          if (!file) {
            resolve(null)
            return
          }
          resolve({ name: file.name, content: await file.text() })
        }
        input.click()
      })
    },
    async notify(message) {
      console.info(`[画布通知] ${message}`)
    },
    async openExternal(url) {
      window.open(url, '_blank', 'noopener')
    },
  }
}
