// 记录详情里每一轮 AI 回复下面那行灰字（总单 Q4 C2）：这一轮跑了几条命令、改了几个文件、几步没成功。
// 主进程只交来程序名和文件名，这里只管把它们说成一句话。
import type { V2Bridge } from '../../types'

type SessionDetail = Awaited<ReturnType<V2Bridge['getProviderSessionDetail']>>
export type TurnActivity = NonNullable<SessionDetail['messages'][number]['activity']>

/** 灰字那一行。三样里只说有的那几样；一样都没有时主进程根本不会挂上来。 */
export function turnActivitySummary(activity: TurnActivity): string {
  const parts = [
    activity.commands > 0 ? `跑了 ${activity.commands} 条命令` : '',
    activity.fileCount > 0 ? `改了 ${activity.fileCount} 个文件` : '',
    activity.failedSteps > 0 ? `有 ${activity.failedSteps} 步没成功` : '',
  ].filter(Boolean)
  return `这一轮：${parts.join('，')}`
}

/** 点开后「改过的文件」那一行。主进程最多交 50 个名字，多出来的说一句一共几个。 */
export function turnActivityFiles(activity: TurnActivity): string {
  const listed = activity.files.join('、')
  return activity.fileCount > activity.files.length ? `${listed}…等 ${activity.fileCount} 个` : listed
}

/** 有没有可以点开看的名字；只有「几步没成功」或者读不出命令名时，那一行就不做成能点开的。 */
export function turnActivityHasNames(activity: TurnActivity): boolean {
  return activity.files.length > 0 || activity.commandNames.length > 0
}
