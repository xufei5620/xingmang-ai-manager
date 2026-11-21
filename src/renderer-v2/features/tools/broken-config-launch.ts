/**
 * 打开工具时碰上工具自己都读不了的配置文件（model.ts 的 brokenConfigOf）。以前跟「还没连上账号」
 * 混在一起，一律说「请先确认账号连接，再打开工具。」还顺手弹出配置窗口；客户在里面怎么点都修不好
 * （2026-11-18 客户 config.toml 被 PowerShell 5.1 按 GBK 读、UTF-8 写回，中文用户名吃掉了反斜杠）。
 *
 * 句子取首页那行小字（brokenConfigDetails）的前半句，后半句「修之前会先备份」只在有「立即修复」的
 * 地方说：错误框里的说明和按钮由 operation-error 的 configBroken 那一类给；引导、记录页没有那颗
 * 按钮，只上这一句。不放进 model.ts，是因为 operation-error 要按原话认它，而 model.ts 经
 * business-common 又引了 operation-error。这个文件也不许 import model.ts（连 import type 也不行）：
 * 主进程测试会引 operation-error，tsconfig.electron.test.json 不认 .tsx，顺着 model.ts 摸到
 * business-common.tsx 就编译不过。所以 BrokenConfig 定在这里，model.ts 反过来从这里取。
 */
export type BrokenConfig = 'codexConfig' | 'codexAuth' | 'claudeSettings'

export const brokenConfigLaunchMessages: Record<BrokenConfig, string> = {
  codexConfig: 'Codex 读不了这份配置，打开会报错。',
  codexAuth: 'Codex 读不了登录信息，打开会要你重新登录。',
  claudeSettings: 'Claude Code 读不了这份配置，打开会报错。',
}

const launchMessages: ReadonlySet<string> = new Set(Object.values(brokenConfigLaunchMessages))

export function isBrokenConfigLaunchMessage(message: string): boolean {
  return launchMessages.has(message.trim())
}
