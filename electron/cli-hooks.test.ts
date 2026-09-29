import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLI_HOOK_SCRIPT_NAME,
  applyClaudeCliHooks,
  applyCodexCliNotify,
  applyGeminiCliHooks,
  buildCliHookInvocation,
  geminiCliHookCommand,
  isManagedCliHook,
  removeClaudeCliHooks,
  removeCodexCliNotify,
  removeGeminiCliHooks,
  resolveCliHookScriptPath,
  type CliHookInvocation,
} from './cli-hooks'

const temporaryDirectories: string[] = []
const bundledScript = path.resolve(__dirname, '..', 'bundled-catalog', 'cli-hooks', CLI_HOOK_SCRIPT_NAME)

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-cli-hooks-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  while (temporaryDirectories.length) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true })
  }
})

const posixInvocation: CliHookInvocation = {
  nodeExecutable: '/managed/node/bin/node',
  scriptPath: '/opt/app/resources/bundled-catalog/cli-hooks/xingmang-hook.cjs',
  eventsDirectory: '/home/me/.config/xingmang-ai-manager/cli-events',
  platform: 'linux',
}

describe('resolveCliHookScriptPath', () => {
  it('prefers the packaged resources copy and falls back to the checkout', () => {
    const resourcesPath = temporaryDirectory()
    const appPath = temporaryDirectory()
    for (const root of [resourcesPath, appPath]) {
      fs.mkdirSync(path.join(root, 'bundled-catalog', 'cli-hooks'), { recursive: true })
      fs.writeFileSync(path.join(root, 'bundled-catalog', 'cli-hooks', CLI_HOOK_SCRIPT_NAME), '')
    }
    expect(resolveCliHookScriptPath(appPath, { packaged: true, resourcesPath }))
      .toBe(path.join(resourcesPath, 'bundled-catalog', 'cli-hooks', CLI_HOOK_SCRIPT_NAME))
    expect(resolveCliHookScriptPath(appPath)).toBe(path.join(appPath, 'bundled-catalog', 'cli-hooks', CLI_HOOK_SCRIPT_NAME))
    expect(resolveCliHookScriptPath(temporaryDirectory())).toBeNull()
  })

  it('ships the script in the repository', () => {
    expect(fs.existsSync(bundledScript)).toBe(true)
  })
})

describe('buildCliHookInvocation', () => {
  it('accepts absolute paths with spaces, Chinese characters and apostrophes', () => {
    const invocation = buildCliHookInvocation("/Users/小明 O'Neil/node", '/Applications/星芒 AI.app/x.cjs', '/tmp/events', 'darwin')
    expect(invocation).toEqual({
      nodeExecutable: "/Users/小明 O'Neil/node",
      scriptPath: '/Applications/星芒 AI.app/x.cjs',
      eventsDirectory: '/tmp/events',
      platform: 'darwin',
    })
  })

  it('refuses relative paths and anything a shell would expand', () => {
    expect(buildCliHookInvocation('node', '/a.cjs', '/events')).toBeNull()
    expect(buildCliHookInvocation('/node', '/a.cjs', '')).toBeNull()
    for (const bad of ['/a"b', '/a$GEMINI_CWD', '/a`id`', '/a%PATH%', '/a\nb']) {
      expect(buildCliHookInvocation('/node', '/a.cjs', bad)).toBeNull()
    }
  })
})

describe('geminiCliHookCommand', () => {
  it('quotes every path for bash outside Windows', () => {
    const command = geminiCliHookCommand({ ...posixInvocation, nodeExecutable: "/Users/o'neil/node" })
    expect(command).toBe(
      `'/Users/o'\\''neil/node' '/opt/app/resources/bundled-catalog/cli-hooks/xingmang-hook.cjs' gemini '/home/me/.config/xingmang-ai-manager/cli-events'`,
    )
  })

  it('calls the node binary through the PowerShell call operator on Windows', () => {
    const command = geminiCliHookCommand({
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      scriptPath: 'C:\\Program Files\\星芒\\resources\\bundled-catalog\\cli-hooks\\xingmang-hook.cjs',
      eventsDirectory: 'C:\\Users\\O’Brien\\AppData\\Roaming\\xingmang-ai-manager\\cli-events',
      platform: 'win32',
    })
    expect(command).toBe(
      "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Program Files\\星芒\\resources\\bundled-catalog\\cli-hooks\\xingmang-hook.cjs' gemini 'C:\\Users\\O’’Brien\\AppData\\Roaming\\xingmang-ai-manager\\cli-events'",
    )
  })

  it.runIf(process.platform !== 'win32')('runs as a real bash command and hands stdin to the script', () => {
    const events = path.join(temporaryDirectory(), "it's events")
    const command = geminiCliHookCommand({
      nodeExecutable: process.execPath,
      scriptPath: bundledScript,
      eventsDirectory: events,
      platform: process.platform,
    })
    execFileSync('bash', ['-c', command], {
      input: JSON.stringify({ hook_event_name: 'AfterAgent', session_id: 's1', prompt: 'secret prompt' }),
    })
    const files = fs.readdirSync(events)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^\d+-\d+-[0-9a-f]{8}\.json$/)
    const record = JSON.parse(fs.readFileSync(path.join(events, files[0]), 'utf8'))
    expect(record).toMatchObject({ version: 1, tool: 'gemini', event: 'finished', session: 's1' })
    expect(JSON.stringify(record)).not.toContain('secret prompt')
  })
})

