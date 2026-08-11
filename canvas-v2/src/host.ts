// 宿主桥 —— 隔离窗口里由主仓 electron/canvas-preload.ts 暴露的
// window.xingmangCanvasHost,方法签名与返回形状照抄该文件(位置参数,
// 不是对象参数;saveFile 取消返回 null)。v2 沿用 v1 的 5 能力面
// (I15:能力只减不增)。开发态(vite dev,无宿主)降级到浏览器行为,
// 保证画布可以脱离桌面端独立开发调试。

export interface CanvasHostBridge {
  getAuthToken(): Promise<{ baseUrl: string; apiKey: string } | null>
  saveFile(suggestedName: string, content: string): Promise<{ savedPath: string } | null>
  pickFile(): Promise<{ name: string; content: string } | null>
  notify(title: string, body?: string): Promise<boolean>
  openExternal(url: string): Promise<void>
  /**
   * 媒体产物落盘(第 6 能力,主进程流式拉 URL 写入用户对话框选择的路径,
   * 512MB 上限)。旧版宿主可能没有此方法,调用方经 hostBridge() 拿到的
   * 实现已做特性探测与降级,不必自查。
   */
  downloadAsset(url: string, suggestedName: string): Promise<{ savedPath: string; bytes: number } | null>
}

declare global {
  interface Window {
    xingmangCanvasHost?: CanvasHostBridge
  }
}

export function hostBridge(): CanvasHostBridge {
  const native = window.xingmangCanvasHost
  if (native) {
    if (typeof native.downloadAsset === 'function') return native
    // 旧版宿主(第 6 能力之前打包的桌面端):降级为浏览器窗口打开产物 URL。
    return {
      ...native,
      async downloadAsset(url) {
        window.open(url, '_blank', 'noopener')
        return null
      },
    }
  }
  return {
    async getAuthToken() {
      return null
    },
    async saveFile(suggestedName, content) {
      const blob = new Blob([content], { type: 'application/json' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = suggestedName
      link.click()
      URL.revokeObjectURL(link.href)
      return { savedPath: suggestedName }
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
    async notify(title, body) {
      console.info(`[画布通知] ${title}${body ? `:${body}` : ''}`)
      return false
    },
    async openExternal(url) {
      window.open(url, '_blank', 'noopener')
    },
    async downloadAsset(url) {
      window.open(url, '_blank', 'noopener')
      return null
    },
  }
}
