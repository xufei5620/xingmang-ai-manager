import { isExternalUrlBlockedError } from '../../electron/external-url-blocked'

export interface BlockedLinkNotice { copied: boolean; url: string }

/**
 * 公告、协议是服务端下发的内容，运营随手贴的「活动详情」页十有八九不在主进程
 * 那张逐字全等的外链名单里（I12，不放宽）。拦下是对的，但只说一句「不允许打开」
 * 用户就走投无路了：把地址交到用户手里，自己去浏览器里打开。
 *
 * 只认 http / https、且不带账号密码段：`https://xm.solov.cc@evil.example` 这种
 * 地址在浏览器地址栏里看着像自家站点，不能由我们亲手递过去。
 */
export function copyableBlockedLink(href: string): string | null {
  let url: URL
  try { url = new URL(href) } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username !== '' || url.password !== '') return null
  return url.href
}

function writeClipboardText(text: string): Promise<void> {
  return navigator.clipboard.writeText(text)
}

/**
 * 打开成功返回 null；主进程按错误码拒绝、且链接可以交给用户时复制并返回提示；
 * 其它失败原样抛出，由调用方照旧当错误处理。判断只看主进程给的错误码，不比对文案。
 */
export async function openExternalOrCopy(
  href: string,
  openExternal: (url: string) => Promise<unknown>,
  copyText: (text: string) => Promise<void> = writeClipboardText,
): Promise<BlockedLinkNotice | null> {
  try {
    await openExternal(href)
    return null
  } catch (error) {
    const url = isExternalUrlBlockedError(error) ? copyableBlockedLink(href) : null
    if (!url) throw error
    // 打包版里剪贴板仍可能被系统拒绝；那时把地址摆出来让用户自己选中复制。
    try {
      await copyText(url)
      return { copied: true, url }
    } catch {
      return { copied: false, url }
    }
  }
}

export function blockedLinkMessage(notice: BlockedLinkNotice): string {
  return notice.copied
    ? '这个链接要在浏览器里打开，已经帮你复制好了，打开浏览器粘贴到地址栏就行。'
    : '这个链接要在浏览器里打开，请选中下面的地址复制，再粘贴到浏览器地址栏。'
}

export function BlockedLinkHint({ notice, testId }: { notice: BlockedLinkNotice; testId?: string }) {
  return <div className="v2-blocked-link" role="status" data-testid={testId}>
    <p>{blockedLinkMessage(notice)}</p>
    <code>{notice.url}</code>
  </div>
}
