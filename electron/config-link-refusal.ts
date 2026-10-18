// Imports nothing on purpose: the renderer value-imports this file to recognise
// the sentence below (registered in scripts/verify-renderer-boundary.test.cjs),
// so it must stay free of Node APIs (I6).

/**
 * 工具的配置文件是个链接时（dotfiles 工具做的符号链接、硬链接），写配置前的校验（I8）照旧拒绝，
 * 这里只管说法（#1100 第2条）。以前客户看到的是「必须是单链接普通文件」「包含符号链接」，或者被认成
 * 「文件夹被搬到了别的位置」，都不知道该做什么。渲染层认这一段配「配置文件是个链接」，两边用这一个常量。
 */
export const configLinkRefusalMarker = '为了安全，星芒不往链接里写'

/**
 * location 是给客户看的位置：用户文件夹里的写「用户文件夹里的 .claude/settings.json」（Windows 用反斜杠），
 * 别处的只写文件名。这几种写法都躲得过界面把本机路径换成占位词的那道脱敏，能原样显示出来。
 */
export function configLinkRefusalMessage(location: string, kind: 'file' | 'folder'): string {
  return kind === 'folder'
    ? `${location} 这个文件夹是个链接。${configLinkRefusalMarker}，原来的设置没有动。把它换成普通文件夹后再试。`
    : `${location} 是个链接。${configLinkRefusalMarker}，原来的设置没有动。把它换成普通文件后再试。`
}

/**
 * 从包了几层的报错里（「改用当前账号没有完成：……已恢复到切换前的配置。」）取回上面那一整句；没有就是 null。
 * 位置里不会有全角冒号，所以从标志前最近的一个「：」后面算起。
 */
export function configLinkRefusalIn(message: string): string | null {
  const at = message.indexOf(configLinkRefusalMarker)
  if (at < 0) return null
  const start = message.lastIndexOf('：', at) + 1
  const end = message.indexOf('后再试。', at)
  return end < 0 ? message.slice(start) : message.slice(start, end + '后再试。'.length)
}
