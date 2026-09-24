// 终端里的 AI 工具退出后打给用户看的两行中文（Windows 与 macOS 共用一份）。
// 各家 CLI 的退出码含义不一，非零只说「可能是意外退出」，不下结论。
export const cliExitHintLines = {
  normal: ['AI 工具已经退出了。', '想接着聊，回星芒点「接着聊」；这个窗口可以直接关掉。'],
  unexpected: ['AI 工具可能是意外退出了。', '回星芒点「检查」看看；需要找客服的话，先别关这个窗口。'],
} as const
