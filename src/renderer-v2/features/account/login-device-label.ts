// 服务端只回原始 User-Agent（例如
// 「Mozilla/5.0 (Windows NT 10.0; Win64; x64) … xingmang-ai-manager/0.2.10 … Electron/43.6.0 …」），
// 小白看不懂。这里只在显示层把它认成大白话，发给服务端和从服务端拿到的原文都不动。

const unknownDeviceLabel = '其他设备'
const appDisplayName = '星芒AI管理工具'

function deviceSystem(userAgent: string): string | null {
  if (/iPhone/.test(userAgent)) return 'iPhone'
  if (/iPad/.test(userAgent)) return 'iPad'
  if (/Android/i.test(userAgent)) return '安卓手机'
  if (/Windows/.test(userAgent)) return 'Windows 电脑'
  if (/Macintosh|Mac OS X/.test(userAgent)) return 'Mac'
  if (/CrOS/.test(userAgent)) return 'Chromebook'
  if (/Linux/.test(userAgent)) return 'Linux 电脑'
  return null
}

// 顺序有讲究：Edge / Opera / 微信 / QQ 浏览器的标识里都带着 Chrome 和 Safari，
// Chrome 的标识里也带着 Safari，所以要先认更具体的那个。
function browserName(userAgent: string): string | null {
  if (/MicroMessenger/i.test(userAgent)) return '微信'
  if (/\bQQBrowser\//.test(userAgent)) return 'QQ 浏览器'
  if (/\bEdg(?:e|A|iOS)?\//.test(userAgent)) return 'Edge 浏览器'
  if (/\bOPR\//.test(userAgent)) return 'Opera 浏览器'
  if (/\b(?:Firefox|FxiOS)\//.test(userAgent)) return 'Firefox 浏览器'
  if (/\b(?:Chrome|CriOS)\//.test(userAgent)) return 'Chrome 浏览器'
  if (/\bVersion\/[\d.]+.*\bSafari\//.test(userAgent)) return 'Safari 浏览器'
  if (/^Mozilla\//.test(userAgent)) return '浏览器'
  return null
}

function joinParts(parts: Array<string | null>): string {
  return parts.filter((part): part is string => Boolean(part)).join(' · ')
}

export function describeLoginDevice(userAgent: string): string {
  const value = userAgent.trim()
  if (!value) return unknownDeviceLabel
  const system = deviceSystem(value)
  const app = /\bxingmang-ai-manager\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(value)
  if (app || /\bxingmang-ai-manager\b/.test(value)) {
    return joinParts([app ? `${appDisplayName} ${app[1]}` : appDisplayName, system])
  }
  const browser = browserName(value)
  if (browser) return joinParts([browser, system])
  return unknownDeviceLabel
}
