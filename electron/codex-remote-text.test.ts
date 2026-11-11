import { describe, expect, it } from 'vitest'
import {
  approvalTitle,
  classifyRemoteTurnFailure,
  formatApprovalText,
  formatFileChangeLine,
  normalizePairingAttempt,
  parseRemoteCommand,
  redactRemoteText,
  remoteMessages,
  remoteOpenedMessage,
  remoteTurnFailureMessages,
  splitRemoteText,
  staleMessageNotice,
  statusMessage,
  truncateRemoteText,
} from './codex-remote-text'

describe('codex-remote-text', () => {
  it('recognises the plain commands with or without a slash', () => {
    expect(parseRemoteCommand('新对话', false)).toEqual({ kind: 'new-thread' })
    expect(parseRemoteCommand(' /停止 ', false)).toEqual({ kind: 'stop' })
    expect(parseRemoteCommand('／状态', false)).toEqual({ kind: 'status' })
    expect(parseRemoteCommand('帮助', true)).toEqual({ kind: 'help' })
    expect(parseRemoteCommand('关闭遥控', false)).toEqual({ kind: 'close' })
    expect(parseRemoteCommand('/关闭遥控', true)).toEqual({ kind: 'close' })
  })

  // YF-17：「帮助」里列出手机上能关遥控；只有整条就是「关闭遥控」才算，句子里带着的照常交给 Codex。
  it('lists closing the remote among the commands and does not read it out of a sentence', () => {
    expect(remoteMessages.help.split('\n')[1]).toBe('能用的指令：新对话、停止、状态、关闭遥控、帮助。')
    expect(remoteMessages.closedFromPhone).toBe('手机遥控已关闭。要再用，请在电脑上的星芒里重新打开。')
    expect(parseRemoteCommand('先别关闭遥控', false)).toEqual({ kind: 'prompt', text: '先别关闭遥控' })
  })

  it('tells the phone the remote was switched on, with the folder written like the status reply', () => {
    expect(remoteOpenedMessage('~/projects/demo')).toBe('电脑上的手机遥控打开了，可以发消息了。工作文件夹：~/projects/demo')
  })

  it('treats a sentence that merely contains a command word as a prompt', () => {
    expect(parseRemoteCommand('停止服务器然后重启', false)).toEqual({ kind: 'prompt', text: '停止服务器然后重启' })
  })

  it('reads approve and decline only while something is waiting', () => {
    expect(parseRemoteCommand('同意', true)).toEqual({ kind: 'approval', decision: 'accept' })
    expect(parseRemoteCommand('拒绝 3', true)).toEqual({ kind: 'approval', decision: 'decline', approvalId: '3' })
    expect(parseRemoteCommand('/同意第 02 条', true)).toEqual({ kind: 'approval', decision: 'accept', approvalId: '2' })
    expect(parseRemoteCommand('同意', false)).toEqual({ kind: 'prompt', text: '同意' })
    expect(parseRemoteCommand('同意这个方案吗', true)).toEqual({ kind: 'prompt', text: '同意这个方案吗' })
  })

  it('accepts a pairing code only as the whole message', () => {
    expect(normalizePairingAttempt('123 456')).toBe('123456')
    expect(normalizePairingAttempt('配对 123456')).toBeNull()
    expect(normalizePairingAttempt('1234567')).toBeNull()
  })

  it('redacts named secrets, key shapes and the home directory', () => {
    const text = 'key=abcdef123456 token sk-live0123456789 at /Users/alice/project and Bearer zzzzzzzzzz'
    const redacted = redactRemoteText(text, { secrets: ['abcdef123456'], homeDirectory: '/Users/alice', platform: 'darwin' })
    expect(redacted).not.toContain('abcdef123456')
    expect(redacted).not.toContain('sk-live0123456789')
    expect(redacted).not.toContain('zzzzzzzzzz')
    expect(redacted).not.toContain('/Users/alice')
    expect(redacted).toContain('[已隐去]')
  })

  // Codex can read a website login token or a cloud key ID without asking, and
  // its answer goes to the phone (#1407 P2-4).
  it('hides a JWT and a cloud access key ID before they leave the machine', () => {
    const jwt = [
      Buffer.from('{"alg":"RS256","kid":"fake"}').toString('base64url'),
      Buffer.from('{"sub":"fake-phone-user"}').toString('base64url'),
      'fake-phone-signature',
    ].join('.')
    const keyId = `AKIA${'FAKE0PHONE1TESTX'}`
    const text = `浏览器里存着 ${jwt}\naws_access_key_id = ${keyId}`
    expect(redactRemoteText(text, { secrets: [], homeDirectory: '/home/alice', platform: 'linux' }))
      .toBe('浏览器里存着 [已隐去]\naws_access_key_id = [已隐去]')
  })

  it('ignores secrets too short to redact safely', () => {
    expect(redactRemoteText('a b c', { secrets: ['a'], homeDirectory: '' })).toBe('a b c')
  })

  it('splits long text at line breaks and caps the number of messages', () => {
    const text = Array.from({ length: 40 }, (_, index) => `line ${index} ${'x'.repeat(20)}`).join('\n')
    const chunks = splitRemoteText(text, 200, 3)
    expect(chunks).toHaveLength(3)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(200)
    expect(chunks[0].endsWith('x')).toBe(true)
    expect(chunks[2]).toContain('没有发完')
  })

  it('returns nothing for empty text and one chunk for short text', () => {
    expect(splitRemoteText('  ', 100, 3)).toEqual([])
    expect(splitRemoteText('hi', 100, 3)).toEqual(['hi'])
  })

  it('hard-cuts a line longer than the limit', () => {
    const chunks = splitRemoteText('y'.repeat(250), 100, 5)
    expect(chunks.map((chunk) => chunk.length)).toEqual([100, 100, 50])
  })

  it('formats approvals with the reply words and an optional cwd', () => {
    const text = formatApprovalText({ approvalId: '2', nonce: 'nonce-of-two', kind: 'command', summary: 'npm test', cwd: '~/project' })
    expect(text).toContain('Codex 想运行命令（第 2 条）')
    expect(text).not.toContain('nonce-of-two')
    expect(text).toContain('npm test')
    expect(text).toContain('在：~/project')
    expect(text).toContain('回「同意 2」或「拒绝 2」')
  })

  it('titles each kind of approval for what Codex wants to do', () => {
    expect(approvalTitle('command')).toBe('Codex 想运行命令')
    expect(approvalTitle('terminal-input')).toBe('Codex 想往正在运行的程序里输入')
    expect(approvalTitle('network')).toBe('Codex 想连网站')
    expect(formatApprovalText({ approvalId: '4', nonce: 'nonce-of-four', kind: 'network', summary: 'registry.npmjs.org' }))
      .toBe('Codex 想连网站（第 4 条）：\nregistry.npmjs.org\n回「同意 4」或「拒绝 4」。')
  })

  it('describes the current state', () => {
    expect(statusMessage({ workspace: '~/p', running: true, pendingApprovals: 0 })).toContain('正在处理')
    expect(statusMessage({ workspace: '~/p', running: true, pendingApprovals: 2 })).toContain('等你同意 2 条')
  })

  it('truncates with an ellipsis', () => {
    expect(truncateRemoteText('abcdef', 4)).toBe('abc…')
    expect(truncateRemoteText('abc', 4)).toBe('abc')
  })

  // D66：手机上收到的这几句，字照 0.2.24 深查决定单一字不差。
  it('says what the phone receives in so many words', () => {
    expect(remoteMessages.codexStarting).toBe('电脑正在准备 Codex，稍等一下；想取消就发「停止」。')
    expect(remoteMessages.threadReset).toBe('这是新对话，前面的记不得了。')
    expect(remoteMessages.unbound).toBe('电脑上已经把你解绑了，之后发的消息不会再执行。')
    expect(remoteMessages.idleClosingSoon).toBe('手机遥控 10 分钟后自动关闭，还要用的话随便回一句就行。')
    expect(staleMessageNotice(25)).toBe('这条是 25 分钟前发的，那会儿电脑没连上，没有执行。还要做的话请再发一次。')
    expect(remoteTurnFailureMessages).toEqual({
      balance: '余额不够了，充值后再发一次。',
      keyLimit: '这一轮没做完：这把密钥设置的额度上限用完了，到「个人中心 › 密钥管理」调高上限后再试',
      login: '电脑上的登录失效了，请在电脑上的星芒里重新登录。',
      context: '这段对话太长了，发「新对话」重新开始。',
      connection: '电脑这会儿连不上星芒的线路，过一会儿再发。',
    })
  })

  it('reads whose money or login ran out from what the relay said', () => {
    const http = (status: number) => ({ httpConnectionFailed: { httpStatusCode: status } })
    expect(classifyRemoteTurnFailure('unexpected status 403 Forbidden: {"error":{"code":"insufficient_user_quota"}}', http(403))).toBe('balance')
    // Sub2API, and the status read from the message when codexErrorInfo has none.
    expect(classifyRemoteTurnFailure('unexpected status 403 Forbidden: {"code":"INSUFFICIENT_BALANCE","message":"Insufficient account balance"}', null)).toBe('balance')
    expect(classifyRemoteTurnFailure('unexpected status 403 Forbidden: {"error":{"message":"token quota is not enough","code":"pre_consume_token_quota_failed"}}', http(403))).toBe('keyLimit')
    expect(classifyRemoteTurnFailure('unexpected status 401 Unauthorized: {"error":{"message":"无效的令牌"}}', http(401))).toBe('login')
    expect(classifyRemoteTurnFailure('token refresh failed', 'unauthorized')).toBe('login')
    // A 403 that says nothing about money is not the customer's to fix.
    expect(classifyRemoteTurnFailure('unexpected status 403 Forbidden: Access blocked by Cloudflare', http(403))).toBeNull()
  })

  it('tells a conversation that grew too long and a line that cannot be reached', () => {
    expect(classifyRemoteTurnFailure('Codex ran out of room in the model\'s context window.', 'contextWindowExceeded')).toBe('context')
    expect(classifyRemoteTurnFailure('error sending request', { httpConnectionFailed: { httpStatusCode: null } })).toBe('connection')
    expect(classifyRemoteTurnFailure('stream disconnected', { responseStreamDisconnected: { httpStatusCode: null } })).toBe('connection')
    expect(classifyRemoteTurnFailure('exceeded retry limit, last status: 502', { responseTooManyFailedAttempts: { httpStatusCode: 502 } })).toBe('connection')
    expect(classifyRemoteTurnFailure('We’re currently experiencing high demand', 'serverOverloaded')).toBe('connection')
    // An answer that is not a gateway failure says nothing about the line.
    expect(classifyRemoteTurnFailure('unexpected status 400 Bad Request: model not found', { httpConnectionFailed: { httpStatusCode: 400 } })).toBeNull()
    expect(classifyRemoteTurnFailure('Quota exceeded. Check your plan and billing details.', 'usageLimitExceeded')).toBeNull()
    expect(classifyRemoteTurnFailure('failed to read configuration layers', undefined)).toBeNull()
    expect(classifyRemoteTurnFailure('something', { a: 1, b: 2 })).toBeNull()
  })

  it('puts what happens to a file in front of it and the line counts after it', () => {
    expect(formatFileChangeLine({ kind: 'add', path: '~/p/a.ts', added: 12, removed: 0 })).toBe('新建 ~/p/a.ts +12 -0 行')
    expect(formatFileChangeLine({ kind: 'delete', path: '~/p/a.ts', added: 0, removed: 3 })).toBe('删除 ~/p/a.ts +0 -3 行')
    expect(formatFileChangeLine({ kind: 'update', path: '~/p/a.ts', added: 12, removed: 3 })).toBe('改 ~/p/a.ts +12 -3 行')
    expect(formatFileChangeLine({ kind: 'update', path: '~/p/a.ts', movePath: '~/p/b.ts', added: 1, removed: 1 })).toBe('~/p/a.ts 挪到 ~/p/b.ts +1 -1 行')
    // Without the change contents there is nothing to count; without a kind only the path is known.
    expect(formatFileChangeLine({ kind: 'update', path: '~/p/a.ts' })).toBe('改 ~/p/a.ts')
    expect(formatFileChangeLine({ kind: null, path: '~/p/a.ts' })).toBe('~/p/a.ts')
  })
})
