// 星芒AI管理工具随包发布的命令行工具钩子脚本。
//
// Claude Code / Gemini CLI 在一轮开始、结束、出错或停下来等人时起一次这个脚本，把一段
// JSON 从 stdin 递进来；Codex 的 notify 只在一轮做完时起它，JSON 放在最后一个参数里。脚本只做一件事：挑出「哪个工具、发生了哪一类事」写成一个几十字节
// 的小文件，放进星芒自己的数据目录，由星芒主进程读出来再决定弹不弹系统通知。
//
// 刻意的边界：
//   * 不出网、不读任何配置文件、不碰 API Key；
//   * 对话内容、错误原文一概不写：只写从固定名单里挑出来的类型词，名单外的一律记成
//     「其他」。主进程也只认这份名单，不会把 CLI 递来的文字交给通知去显示；
//   * 不往 stdout 打任何东西。Gemini 会把钩子的输出当成提示显示给用户，Claude 的 Stop
//     钩子会把 JSON 输出当成指令；
//   * 永远以 0 退出，永不抛错：少一条通知是小事，让终端里蹦出红字或拦住 AI 不是。
//
// 参数：argv[2] 是工具编号，argv[3] 是事件目录（主进程写配置时给的绝对路径），Codex
// 另有 argv[4]。

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

// Claude 的 Stop 钩子会带上最后一条回复全文，长会话可能几百 KB。只需要开头几个字段，
// 超过上限就放弃这一次，不为一条通知吃内存。
const MAX_INPUT_BYTES = 2 * 1024 * 1024
// stdin 一直不关（上游改了调用方式）也要自己退出，不能挂着一个 node 进程。
const INPUT_TIMEOUT_MS = 5000
const TOOLS = new Set(['claude', 'gemini', 'codex'])

// Claude Code StopFailure 的 error 取值（2.1.282 的钩子说明里列着）。只把能对客户说清楚
// 的几类单独拎出来。2.1.282 对本地假接口实测：401 → authentication_failed、429 → rate_limit、
// 503 → server_error，而 402 + billing_error 报成 unknown——所以「不认识」只能说「查一下」，
// 不能猜成服务出了问题。
const CLAUDE_FAILURE_REASONS = {
  billing_error: 'billing',
  authentication_failed: 'auth',
  oauth_org_not_allowed: 'auth',
  account_on_hold: 'auth',
  verification_required: 'auth',
  rate_limit: 'busy',
  overloaded: 'busy',
  model_not_found: 'model',
  invalid_request: 'model',
  server_error: 'service',
}

// 只有真要人回来点一下的几类才算「在等你」。idle_prompt 是「做完一分钟没人理」，
// 前面已经有「做完了」那一条，再弹就重复了。
const CLAUDE_WAITING_TYPES = new Set([
  'permission_prompt',
  'elicitation_dialog',
  'agent_needs_input',
  'worker_permission_prompt',
])

function readInput() {
  return new Promise((resolve) => {
    let text = ''
    let bytes = 0
    let done = false
    const timer = setTimeout(finish, INPUT_TIMEOUT_MS)
    function finish() {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(text)
    }
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      if (done) return
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > MAX_INPUT_BYTES) {
        text = ''
        finish()
        process.stdin.destroy()
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

// 会话编号只用来把「开始」和「结束」配成一对，算这一轮跑了多久。
function sessionId(payload) {
  const value = payload.session_id
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value) ? value : ''
}

function claudeEvent(payload) {
  switch (payload.hook_event_name) {
    case 'UserPromptSubmit':
      return { event: 'started' }
    case 'Stop':
      return { event: 'finished' }
    case 'StopFailure': {
      const error = typeof payload.error === 'string' ? payload.error : ''
      // 输出太长被截断不是账号的事，Claude 自己会提示，这里不另说。
      if (error === 'max_output_tokens') return null
      const reason = Object.prototype.hasOwnProperty.call(CLAUDE_FAILURE_REASONS, error)
        ? CLAUDE_FAILURE_REASONS[error]
        : 'unknown'
      return { event: 'failed', reason }
    }
    case 'Notification':
      return CLAUDE_WAITING_TYPES.has(payload.notification_type) ? { event: 'waiting' } : null
    default:
      return null
  }
}

// Gemini CLI 0.61.0 的钩子里没有「这一轮因为接口出错结束」的事件，所以只有开始、做完和
// 等你确认三类。
function geminiEvent(payload) {
  switch (payload.hook_event_name) {
    case 'BeforeAgent':
      return { event: 'started' }
    case 'AfterAgent':
      return { event: 'finished' }
    case 'Notification':
      return payload.notification_type === 'ToolPermission' ? { event: 'waiting' } : null
    default:
      return null
  }
}

// Codex 的 turn-id 是 UUIDv7，开头 48 位就是这一轮开始的毫秒时刻（0.156.1 实测：
// turn-id 解出来的时刻比调用 notify 早了整一轮）。notify 没有「开始」事件，靠它算这一轮
// 跑了多久；解不出来就不带，主进程那边当作配不上开始，不提醒。
function uuidV7Time(value, now) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return null
  const at = parseInt(value.slice(0, 8) + value.slice(9, 13), 16)
  return Number.isSafeInteger(at) && at > 0 && at <= now ? at : null
}

// notify 的 type 目前只有 agent-turn-complete 一种；以后加的类型先不认。
function codexEvent(payload, now) {
  if (payload.type !== 'agent-turn-complete') return null
  const startedAt = uuidV7Time(payload['turn-id'], now)
  return startedAt === null ? { event: 'finished' } : { event: 'finished', startedAt }
}

function buildRecord(tool, input, now) {
  if (!TOOLS.has(tool)) return null
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) return null
  let payload = null
  try {
    payload = record(JSON.parse(input))
  } catch {
    return null
  }
  if (!payload) return null
  const found = tool === 'claude' ? claudeEvent(payload)
    : tool === 'gemini' ? geminiEvent(payload)
      : codexEvent(payload, now)
  if (!found) return null
  const session = sessionId(tool === 'codex' ? { session_id: payload['thread-id'] } : payload)
  return { version: 1, tool, ...found, session, at: now }
}

function writeRecord(directory, entry) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) return
  fs.mkdirSync(directory, { recursive: true })
  const name = `${entry.at}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  const temporary = path.join(directory, `${name}.tmp`)
  // 先写临时文件再改名：主进程只读 .json，永远看不到写了一半的文件。
  fs.writeFileSync(temporary, JSON.stringify(entry), { flag: 'wx' })
  fs.renameSync(temporary, path.join(directory, `${name}.json`))
}

async function main() {
  const tool = process.argv[2]
  const directory = process.argv[3]
  // Codex 起 notify 时不给 stdin，等它只会白等到超时。
  const input = tool === 'codex' ? process.argv[4] : await readInput()
  const entry = buildRecord(tool, input, Date.now())
  if (entry) writeRecord(directory, entry)
}

if (require.main === module) {
  main().catch(() => undefined).finally(() => process.exit(0))
}

module.exports = { buildRecord }
