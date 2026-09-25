import type { AccountSessionState } from '../../../../electron/ipc-contract'
import { Button } from '../../ui'
import type { WindowOs } from './window-os'

const osLabels: Record<WindowOs, string> = { win: 'Windows', mac: 'macOS', linux: 'Linux' }

export interface SupportIdentityInput {
  signedIn: boolean
  account: Pick<NonNullable<AccountSessionState['account']>, 'userId' | 'username'> | null | undefined
  version: string | undefined
  os: WindowOs
}

/**
 * 客服每次都要先问一轮「账号是什么、用的哪一版、Windows 还是 Mac」，小白常答不上
 * 版本号。这一行让用户原样复制发过去。只写账号名、账号 ID、版本和系统：不写邮箱，
 * 也不写站点名（界面以「当前账号」为主语）。历史账号那边拿不到可靠的数字 ID 时
 * 只写账号名，不拿 0 或 NaN 冒充。
 */
export function buildSupportIdentityLine(input: SupportIdentityInput): string {
  const name = input.signedIn ? input.account?.username.trim() : undefined
  const id = input.signedIn ? input.account?.userId : undefined
  const who = !name ? '未登录'
    : typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? `账号 ${name}（ID ${id}）` : `账号 ${name}`
  const app = input.version ? `星芒AI管理工具 ${input.version}` : '星芒AI管理工具'
  return [who, app, osLabels[input.os]].join(' · ')
}

export function SupportIdentity({ line, onCopy }: { line: string; onCopy: () => void }) {
  return <div className="v2-support-identity" data-testid="support-identity">
    <p>找客服时把这行一起发过去：</p>
    <div><code data-testid="support-identity-line">{line}</code><Button size="sm" onClick={onCopy}>复制</Button></div>
  </div>
}
