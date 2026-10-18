import { ChevronDown } from 'lucide-react'
import type { ActiveProviderId } from '../../../../electron/catalog'
import { Menu, type MenuItem, type MenuNote } from '../../ui'
import { officialAccountNames } from '../../registry/tools'
import { spacedName } from './model'

// 首页卡片左下角的来源牌和它点开的「用哪个账号」菜单。命令行工具（含 Codex 桌面端）和 Claude Desktop
// 两张卡原来各抄一份字，改个说法得记着改两处（#1073 评论第 2 条），现在两处都从这里拿。

/** 来源牌上写的字。 */
export const sourceChipLabels = { account: '当前账号', official: '官方账号', manual: '自己的密钥' } as const

export interface SourceMenuChoice {
  checked: boolean
  /** 缺省 = 能点。 */
  disabled?: boolean
  onSelect(): void
}

export interface SourceMenuInput {
  /** 卡片的工具 id，拼进每一项的 testId。 */
  tool: string
  /** 官方账号那一项写哪家的账号名；Codex 还要多一句和桌面端共用配置。 */
  provider: ActiveProviderId
  account: SourceMenuChoice
  /** signedIn：已经登录的官方账号写邮箱和套餐；缺省 = 写怎么登录。 */
  official: SourceMenuChoice & { signedIn?: string | null }
  /** 「自己填写密钥」只有命令行工具有；缺省 = 不给这一项。 */
  manual?: SourceMenuChoice
  more: { disabled?: boolean; onSelect(): void }
}

export function buildSourceMenuItems(input: SourceMenuInput): Array<MenuItem | MenuNote | 'divider'> {
  const { tool, account, official, manual, more } = input
  return [
    { label: sourceChipLabels.account, description: '按用量从当前账号扣费', checked: account.checked, disabled: account.disabled,
      testId: `tool-${tool}-source-account`, onSelect: account.onSelect },
    { label: officialAccountNames[input.provider] ?? sourceChipLabels.official, description: official.signedIn || '用你自己的官方订阅登录',
      checked: official.checked, disabled: official.disabled, testId: `tool-${tool}-source-official`, onSelect: official.onSelect },
    ...(manual ? [{ label: '自己填写密钥', description: '粘贴你在星芒创建的密钥', checked: manual.checked, disabled: manual.disabled,
      testId: `tool-${tool}-source-manual`, onSelect: manual.onSelect }] : []),
    ...(input.provider === 'codex' ? [{ note: 'Codex CLI 和 Codex 桌面端共用这份配置' }] : []),
    'divider',
    { label: '更多配置…', disabled: more.disabled, onSelect: more.onSelect },
  ]
}

/** 来源牌本身：写着现在用的是哪个，点开是上面那份菜单。name 是工具名，空格这里补。 */
export function SourceMenu({ tool, name, chip, items }: { tool: string; name: string; chip: string; items: Array<MenuItem | MenuNote | 'divider'> }) {
  const label = `${spacedName(name)}现在用${chip}，点击切换`
  return <Menu align="start" heading="用哪个账号使用 AI" label={label} testId={`tool-${tool}-source-menu`} items={items}
    anchor={<button type="button" className="v2-source-chip" data-testid={`tool-${tool}-source`} aria-label={label}>
      <span>{chip}</span><ChevronDown size={13} aria-hidden="true" /></button>} />
}