describe('Claude Code hooks', () => {
  it('adds one exec-form async hook per event without going through a shell', () => {
    const settings: Record<string, unknown> = {}
    applyClaudeCliHooks(settings, posixInvocation)
    const hooks = settings.hooks as Record<string, Array<{ hooks: unknown[] }>>
    expect(Object.keys(hooks).sort()).toEqual(['Notification', 'Stop', 'StopFailure', 'UserPromptSubmit'])
    expect(hooks.StopFailure).toEqual([{
      hooks: [{
        type: 'command',
        command: '/managed/node/bin/node',
        args: [posixInvocation.scriptPath, 'claude', posixInvocation.eventsDirectory],
        async: true,
        timeout: 10,
      }],
    }])
  })

  it('keeps the user hooks, replaces our stale entry and never duplicates it', () => {
    const own = { matcher: '', hooks: [{ type: 'command', command: 'afplay /System/Library/Sounds/Glass.aiff' }] }
    const stale = { hooks: [{ type: 'command', command: '/old/node', args: ['/old/xingmang-hook.cjs', 'claude', '/old'] }] }
    const mixed = { hooks: [{ type: 'command', command: 'say done' }, { type: 'command', command: '"/old/node" "/old/xingmang-hook.cjs"' }] }
    const settings: Record<string, unknown> = { hooks: { Stop: [own, stale, mixed], PreToolUse: [own] } }
    applyClaudeCliHooks(settings, posixInvocation)
    applyClaudeCliHooks(settings, posixInvocation)
    const hooks = settings.hooks as Record<string, Array<{ hooks: unknown[] }>>
    expect(hooks.PreToolUse).toEqual([own])
    expect(hooks.Stop).toHaveLength(3)
    expect(hooks.Stop[0]).toEqual(own)
    expect(hooks.Stop[1]).toEqual({ hooks: [{ type: 'command', command: 'say done' }] })
    expect(isManagedCliHook(hooks.Stop[2].hooks[0])).toBe(true)
  })

  it('leaves a hooks value it does not understand alone', () => {
    const settings: Record<string, unknown> = { hooks: 'broken', other: 1 }
    applyClaudeCliHooks(settings, posixInvocation)
    expect(settings.hooks).toBe('broken')
    const perEvent: Record<string, unknown> = { hooks: { Stop: { not: 'an array' } } }
    applyClaudeCliHooks(perEvent, posixInvocation)
    expect((perEvent.hooks as Record<string, unknown>).Stop).toEqual({ not: 'an array' })
  })

  it('removes only our hooks and drops the field once it is empty', () => {
    const own = { hooks: [{ type: 'command', command: 'say done' }] }
    const settings: Record<string, unknown> = { hooks: { Stop: [own] } }
    applyClaudeCliHooks(settings, posixInvocation)
    removeClaudeCliHooks(settings)
    expect(settings.hooks).toEqual({ Stop: [own] })
    const ours: Record<string, unknown> = {}
    applyClaudeCliHooks(ours, posixInvocation)
    removeClaudeCliHooks(ours)
    expect('hooks' in ours).toBe(false)
  })
})

describe('Gemini CLI hooks', () => {
  it('adds a named shell hook for start, finish and permission prompts and removes it again', () => {
    const settings: Record<string, unknown> = { hooks: { BeforeTool: [{ hooks: [{ type: 'command', command: 'lint' }] }] } }
    applyGeminiCliHooks(settings, posixInvocation)
    const hooks = settings.hooks as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>
    expect(Object.keys(hooks).sort()).toEqual(['AfterAgent', 'BeforeAgent', 'BeforeTool', 'Notification'])
    expect(hooks.AfterAgent[0].hooks[0]).toEqual({
      name: 'xingmang-notify',
      type: 'command',
      command: geminiCliHookCommand(posixInvocation),
      timeout: 10000,
    })
    removeGeminiCliHooks(settings)
    expect(settings.hooks).toEqual({ BeforeTool: [{ hooks: [{ type: 'command', command: 'lint' }] }] })
  })
})

