// @renderer-importable: bundled into the renderer, so no Node or Electron here or in what it value-imports (I6).

// 网络服务型外接工具的请求头（多半是 `Authorization: Bearer …` 这种带密钥的）。界面在粘贴、填表时先用它
// 挑出格式不对的，主进程收到 IPC 以后、拼命令和写 config.toml 之前再用同一份过一遍（I5）。

/**
 * An HTTP token (RFC 9110 §5.6.2) that may not start with '-'. Claude Code takes
 * `--header "<name>: <value>"` as a variadic option, so an argument that began
 * with a dash would be read as a flag of the CLI itself instead of a header.
 */
export const mcpHttpHeaderNamePattern = /^[A-Za-z0-9][A-Za-z0-9!#$%&'*+.^_`|~-]*$/

export const mcpHttpHeaderLimits = { count: 64, nameLength: 256, valueLength: 8_192 } as const

/**
 * 校验并整理成 [名称, 值]，值去掉首尾空白。缺省或空对象回空数组（= 不带请求头，旧行为）。
 * 值里不许有换行和 NUL：一条请求头里夹换行就能在 HTTP 请求里多塞出一行。
 */
export function mcpHttpHeaderEntries(headers: unknown): Array<[string, string]> {
  if (headers === undefined || headers === null) return []
  if (typeof headers !== 'object' || Array.isArray(headers)) throw new Error('MCP 请求头格式错误')
  const entries = Object.entries(headers)
  if (entries.length > mcpHttpHeaderLimits.count) throw new Error('MCP 请求头数量过多')
  return entries.map(([name, value]) => {
    if (name.length > mcpHttpHeaderLimits.nameLength || !mcpHttpHeaderNamePattern.test(name)) {
      throw new Error('MCP 请求头格式错误')
    }
    const trimmed = typeof value === 'string' ? value.trim() : ''
    if (!trimmed || trimmed.length > mcpHttpHeaderLimits.valueLength || /[\r\n\0]/.test(trimmed)) {
      throw new Error('MCP 请求头格式错误')
    }
    return [name, trimmed]
  })
}
