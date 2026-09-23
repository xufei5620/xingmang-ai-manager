/**
 * 「检查」页「查看详情」抽屉里那张表。主进程给的 details 是给导出报告和客服看的：
 * 键是英文字段名，值里还有站点地址、状态码、内部代号。原样上屏，小白用户看到的是
 * 一屏 `canElevate: false`，还会看到本不该出现的站点名。
 *
 * 这里只挑用户看得懂、也用得上的几项译成中文；没列在这里的键一律不上屏（完整内容
 * 仍在「导出检查报告」里，客服要的话从那儿拿）。
 */

export interface DiagnosticDetailRow {
  key: string
  label: string
  value: string
}

type DetailValue = boolean | number | string | null

/**
 * 固定名字的键。刻意不列 endpoint / baseUrl（站点地址）、status（状态码）、
 * executionMode / probeFailure（内部代号），也不列 required：「运行权限」那项也带它，
 * 译成什么都说不通，可选不可选结论里已经写了。
 */
const fixedLabels: Readonly<Record<string, string>> = {
  elevated: '以管理员身份运行',
  canElevate: '这个账号能临时获得管理员权限',
  installed: '已安装',
  running: '正在运行',
  path: '位置',
  supported: '在支持范围内',
  exists: '配置文件存在',
  hasApiKey: '已填写 Key',
  matchesRelay: '接的是当前账号',
  model: '模型',
  enabled: '已开启',
  bypass: '跳过命令确认',
  managed: '由本软件写入',
  count: '共几项',
  measured: '查看的磁盘数',
  relocated: '被搬走的文件夹数',
  clockSkewMinutes: '本机时间相差（分钟）',
  workspace: '项目文件夹',
  reason: '原因',
}

/** 带序号的键（file1、disk2……），序号原样接在中文名后面。 */
const numberedLabels: Readonly<Record<string, string>> = {
  file: '文件',
  variable: '设置项',
  disk: '磁盘',
  path: '位置',
  folder: '文件夹',
  from: '原来的位置',
  to: '现在的位置',
}

function labelFor(key: string): string | null {
  const fixed = fixedLabels[key]
  if (fixed) return fixed
  const numbered = /^([a-zA-Z]+)(\d+)$/.exec(key)
  if (!numbered) return null
  const base = numberedLabels[numbered[1]]
  return base ? `${base} ${numbered[2]}` : null
}

function valueFor(key: string, value: DetailValue): string | null {
  // null 是「这台电脑上没这回事或没问出来」，列一行「没查到」只会让人以为出了错。
  if (value === null) return null
  if (typeof value === 'boolean') return value ? '是' : '否'
  const text = String(value)
  // 网络那一项的 reason 是 'intercepted' 这类代号，中文原因已经写在结论里了。
  if (key === 'reason' && /^[\w-]+$/.test(text)) return null
  // 值里带网址的一律不上屏：界面上不出现站点地址。
  if (/\bhttps?:\/\//i.test(text)) return null
  return text
}

export function diagnosticDetailRows(
  details: Readonly<Record<string, DetailValue>> | undefined,
): DiagnosticDetailRow[] {
  const rows: DiagnosticDetailRow[] = []
  for (const [key, raw] of Object.entries(details ?? {})) {
    const label = labelFor(key)
    if (!label) continue
    const value = valueFor(key, raw)
    if (value === null) continue
    rows.push({ key, label, value })
  }
  return rows
}
