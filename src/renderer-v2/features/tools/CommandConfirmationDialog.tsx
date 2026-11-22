import { useRef } from 'react'
import type { ClaudeCommandConfirmationChoice } from '../../../../electron/ipc-contract'
import { Button, Dialog } from '../../ui'

/**
 * 切回官方账号以后那一问（Fable 复查第一轮 3，2026-11-11 yoyo 批「切回官方问一句」）。老客户的 Claude Code 还是
 * 「不逐条确认就执行」：0.2.24 之前接星芒时补的没有记号，软件分不清是星芒替客户开的还是客户自己设的，所以不替客户改，
 * 问一次。点哪个都算答过，关掉也当「保持当前设置」，以后不再问。键盘焦点落在「保持当前设置」：随手一按回车不改客户的设置。
 */
export function CommandConfirmationDialog({ busy, onAnswer }: { busy: boolean; onAnswer: (choice: ClaudeCommandConfirmationChoice) => void }) {
  const keep = useRef<HTMLButtonElement>(null)
  return <Dialog open title="是否让官方 Claude Code 在执行命令前先确认？" onClose={() => onAnswer('keep')} busy={busy} initialFocus={keep} testId="command-confirmation-question" footer={<>
    <Button ref={keep} testId="command-confirmation-keep" disabled={busy} onClick={() => onAnswer('keep')}>保持当前设置</Button>
    <Button variant="primary" testId="command-confirmation-ask" disabled={busy} onClick={() => onAnswer('ask')}>改为执行前确认</Button>
  </>}>
    <p>本机的 Claude Code 当前设置为「不逐条确认即执行」。该设置可能由星芒此前开启，也可能由您自行设置，软件无法区分。切换回官方账号后该设置仍将保持开启。</p>
    <p>此提示仅出现一次。</p>
  </Dialog>
}

/** 点了「改为执行前确认」以后角落那一句。changed = false：本来就会先问，这次没动配置，也就没有备份。 */
export function commandConfirmationAskedNotice(changed: boolean): string {
  return changed ? '已修改：官方 Claude Code 执行命令前将先征求您的确认，原设置已备份。' : '官方 Claude Code 执行命令前将先征求您的确认。'
}
