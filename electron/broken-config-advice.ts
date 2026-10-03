/**
 * 读不懂原来的配置文件、星芒没敢动它时给客户的那句（第三十批 C）：哪里坏了、星芒没改、去哪点
 * 「重置为初始状态」。重置先备份、再按所选账号重新生成，是读不懂的配置唯一的出路（config-files.ts
 * 里 reset 那段注释）；以前只说「无法解析，未执行修改」，客户只能反复重试再找客服。
 *
 * 按钮叫法照界面现有的：首页工具行「…」里的「配置」，配置窗口的「使用星芒账号」和最下面「高级」里的
 * 「重置为初始状态」，「备份」页。先选「使用星芒账号」：Claude Code 的 settings.json 坏了时读不出 Key，
 * 配置窗口会把它认成官方账号，直接重置会按官方账号重建。
 *
 * 只用在客户照着能点的地方：保存、写 Key（merge）和 Codex 的技能、外接工具。开机核对型号名单、
 * 星芒画图登记、信任文件夹读不懂时多半只进日志，照旧用原来那句。
 */
export function describeConfigReset(tool: string, problem: string): string {
  return `${problem}，星芒没有改动它。在首页 ${tool} 那一行点「…」里的「配置」，选「使用星芒账号」，再展开最下面的「高级」点「重置为初始状态」：会先备份原来的文件（在「备份」页能找回），再重新生成。`
}

/** 配置文件本身写错了字。TOML 带行号（tomlErrorLocation 的「（第 N 行附近）」），只报行号，不带原文（I13）。 */
export function describeBrokenConfig(tool: string, location = ''): string {
  return describeConfigReset(tool, `${tool} 的配置文件里有写错的地方${location}`)
}