describe('Codex notify', () => {
  it('sets our argv when notify is unset or ours, and leaves a user command alone', () => {
    const expected = [posixInvocation.nodeExecutable, posixInvocation.scriptPath, 'codex', posixInvocation.eventsDirectory]
    const fresh: Record<string, unknown> = {}
    applyCodexCliNotify(fresh, posixInvocation)
    expect(fresh.notify).toEqual(expected)
    const stale: Record<string, unknown> = { notify: ['/old/node', '/old/bundled-catalog/cli-hooks/xingmang-hook.cjs', 'codex', '/old/events'] }
    applyCodexCliNotify(stale, posixInvocation)
    expect(stale.notify).toEqual(expected)
    const user: Record<string, unknown> = { notify: ['notify-send', 'Codex'] }
    applyCodexCliNotify(user, posixInvocation)
    removeCodexCliNotify(user)
    expect(user.notify).toEqual(['notify-send', 'Codex'])
    removeCodexCliNotify(fresh)
    expect('notify' in fresh).toBe(false)
  })
})

describe('bundled hook script', () => {
  const { buildRecord } = createRequire(__filename)(bundledScript) as {
    buildRecord: (tool: string, input: string, now: number) => Record<string, unknown> | null
  }

  it('keeps only the event type from Claude Code payloads', () => {
    const failure = buildRecord('claude', JSON.stringify({
      hook_event_name: 'StopFailure',
      session_id: 'abc-1',
      error: 'billing_error',
      error_details: 'Your credit balance is too low',
      last_assistant_message: 'private text',
    }), 1000)
    expect(failure).toEqual({ version: 1, tool: 'claude', event: 'failed', reason: 'billing', session: 'abc-1', at: 1000 })
    expect(buildRecord('claude', JSON.stringify({ hook_event_name: 'StopFailure', error: 'unknown' }), 1)?.reason).toBe('unknown')
    expect(buildRecord('claude', JSON.stringify({ hook_event_name: 'StopFailure', error: 'server_error' }), 1)?.reason).toBe('service')
    expect(buildRecord('claude', JSON.stringify({ hook_event_name: 'StopFailure', error: 'max_output_tokens' }), 1)).toBeNull()
    expect(buildRecord('claude', JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }), 1)?.event).toBe('waiting')
    expect(buildRecord('claude', JSON.stringify({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }), 1)).toBeNull()
    expect(buildRecord('claude', JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: '../x' }), 1)).toMatchObject({ event: 'started', session: '' })
  })

  it('maps Gemini events and ignores unknown tools or malformed input', () => {
    expect(buildRecord('gemini', JSON.stringify({ hook_event_name: 'BeforeAgent' }), 1)?.event).toBe('started')
    expect(buildRecord('gemini', JSON.stringify({ hook_event_name: 'Notification', notification_type: 'ToolPermission' }), 1)?.event).toBe('waiting')
    expect(buildRecord('grok', JSON.stringify({ hook_event_name: 'Stop' }), 1)).toBeNull()
    expect(buildRecord('claude', 'not json', 1)).toBeNull()
    expect(buildRecord('claude', '[]', 1)).toBeNull()
  })

  it('turns a Codex turn-complete payload into a finished record with the turn start time', () => {
    // Real payload shape from Codex 0.156.1; the ids are UUIDv7.
    const payload = {
      type: 'agent-turn-complete',
      'thread-id': '01a0eb04-9389-7470-bb18-abf69dcd9556',
      'turn-id': '01a0eb04-93a2-7470-8b1f-548fbd2cbc24',
      cwd: '/work',
      client: 'codex_exec',
      'input-messages': ['private prompt'],
      'last-assistant-message': 'private text',
    }
    const startedAt = 0x01a0eb0493a2
    expect(buildRecord('codex', JSON.stringify(payload), startedAt + 90_000)).toEqual({
      version: 1,
      tool: 'codex',
      event: 'finished',
      startedAt,
      session: '01a0eb04-9389-7470-bb18-abf69dcd9556',
      at: startedAt + 90_000,
    })
    // A turn id from the future or not a UUIDv7 gives no start time.
    expect(buildRecord('codex', JSON.stringify(payload), startedAt - 1)).not.toHaveProperty('startedAt')
    expect(buildRecord('codex', JSON.stringify({ ...payload, 'turn-id': 'turn-1' }), startedAt)).not.toHaveProperty('startedAt')
    expect(buildRecord('codex', JSON.stringify({ ...payload, type: 'approval-requested' }), startedAt)).toBeNull()
  })

  it('reads the Codex payload from its last argument without waiting for stdin', () => {
    const directory = temporaryDirectory()
    const payload = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 't1', 'turn-id': 'x' })
    execFileSync(process.execPath, [bundledScript, 'codex', directory, payload], { timeout: 3000 })
    const [name] = fs.readdirSync(directory)
    expect(name).toMatch(/\.json$/)
    expect(JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))).toMatchObject({ tool: 'codex', event: 'finished', session: 't1' })
  })

  it('prints nothing and exits cleanly even when it cannot write', () => {
    const output = execFileSync(process.execPath, [bundledScript, 'claude', 'relative/dir'], {
      input: JSON.stringify({ hook_event_name: 'Stop' }),
    })
    expect(output.toString()).toBe('')
  })
})
