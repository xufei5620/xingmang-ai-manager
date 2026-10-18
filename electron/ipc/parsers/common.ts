// 主窗口业务通道的入参解析（#1070 第 6 步从 ipc.ts 原样搬来，按域分文件，ipc.ts 只管注册）。
// 渲染进程送来的每个参数都当敌意输入（I5）：只认已知字段、限长、拒绝 NUL，出错就抛能直接上屏的中文。
// 别换成 zod / valibot / ajv（AGENTS.md §7）。这个文件是各域共用的几个基础校验。

export function requiredString(value: unknown, label: string, maximum = 4_096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) {
    throw new Error(`${label}格式错误`)
  }
  return value.trim()
}

export function optionalString(value: unknown, label: string, maximum = 4_096): string | undefined {
  if (value === undefined || value === '') return undefined
  return requiredString(value, label, maximum)
}

export function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${label}格式错误`)
  return value
}

export function stringArray(value: unknown, label: string, maximumItems = 128): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error(`${label}格式错误`)
  return value.map((entry) => requiredString(entry, label))
}
