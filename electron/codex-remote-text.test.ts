import { describe, expect, it } from 'vitest'
import {
  approvalOutcomeTitle,
  approvalTitle,
  classifyRemoteTurnFailure,
  conversationListMessage,
  conversationMissingMessage,
  conversationSwitchedFromComputerMessage,
  conversationSwitchedMessage,
  formatApprovalBody,
  formatApprovalText,
  formatFileChangeLine,
  idleClosedMessage,
  normalizePairingAttempt,
  parseRemoteCommand,
  progressCardTitles,
  progressStepMarks,
  progressStopButton,
  progressTextMessage,
  receivedMessage,
  redactRemoteText,
  remoteMessages,
  remoteOpenedMessage,
  remoteDollars,
  remoteRunningForText,
  remoteTookText,
  remoteTurnFailureMessages,
  workspaceAlreadyInUseMessage,
  workspaceListMessage,
  workspaceMissingMessage,
  workspaceSwitchedMessage,
  workspaceUnusableMessage,
  retryMessage,
  splitRemoteText,
  staleMessageNotice,
  statusMessage,
  truncateRemoteText,
  turnSummaryLine,
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
    expect(remoteMessages.help.split('\n')[1]).toBe('可用指令：新对话、对话、停止、状态、文件夹、关闭遥控、重试、帮助。')
    expect(remoteMessages.closedFromPhone).toBe('手机遥控已关闭。如需继续使用，请在电脑端的星芒中重新开启。')
    expect(parseRemoteCommand('先别关闭遥控', false)).toEqual({ kind: 'prompt', text: '先别关闭遥控' })
  })

  // YF-19：手机上看、换电脑上加过的文件夹。只认整条就是「文件夹」或「文件夹 N」。
  it('reads the folder commands only as whole messages', () => {
    expect(parseRemoteCommand('文件夹', false)).toEqual({ kind: 'folders' })
    expect(parseRemoteCommand('/文件夹', true)).toEqual({ kind: 'folders' })
    expect(parseRemoteCommand('文件夹 2', false)).toEqual({ kind: 'use-folder', index: 2 })
    expect(parseRemoteCommand('文件夹2', false)).toEqual({ kind: 'use-folder', index: 2 })
    expect(parseRemoteCommand('文件夹 12', false)).toEqual({ kind: 'use-folder', index: 12 })
    for (const body of ['文件夹 123', '看看文件夹', '文件夹 2 里有什么', '文件夹 -1']) {
      expect(parseRemoteCommand(body, false)).toEqual({ kind: 'prompt', text: body })
    }
  })

  it('lists the folders with the one in use marked, and says how to switch or where to add one', () => {
    expect(workspaceListMessage(['~/projects/shop', '~/projects/blog'], '~/projects/shop'))
      .toBe('1. ~/projects/shop（使用中）\n2. ~/projects/blog\n回复「文件夹 2」即可切换。')
    expect(workspaceListMessage(['~/a', '~/b', '~/c'], '~/a')).toBe('1. ~/a（使用中）\n2. ~/b\n3. ~/c\n回复「文件夹 2」即可切换。')
    expect(workspaceListMessage(['~/a', '~/b'], '~/b')).toBe('1. ~/a\n2. ~/b（使用中）\n回复「文件夹 1」即可切换。')
    expect(workspaceListMessage(['~/projects/shop'], '~/projects/shop'))
      .toBe('1. ~/projects/shop（使用中）\n如需使用其他文件夹，请先在电脑端的「工作文件夹」中添加。')
    expect(workspaceSwitchedMessage('~/projects/blog')).toBe('已切换至 ~/projects/blog，将从新对话开始。')
    expect(workspaceAlreadyInUseMessage('~/projects/shop')).toBe('当前已在使用 ~/projects/shop。')
    expect(workspaceMissingMessage(6)).toBe('不存在第 6 个文件夹，请发送「文件夹」查看列表。')
    expect(workspaceUnusableMessage('~/projects/blog')).toBe('~/projects/blog 当前无法打开，可能已被移动或删除，请在电脑端检查。')
    expect(remoteMessages.workspaceBusy).toBe('Codex 正在处理上一条消息，请待其完成后再切换文件夹。')
  })

  // YF-14：yoyo 2026-11-11「图片改」批的那几句，逐字。
  it('says the approved image words, counting the pictures in the received line', () => {
    expect(remoteMessages.unsupported).toBe('目前仅支持文字和图片，暂不支持语音和文件，请改用文字发送。')
    expect(remoteMessages.imageReceived).toBe('已收到图片。请再发送一条消息说明需要 Codex 执行的任务，图片将一并提交。')
    expect(remoteMessages.imagesFull).toBe('每次最多附带 5 张图片，此图片未接收。')
    expect(remoteMessages.imageTooLarge).toBe('图片过大，未能接收。请发送较小的图片或截取部分内容。')
    expect(remoteMessages.imagePermissionFeishu).toBe('电脑未能获取此图片。请在飞书后台开通「获取单聊、群组消息」权限，并重新发布一个版本。')
    expect(remoteMessages.imageFailed).toBe('电脑未能获取此图片，请重新发送。')
    expect(receivedMessage(0)).toBe('已收到，Codex 开始处理。')
    expect(receivedMessage(2)).toBe('已收到（含 2 张图片），Codex 开始处理。')
  })

  // M03：yoyo 2026-11-18「这些都按照你的推荐」批的那两句（回答没送到手机、补发时说的），逐字。
  it('says the words for an answer sent again after it missed the phone', () => {
    expect(remoteMessages.answerResent).toBe('此前有一条回复未能送达，现补发如下：')
    expect(remoteMessages.retryAfterAnswerResent).toBe('上一条消息已处理完成，回复即为上方内容，因此本次未重新执行。如确需重新执行，请再次发送「重试」。')
  })

  it('tells the phone the remote was switched on, with the folder written like the status reply', () => {
    expect(remoteOpenedMessage('~/projects/demo')).toBe('电脑端已开启手机遥控，现在可以发送消息。工作文件夹：~/projects/demo')
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

  // YR-10：手机输入法切在全角时发的是「１２３４５６」，照样认成配对码。
  it('reads a pairing code typed in full-width digits', () => {
    expect(normalizePairingAttempt('１２３４５６')).toBe('123456')
    expect(normalizePairingAttempt('１２３　４５６')).toBe('123456')
    expect(normalizePairingAttempt('12３4５6')).toBe('123456')
    expect(normalizePairingAttempt('１２３４５６７')).toBeNull()
    expect(normalizePairingAttempt('配对 １２３４５６')).toBeNull()
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
    expect(chunks[2]).toContain('其余部分未发送')
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
    expect(text).toContain('Codex 请求运行命令（第 2 条）')
    expect(text).not.toContain('nonce-of-two')
    expect(text).toContain('npm test')
    expect(text).toContain('在：~/project')
    expect(text).toContain('请回复「同意 2」或「拒绝 2」')
  })

  // yoyo 2026-11-19「改」：Codex 自己说的那句排在命令前头、标「Codex 说明：」，命令原文单起一行「命令原文：」放最后。
  it('puts what Codex says before the raw command and labels the raw command', () => {
    expect(formatApprovalText({ approvalId: '4', nonce: 'nonce-of-four', kind: 'command', summary: 'mkdir 测试', cwd: 'D:\\hi', reason: '在 hi 文件夹里新建「测试」文件夹。' }))
      .toBe('Codex 请求运行命令（第 4 条）：\nCodex 说明：在 hi 文件夹里新建「测试」文件夹。\n在：D:\\hi\n命令原文：\nmkdir 测试\n请回复「同意 4」或「拒绝 4」。')
    expect(formatApprovalBody({ approvalId: '5', nonce: 'nonce-of-five', kind: 'file-change', summary: '新建 a.txt +1 -0 行', reason: '加一个说明文件' }))
      .toBe('Codex 请求修改文件（第 5 条）：\nCodex 说明：加一个说明文件\n新建 a.txt +1 -0 行')
    expect(formatApprovalBody({ approvalId: '6', nonce: 'nonce-of-six', kind: 'network', summary: 'registry.npmjs.org', reason: '装依赖' }))
      .toBe('Codex 请求访问网站（第 6 条）：\nCodex 说明：装依赖\nregistry.npmjs.org')
    expect(formatApprovalBody({ approvalId: '7', nonce: 'nonce-of-seven', kind: 'command', summary: '', reason: '要跑一条命令' }))
      .toBe('Codex 请求运行命令（第 7 条）：\nCodex 说明：要跑一条命令')
  })

  it('titles each kind of approval for what Codex wants to do', () => {
    expect(approvalTitle('command')).toBe('Codex 请求运行命令')
    expect(approvalTitle('terminal-input')).toBe('Codex 请求向运行中的程序输入内容')
    expect(approvalTitle('network')).toBe('Codex 请求访问网站')
    expect(formatApprovalText({ approvalId: '4', nonce: 'nonce-of-four', kind: 'network', summary: 'registry.npmjs.org' }))
      .toBe('Codex 请求访问网站（第 4 条）：\nregistry.npmjs.org\n请回复「同意 4」或「拒绝 4」。')
  })

  it('describes the current state', () => {
    expect(statusMessage({ workspace: '~/p', running: true, pendingApprovals: 0 })).toContain('正在处理')
    expect(statusMessage({ workspace: '~/p', running: true, pendingApprovals: 2 })).toContain('待确认 2 条')
  })

  // YF-18：「状态」最多四行，字照「状态重试」那批一字不差；读不到的那一样整行不写。
  it('adds how long it has run, the plan step, the balance and the idle close to the status reply', () => {
    expect(statusMessage({
      workspace: '~/projects/demo',
      running: true,
      pendingApprovals: 0,
      runningForMs: 6 * 60_000 + 30_000,
      step: '运行测试',
      balanceUsd: 12.4,
      idleCloseHours: 4,
    })).toBe('工作文件夹：~/projects/demo\n当前状态：正在处理，已用时 6 分钟，当前步骤「运行测试」\n余额：$12.40\n4 小时内无新消息将自动关闭')
    expect(statusMessage({ workspace: '~/p', running: true, pendingApprovals: 0, runningForMs: 20_000, step: null, balanceUsd: null, idleCloseHours: null }))
      .toBe('工作文件夹：~/p\n当前状态：正在处理，已用时不到 1 分钟')
    expect(statusMessage({ workspace: '~/p', running: false, pendingApprovals: 0, balanceUsd: 1234.5, idleCloseHours: 12 }))
      .toBe('工作文件夹：~/p\n当前状态：空闲\n余额：$1,234.50\n12 小时内无新消息将自动关闭')
    expect(statusMessage({ workspace: '~/p', running: true, pendingApprovals: 2, runningForMs: 60_000, step: '运行测试' }))
      .toBe('工作文件夹：~/p\n当前状态：待确认 2 条')
  })

  // 余额审查 F7：跟电脑上的 dollars() 同一种写法，欠费的负号写在 $ 前面。
  it('writes a negative balance with the minus sign in front of the dollar sign', () => {
    expect(remoteDollars(-0.03)).toBe('-$0.03')
    expect(remoteDollars(-1234.5)).toBe('-$1,234.50')
    expect(remoteDollars(-0.004)).toBe('$0.00')
    expect(remoteDollars(12.4)).toBe('$12.40')
    expect(statusMessage({ workspace: '~/p', running: false, pendingApprovals: 0, balanceUsd: -0.03, idleCloseHours: null }))
      .toBe('工作文件夹：~/p\n当前状态：空闲\n余额：-$0.03')
  })

  it('writes the running time in minutes and hours', () => {
    expect(remoteRunningForText(59_000)).toBe('已用时不到 1 分钟')
    expect(remoteRunningForText(6 * 60_000)).toBe('已用时 6 分钟')
    expect(remoteRunningForText(65 * 60_000)).toBe('已用时 1 小时 5 分钟')
    expect(remoteRunningForText(120 * 60_000)).toBe('已用时 2 小时')
  })

  // YK-8：处理过的审批卡只留正文，标题换成结果。
  it('titles an answered approval card by its outcome and drops the reply line from its body', () => {
    expect(approvalOutcomeTitle('accepted', '3')).toBe('已同意（第 3 条）')
    expect(approvalOutcomeTitle('declined', '3')).toBe('已拒绝（第 3 条）')
    expect(approvalOutcomeTitle('expired', '3')).toBe('未回复，已自动拒绝（第 3 条）')
    const request = { approvalId: '3', nonce: 'nonce-of-three', kind: 'command' as const, summary: 'npm test', cwd: '~/p' }
    expect(formatApprovalBody(request)).toBe(formatApprovalText(request).split('\n').slice(0, -1).join('\n'))
    expect(formatApprovalBody(request)).not.toContain('请回复「同意')
  })

  // YF-15：yoyo 2026-11-11「进度改」批的字，逐字钉住。
  it('says the approved progress words for the card and the five-minute text', () => {
    expect(progressCardTitles).toEqual({ running: 'Codex 正在处理', done: '已完成', stopped: '已停止', failed: '未完成' })
    expect(progressStepMarks).toEqual({ completed: '✓', inProgress: '▶', pending: '○' })
    expect(progressStopButton).toBe('停止')
    expect(remoteMessages.staleProgressCard).toBe('此卡片属于上一轮，当前任务未停止。如需停止，请发送「停止」。')
    expect(progressTextMessage(5 * 60_000, '运行测试')).toBe('仍在处理，已用时 5 分钟。当前步骤：运行测试')
    expect(progressTextMessage(10 * 60_000, null)).toBe('仍在处理，已用时 10 分钟。')
    expect(progressTextMessage(10 * 60_000, '  \n ')).toBe('仍在处理，已用时 10 分钟。')
    expect(progressTextMessage(5 * 60_000, '先把\n登录页的表单校验全部改成新的写法，再补上对应的测试用例和文档'))
      .toBe('仍在处理，已用时 5 分钟。当前步骤：先把 登录页的表单校验全部改成新的写法，再补上对应的测试用…')
  })

  it('squeezes a long or multi-line plan step onto the status line', () => {
    const reply = statusMessage({ workspace: '~/p', running: true, pendingApprovals: 0, runningForMs: 0, step: '先把\n登录页的表单校验全部改成新的写法，再补上对应的测试用例和文档' })
    expect(reply.split('\n')).toHaveLength(2)
    expect(reply).toContain('当前步骤「先把 登录页的表单校验全部改成新的写法，再补上对应的测试用…」')
  })

  // YF-16：做完以后接在回答后面的那一行。
  it('sums up how long the turn took and which files it changed', () => {
    expect(turnSummaryLine(200_000, ['a.ts', 'b.ts', 'c.css', 'd.md'])).toBe('用时 3 分 20 秒，修改了 4 个文件：a.ts、b.ts、c.css，另有 1 个。')
    expect(turnSummaryLine(45_000, ['a.ts', 'b.ts'])).toBe('用时 45 秒，修改了 2 个文件：a.ts、b.ts。')
    expect(turnSummaryLine(200_000, [])).toBe('用时 3 分 20 秒。')
    expect(turnSummaryLine(65 * 60_000, ['a.ts', 'b.ts', 'c.css'])).toBe('用时 1 小时 5 分，修改了 3 个文件：a.ts、b.ts、c.css。')
  })

  it('writes the time taken in seconds, minutes and hours', () => {
    expect(remoteTookText(200)).toBe('1 秒')
    expect(remoteTookText(45_000)).toBe('45 秒')
    expect(remoteTookText(180_000)).toBe('3 分')
    expect(remoteTookText(3_600_000)).toBe('1 小时')
  })

  // YF-22：「重试」是整条才算的指令，回复只带前 20 个字。
  it('recognises the retry command and previews the first twenty characters', () => {
    expect(parseRemoteCommand('重试', false)).toEqual({ kind: 'retry' })
    expect(parseRemoteCommand('/重试', true)).toEqual({ kind: 'retry' })
    expect(parseRemoteCommand('重试一下刚才那个命令', false)).toEqual({ kind: 'prompt', text: '重试一下刚才那个命令' })
    expect(retryMessage('把登录页的表单校验全部改成新的写法，再补上测试')).toBe('重新发送上一条：「把登录页的表单校验全部改成新的写法，再补…」')
    expect(retryMessage('修一下首页')).toBe('重新发送上一条：「修一下首页」')
    expect(retryMessage('12345678901234567890')).toBe('重新发送上一条：「12345678901234567890」')
    expect(remoteMessages.nothingToRetry).toBe('暂无可重新发送的上一条消息，请直接发送需要执行的任务。')
  })

  it('truncates with an ellipsis', () => {
    expect(truncateRemoteText('abcdef', 4)).toBe('abc…')
    expect(truncateRemoteText('abc', 4)).toBe('abc')
  })

  // D66：手机上收到的这几句，字照 0.2.24 深查决定单一字不差。
  it('says what the phone receives in so many words', () => {
    expect(remoteMessages.codexStarting).toBe('电脑正在启动 Codex，请稍候；如需取消，请发送「停止」。')
    expect(remoteMessages.threadReset).toBe('当前为新对话，Codex 无法读取此前的对话内容。')
    expect(remoteMessages.unbound).toBe('您已在电脑端被解绑，此后发送的消息将不再执行。')
    expect(remoteMessages.idleClosingSoon).toBe('手机遥控将在 10 分钟后自动关闭，如需继续使用，请回复任意消息。')
    // YF-10：自动关那句的时长跟着设置走。
    expect(idleClosedMessage(4)).toBe('4 小时内无新消息，手机遥控已自动关闭。如需继续使用，请在电脑端的星芒中重新开启。')
    expect(idleClosedMessage(12)).toBe('12 小时内无新消息，手机遥控已自动关闭。如需继续使用，请在电脑端的星芒中重新开启。')
    // YR-8：开了「打开星芒时自动打开遥控」时换的两句，字照 yoyo 2026-11-18 批的一字不差。
    expect(idleClosedMessage(4, true)).toBe('4 小时内无新消息，手机遥控已自动关闭。星芒下次打开时将自动连接；如需立即使用，请在电脑端重新开启。')
    expect(idleClosedMessage(12, false)).toBe('12 小时内无新消息，手机遥控已自动关闭。如需继续使用，请在电脑端的星芒中重新开启。')
    expect(remoteMessages.quitting).toBe('电脑端的星芒已退出，遥控已停止。请重新打开星芒并开启遥控后继续使用。')
    expect(remoteMessages.quittingAutoStart).toBe('电脑端的星芒已退出，遥控已停止。星芒再次打开时将自动连接。')
    expect(staleMessageNotice(25)).toBe('此消息发送于 25 分钟前，当时电脑未连接，因此未执行。如仍需执行，请重新发送。')
    expect(remoteTurnFailureMessages).toEqual({
      balance: '余额不足，请充值后重新发送。',
      keyLimit: '本轮未完成：该密钥设置的额度上限已用完，请在「个人中心 › 密钥管理」中调高上限后重试',
      login: '电脑端登录已失效，请在电脑端的星芒中重新登录。',
      context: '当前对话过长，请发送「新对话」重新开始。',
      connection: '电脑暂时无法连接星芒线路，请稍后重新发送。',
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
    expect(formatFileChangeLine({ kind: 'update', path: '~/p/a.ts', added: 12, removed: 3 })).toBe('修改 ~/p/a.ts +12 -3 行')
    expect(formatFileChangeLine({ kind: 'update', path: '~/p/a.ts', movePath: '~/p/b.ts', added: 1, removed: 1 })).toBe('~/p/a.ts 移动到 ~/p/b.ts +1 -1 行')
    // Without the change contents there is nothing to count; without a kind only the path is known.
    expect(formatFileChangeLine({ kind: 'update', path: '~/p/a.ts' })).toBe('修改 ~/p/a.ts')
    expect(formatFileChangeLine({ kind: null, path: '~/p/a.ts' })).toBe('~/p/a.ts')
  })

  // 接对话（yoyo 2026-11-22「接对话字改」）：「对话」「对话 N」只认整条，句子里带着的照常交给 Codex。
  it('reads the conversation commands only as whole messages', () => {
    expect(parseRemoteCommand('对话', false)).toEqual({ kind: 'conversations' })
    expect(parseRemoteCommand('/对话', true)).toEqual({ kind: 'conversations' })
    expect(parseRemoteCommand('对话 2', false)).toEqual({ kind: 'use-conversation', index: 2 })
    expect(parseRemoteCommand('对话12', false)).toEqual({ kind: 'use-conversation', index: 12 })
    expect(parseRemoteCommand('对话 123', false)).toEqual({ kind: 'prompt', text: '对话 123' })
    expect(parseRemoteCommand('看看上次的对话', false)).toEqual({ kind: 'prompt', text: '看看上次的对话' })
  })

  it('writes the conversation replies word for word', () => {
    const at = new Date(2026, 10, 21, 18, 30).getTime()
    const earlier = new Date(2026, 10, 20, 9, 12).getTime()
    expect(conversationListMessage([
      { title: '修复登录页报错', folderName: 'demo', updatedAt: at, current: true },
      { title: '整理接口文档', folderName: 'demo', updatedAt: earlier, current: false },
    ])).toBe([
      '本机最近的 Codex 对话（仅限电脑端已添加的文件夹）：',
      '1. 修复登录页报错（demo，11-21 18:30，当前对话）',
      '2. 整理接口文档（demo，11-20 09:12）',
      '请发送「对话 2」继续该对话。',
    ].join('\n'))
    expect(conversationListMessage([])).toBe('电脑端已添加的文件夹中暂无 Codex 对话，发送消息即可开始新对话。')
    expect(conversationSwitchedMessage('修复登录页报错', null)).toBe([
      '已切换到对话「修复登录页报错」，请发送消息继续。手机遥控的规则（不发送密钥和密码、回复简洁等）将保留在该对话中，在电脑端继续时同样生效。',
      '请勿在电脑端和手机端同时向该对话发送消息。',
    ].join('\n'))
    expect(conversationSwitchedMessage('修复登录页报错', 'default').split('\n')[1]).toBe('该对话原有权限超出手机遥控允许的范围，已调整为「默认」，在电脑端继续时也将保持「默认」。')
    expect(conversationSwitchedMessage('修复登录页报错', 'readOnly').split('\n')[1]).toBe('该对话原有权限超出手机遥控允许的范围，已调整为「只读」，在电脑端继续时也将保持「只读」。')
    expect(conversationMissingMessage(3)).toBe('不存在第 3 个对话，请发送「对话」查看列表。')
    expect(conversationSwitchedFromComputerMessage('修复登录页报错')).toBe('电脑端已切换到对话「修复登录页报错」。')
    expect(remoteMessages.conversationBusy).toBe('Codex 正在处理上一条消息，请待其完成后再切换对话。')
    expect(remoteMessages.conversationAlreadyCurrent).toBe('当前已在该对话中。')
    expect(remoteMessages.conversationResumeFailed).toBe('无法继续该对话，请稍后重试，或发送「新对话」开始新对话。')
    expect(remoteMessages.conversationUnsupported).toBe('当前 Codex 版本暂不支持继续已有对话，请发送「新对话」开始新对话。')
    expect(remoteMessages.conversationNewFromComputer).toBe('电脑端已切换为新对话。')
  })

  it('writes the held-back prompt, folder switch and stale folder list replies word for word', () => {
    expect(remoteMessages.imagesMissedPromptHeld).toBe('图片均未接收成功，本条消息中的文字未发送给 Codex，请重新发送图片和文字。')
    expect(remoteMessages.pendingImagesDroppedOnFolderSwitch).toBe('此前发送、尚未使用的图片已清除，如需使用请重新发送。')
    expect(remoteMessages.retryAfterFolderSwitch).toBe('文件夹已切换，上一条消息不会在新文件夹中重新执行，如需执行请重新发送。')
    expect(remoteMessages.folderListChanged).toBe('电脑端的文件夹列表已变更，请发送「文件夹」重新查看。')
  })
})
