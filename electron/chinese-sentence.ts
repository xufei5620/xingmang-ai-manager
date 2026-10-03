// Imports nothing on purpose: the renderer value-imports this file (registered in
// scripts/verify-renderer-boundary.test.cjs), so it must stay free of Node APIs (I6).

// 路径片段在空白、引号和中文标点、括号处断开。
const pathCharacter = String.raw`[^\s'"：；，。！？、（）「」『』《》【】“”‘’]`
// 第一个斜杠前不许有汉字：「分组GPT-中转/订阅」「请访问https://…充值」斜杠左边的中文是句子本身，
// 中文句子又不带空格，放开的话整句会被当成一条路径去掉。用户名都在斜杠后面（C:\Users\张三\…）。
const pathLead = String.raw`[^\s'"：；，。！？、（）「」『』《》【】“”‘’\u3400-\u9fff]`
// 引号里的那段；或者一条路径，连同紧跟在后面、自己也带斜杠的那几截（用户名带空格时路径断成几截）。
const quotedOrPath = new RegExp(
  String.raw`'[^']*'|"[^"]*"|${pathLead}*[\\/]${pathCharacter}*(?:\s+${pathCharacter}*[\\/]${pathCharacter}*)*`,
  'g',
)

/**
 * 一句报错本身是不是中文。不能只看有没有汉字：Windows 的中文用户名、Mac 上「星芒AI管理工具.app」
 * 都在路径里，「EPERM: operation not permitted, open 'C:\Users\张三\…'」这类英文会被当成中文
 * 整句上屏。所以先去掉引号里的那段和路径，剩下的才是句子本身（第三十批 A）。
 * 路径从第一个斜杠前的那截算起，那截里不许有汉字，「当前账号不可使用分组「GPT-中转/订阅」」
 * 这种中文才不会连同分组名一起被去掉。判不准时宁可当成英文：调用点会换成自己的中文兜底句，
 * 不会把英文端上屏。
 *
 * 渲染层（business-common.tsx 的 speaksChinese，收的是已经把路径换成占位词的句子）和
 * 主进程（updater.ts 更新失败那句，收的是原话）共用这一份，别再各写一个「有没有汉字」。
 */
export function isChineseSentence(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text.replace(quotedOrPath, ' '))
}
