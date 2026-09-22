// 星芒AI管理工具随包发布的 Claude Code 状态行脚本。
//
// Claude Code 把一段 JSON 从 stdin 递进来，把这个脚本打印的第一行显示在输入框下方，
// 大约每 300 毫秒刷新一次（2.1.278 实测）。所以这里只做三件事：读 stdin、拼一行中文、
// 退出。刻意的边界：
//   * 不出网、不读任何配置文件、不碰 API Key——状态行需要的字段 Claude Code 全递进来了；
//   * 不抛错。任何异常都当成「这一段拼不出来」，少显示一段，绝不让终端里蹦出红字；
//   * 不读 process.argv，不接受外部参数。
// 字段名以 Claude Code 2.1.278 的真实入参为准（见 docs/CLI-VERIFIED-VERSIONS.md）：
// model.display_name / workspace.current_dir / context_window.used_percentage。
// 老版本缺哪个字段就少显示哪一段。

'use strict'

const os = require('node:os')
const path = require('node:path')

// 入参里最长的是 transcript_path 一类的绝对路径，几 KB 顶天。给一个上限，避免上游
// 某天塞进整段会话时把这个每秒跑三次的小进程撑爆内存。
const MAX_INPUT_BYTES = 256 * 1024
// 目录显示得再长也没意义，超了从左边截断。
const MAX_DIRECTORY_LENGTH = 32
// Claude Code 在上下文接近上限时会自动压缩会话，用户看到的是「突然卡一下」。
// 提前给一句，省掉一次客服。
const CONTEXT_WARNING_PERCENT = 80

function readInput() {
  return new Promise((resolve) => {
    let text = ''
    let bytes = 0
    let done = false
    function finish() {
      if (done) return
      done = true
      resolve(text)
    }
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > MAX_INPUT_BYTES) {
        text = ''
        finish()
        return
      }
      text += chunk
    })
    process.stdin.on('end', finish)
    process.stdin.on('error', finish)
  })
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function modelSegment(payload) {
  const model = record(payload.model)
  if (!model) return null
  return text(model.display_name) || text(model.id)
}

/** 家目录显示成 ~，再长就从左边截断——右边（当前目录名）才是用户要找的。 */
function shortenDirectory(directory) {
  let shown = directory
  const home = os.homedir()
  if (home && (shown === home || shown.startsWith(home + path.sep) || shown.startsWith(home + '/'))) {
    shown = '~' + shown.slice(home.length)
  }
  shown = shown.replace(/\\/g, '/')
  if (shown.length > MAX_DIRECTORY_LENGTH) {
    shown = '…' + shown.slice(shown.length - MAX_DIRECTORY_LENGTH)
  }
  return shown
}

function directorySegment(payload) {
  const workspace = record(payload.workspace)
  const directory = (workspace && text(workspace.current_dir)) || text(payload.cwd)
  return directory ? shortenDirectory(directory) : null
}

/**
 * used_percentage 在一次请求都没发过时是 null，这时按 total_input_tokens 自己算一遍
 * （刚开机那次两个都是 0，于是显示 0%）；连 context_window 这一段都没有的老版本
 * 就不显示这一段，不瞎猜。
 */
function contextPercent(payload) {
  const context = record(payload.context_window)
  if (!context) return null
  // 注意 null：Number(null) 是 0，照着写会把「还没发过请求」显示成实打实的 0%，
  // 也会把下面那条自算的路盖掉。
  const reported = finiteNumber(context.used_percentage)
  if (reported !== null) return clampPercent(reported)
  const used = finiteNumber(context.total_input_tokens)
  const size = finiteNumber(context.context_window_size)
  if (used === null || size === null || size <= 0) return null
  return clampPercent((used / size) * 100)
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, Math.round(value)))
}

function contextSegment(payload) {
  const percent = contextPercent(payload)
  if (percent === null) return null
  return percent >= CONTEXT_WARNING_PERCENT
    ? `上下文 ${percent}%（接近上限，会自动压缩）`
    : `上下文 ${percent}%`
}

function formatStatusLine(input) {
  let payload = null
  try {
    payload = record(JSON.parse(input))
  } catch {
    return ''
  }
  if (!payload) return ''
  const segments = []
  for (const build of [modelSegment, directorySegment, contextSegment]) {
    let segment = null
    try {
      segment = build(payload)
    } catch {
      segment = null
    }
    if (segment) segments.push(segment)
  }
  // 单行输出：多出来的换行会把 Claude Code 的输入框整体顶上去。
  return segments.join(' · ').replace(/[\r\n]+/g, ' ')
}

async function main() {
  const input = await readInput()
  const line = formatStatusLine(input)
  if (line) process.stdout.write(line)
}

if (require.main === module) {
  main().catch(() => undefined)
}

module.exports = { formatStatusLine }
