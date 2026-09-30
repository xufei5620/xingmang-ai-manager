import type { UserWideCertificateTrustResult } from '../../../../electron/ipc-contract'

type DetailValue = boolean | number | string | null

/**
 * 检查页「安全证书」一项：主进程查出公司证书、且当前 Windows 账号还没设过那一条时，
 * 才给「让这台电脑上所有终端都信任」按钮（第十八批 7）。
 */
export function canTrustCertificatesUserWide(item: { code: string; details?: Record<string, DetailValue> }): boolean {
  return item.code === 'CERTIFICATE_TRUST' && item.details?.userWide === 'available'
}

export const certificateTrustConfirmTitle = '让这台电脑上所有终端都信任？'

export const certificateTrustConfirmBody = '星芒会给你这个 Windows 账号加一项设置，让自己开的终端、VS Code 里的 Gemini CLI 也信任这台电脑装的证书。只影响你这个账号，不影响别人；新开的终端才生效。'

export function certificateTrustMessage(result: UserWideCertificateTrustResult): string {
  return result === 'applied'
    ? '设好了。关掉已经开着的终端、VS Code，重新打开后就能用 Gemini。'
    : '你这个账号自己设过这一项，星芒没有改它。'
}
