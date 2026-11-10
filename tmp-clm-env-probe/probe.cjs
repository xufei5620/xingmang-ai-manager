// 临时：核受限语言模式下改用户 PATH、读 / 清代理变量、清覆盖设置这几条脚本改前改后的结果，核完就删。
'use strict'
const { execFile, spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const phase = process.argv[2] || 'full'
const systemRoot = process.env.SystemRoot || 'C:\\Windows'
const system32 = path.join(systemRoot, 'System32')
const pshome = path.join(system32, 'WindowsPowerShell', 'v1.0')
const powershell = path.join(pshome, 'powershell.exe')
const reg = path.join(system32, 'reg.exe')
const setx = path.join(system32, 'setx.exe')
const listenerExe = path.join(__dirname, 'listener.exe')
const scripts = JSON.parse(fs.readFileSync(path.join(__dirname, 'scripts.json'), 'utf8'))
const profile = process.env.USERPROFILE
const results = []

// Close to trustedCommandEnvironment(): the runner's environment with PSModulePath narrowed to System32.
const baseEnv = { ...process.env, PSModulePath: path.join(pshome, 'Modules'), XINGMANG_REG_EXE: reg, XINGMANG_SETX_EXE: setx, XM_PROBE_HOST: '127.0.0.1' }
delete baseEnv.PSModuleAnalysisCachePath
delete baseEnv.PSMODULEANALYSISCACHEPATH

function hide(text) {
  return String(text).split(profile).join('<PROFILE>')
}

function cut(text, max) {
  const flat = hide(String(text)).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)} ...` : flat
}

function runFile(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer', ...options }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 'error') : 0, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), killed: error?.killed ?? false })
    })
  })
}

// reg export writes UTF-16LE whatever the console code page is, so it reads back what is stored, losslessly.
async function readEnvironmentKey() {
  const file = path.join(os.tmpdir(), `xm-env-${process.pid}-${Date.now()}.reg`)
  const exported = await runFile(reg, ['export', 'HKCU\\Environment', file, '/y'])
  if (exported.code !== 0) throw new Error(`reg export failed: ${exported.stderr}`)
  const text = fs.readFileSync(file).toString('utf16le').replace(/^\uFEFF/, '')
  fs.rmSync(file, { force: true })
  const joined = text.replace(/\\\r?\n\s*/g, '')
  const values = {}
  for (const line of joined.split(/\r?\n/)) {
    const match = /^"((?:[^"\\]|\\.)*)"=(.*)$/.exec(line)
    if (!match) continue
    const name = match[1].replace(/\\(.)/g, '$1')
    const data = match[2]
    let entry
    if (data.startsWith('"')) entry = { kind: 'REG_SZ', value: data.slice(1, -1).replace(/\\(.)/g, '$1') }
    else if (data.startsWith('hex(2):')) {
      const bytes = Buffer.from(data.slice(7).split(',').filter(Boolean).map((byte) => parseInt(byte, 16)))
      entry = { kind: 'REG_EXPAND_SZ', value: bytes.toString('utf16le').replace(/\0+$/, '') }
    } else if (data.startsWith('dword:')) entry = { kind: 'REG_DWORD', value: String(parseInt(data.slice(6), 16)) }
    else entry = { kind: 'other', value: data }
    values[name.toLowerCase()] = entry
  }
  return values
}

async function setValue(name, kind, value) {
  const result = await runFile(reg, ['add', 'HKCU\\Environment', '/v', name, '/t', kind, '/d', value, '/f'])
  if (result.code !== 0) throw new Error(`reg add ${name} failed: ${result.stderr}`)
}

async function deleteValue(name) {
  await runFile(reg, ['delete', 'HKCU\\Environment', '/v', name, '/f'])
}

async function startListener() {
  if (!fs.existsSync(listenerExe)) return null
  const child = spawn(listenerExe, ['30000'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let output = ''
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000)
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8')
      if (output.includes('READY')) { clearTimeout(timer); resolve() }
    })
  })
  return {
    async stop() {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      child.kill()
      return (output.match(/WM_SETTINGCHANGE Environment/g) ?? []).length
    },
  }
}

const wrapper = "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'\nInvoke-Expression $env:XM_CONSTRAINED_SCRIPT"

async function runScript(variant, mode, key, extraEnv) {
  const script = scripts[variant][key]
  const env = { ...baseEnv, ...extraEnv }
  let args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]
  if (mode === 'manual-clm') {
    env.XM_CONSTRAINED_SCRIPT = script
    args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', wrapper]
  }
  const listener = await startListener()
  const startedAt = Date.now()
  const result = await runFile(powershell, args, { env, cwd: pshome })
  const ms = Date.now() - startedAt
  const broadcasts = listener ? await listener.stop() : -1
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return { ...result, ms, broadcasts, last: lines.at(-1) ?? '', lines }
}

function describeValue(values, name) {
  const entry = values[name.toLowerCase()]
  return entry ? `${entry.kind}:${hide(entry.value)}` : 'absent'
}

const target = 'C:\\xmprobe\\\u4e2d\u6587\u76ee\u5f55\\npm'
const base = `C:\\xm-keep;%USERPROFILE%\\xm-ref;C:\\\u4e2d\u6587\u5de5\u5177\\bin;%XM_PROBE_UNDEFINED%\\x`
const profileNpm = `${profile}\\xm-probe-npm`

const cases = [
  ['ensure adds and keeps stored entries', async () => setValue('Path', 'REG_EXPAND_SZ', base), 'ensurePath', { XINGMANG_ADD_PATH: target }, ['Path']],
  ['ensure again finds it', null, 'ensurePath', { XINGMANG_ADD_PATH: target }, ['Path']],
  ['ensure finds another spelling', null, 'ensurePath', { XINGMANG_ADD_PATH: 'C:/xmprobe/\u4e2d\u6587\u76ee\u5f55/x/../npm/' }, ['Path']],
  ['remove takes it out', null, 'removePath', { XINGMANG_REMOVE_PATH: target }, ['Path']],
  ['remove again', null, 'removePath', { XINGMANG_REMOVE_PATH: target }, ['Path']],
  ['ensure finds the %USERPROFILE% form', async () => setValue('Path', 'REG_EXPAND_SZ', '%USERPROFILE%\\xm-probe-npm'), 'ensurePath', { XINGMANG_ADD_PATH: profileNpm }, ['Path']],
  ['remove matches the %USERPROFILE% form', async () => setValue('Path', 'REG_EXPAND_SZ', 'C:\\xm-keep;%USERPROFILE%\\xm-probe-npm'), 'removePath', { XINGMANG_REMOVE_PATH: profileNpm }, ['Path']],
  ['REG_SZ stays REG_SZ on ensure', async () => setValue('Path', 'REG_SZ', 'C:\\xm-keep;C:\\\u4e2d\u6587\u5de5\u5177\\bin'), 'ensurePath', { XINGMANG_ADD_PATH: target }, ['Path']],
  ['REG_SZ stays REG_SZ on remove', null, 'removePath', { XINGMANG_REMOVE_PATH: target }, ['Path']],
  ['ensure without a user Path', async () => deleteValue('Path'), 'ensurePath', { XINGMANG_ADD_PATH: target }, ['Path']],
  ['remove the only entry', null, 'removePath', { XINGMANG_REMOVE_PATH: target }, ['Path']],
  ['read proxy settings', async () => {
    await setValue('HTTP_PROXY', 'REG_SZ', 'http://127.0.0.1:9/\u4e2d\u6587')
    await setValue('ALL_PROXY', 'REG_EXPAND_SZ', 'socks5://%XM_PROBE_HOST%:1080')
    await setValue('HTTPS_PROXY', 'REG_DWORD', '1')
    await setValue('NO_PROXY', 'REG_SZ', 'localhost')
  }, 'readProxy', {}, []],
  ['clear proxy settings', null, 'clearProxy', { XINGMANG_CLEAR_PROXY: 'HTTP_PROXY;ALL_PROXY;BOGUS;HTTPS_PROXY' }, ['HTTP_PROXY', 'ALL_PROXY', 'HTTPS_PROXY', 'NO_PROXY']],
  ['clear provider overrides', async () => {
    await setValue('ANTHROPIC_BASE_URL', 'REG_SZ', 'http://127.0.0.1:9')
    await setValue('OPENAI_BASE_URL', 'REG_EXPAND_SZ', 'http://%XM_PROBE_HOST%:9')
    await setValue('CODEX_HOME', 'REG_DWORD', '1')
  }, 'clearOverrides', { XINGMANG_CLEAR_OVERRIDES: 'ANTHROPIC_BASE_URL;OPENAI_BASE_URL;CODEX_HOME;BOGUS' }, ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'CODEX_HOME']],
]

async function runCases(variant, mode) {
  console.log(`\n######## [${phase}] variant=${variant} mode=${mode}`)
  for (const [label, setup, key, extraEnv, watched] of cases) {
    if (setup) await setup()
    const result = await runScript(variant, mode, key, extraEnv)
    const values = await readEnvironmentKey()
    const state = watched.map((name) => `${name}=${describeValue(values, name)}`).join(' | ')
    const leftover = values.xingmang_environment_refresh || values.xingmang_path_refresh ? ' LEFTOVER-REFRESH-VALUE' : ''
    let output = result.last
    if (key === 'readProxy' && result.code === 0) {
      try {
        const parsed = JSON.parse(result.last)
        output = `json user=${JSON.stringify(parsed.user)} machineKeys=${Object.keys(parsed.machine ?? {}).join(',')} ascii=${/^[\x00-\x7F]*$/.test(result.last)}`
      } catch (error) { output = `not JSON: ${result.last}` }
    }
    if (key === 'clearOverrides') output = result.lines.filter((line) => /^(cleared|machine):/.test(line)).join(' ')
    console.log(`== ${label}: exit=${result.code} ms=${result.ms} broadcasts=${result.broadcasts}${leftover}`)
    console.log(`   out: ${cut(output, 600)}`)
    console.log(`   reg: ${cut(state, 600)}`)
    if (result.code !== 0 || result.stderr.trim()) console.log(`   stderr: ${cut(result.stderr, 900)}`)
    results.push({ variant, mode, label, signature: `${result.code}|${output}|${state}`, broadcasts: result.broadcasts })
  }
}

;(async () => {
  console.log(`phase=${phase} powershell=${powershell} listener=${fs.existsSync(listenerExe)}`)
  fs.mkdirSync(target, { recursive: true })
  const original = await readEnvironmentKey()
  console.log(`original user Path kind=${original.path?.kind ?? 'absent'}`)
  try {
    // What setx does with an empty value, on its own.
    {
      const listener = await startListener()
      const direct = await runFile(setx, ['XINGMANG_SETX_PROBE', '""'], { windowsVerbatimArguments: true, env: baseEnv })
      const broadcasts = listener ? await listener.stop() : -1
      const values = await readEnvironmentKey()
      console.log(`setx empty: exit=${direct.code} out=${cut(direct.stdout, 200)} err=${cut(direct.stderr, 200)} broadcasts=${broadcasts} stored=${describeValue(values, 'XINGMANG_SETX_PROBE')}`)
      await deleteValue('XINGMANG_SETX_PROBE')
    }
    const variants = phase === 'full'
      ? [['old', 'direct'], ['new', 'direct'], ['new', 'manual-clm'], ['old', 'manual-clm']]
      : [['old', 'direct'], ['new', 'direct']]
    for (const [variant, mode] of variants) await runCases(variant, mode)
  } finally {
    for (const name of ['HTTP_PROXY', 'ALL_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'CODEX_HOME', 'XINGMANG_ENVIRONMENT_REFRESH']) {
      if (!original[name.toLowerCase()]) await deleteValue(name)
    }
    if (original.path) await setValue('Path', original.path.kind, original.path.value)
    else await deleteValue('Path')
    const restored = await readEnvironmentKey()
    console.log(`\nuser Path restored: ${JSON.stringify(restored.path) === JSON.stringify(original.path)}`)
  }
  // Each case against the old script in FullLanguage, the behaviour that must not change.
  console.log('\n######## summary (same = matches old FullLanguage)')
  const reference = phase === 'full' ? new Map(results.filter((row) => row.variant === 'old' && row.mode === 'direct').map((row) => [row.label, row])) : null
  for (const row of results) {
    const same = reference ? reference.get(row.label)?.signature === row.signature : 'n/a'
    const digest = crypto.createHash('sha1').update(row.signature).digest('hex').slice(0, 10)
    console.log(`${row.variant}/${row.mode} ${row.label}: digest=${digest} same=${same} broadcasts=${row.broadcasts}`)
  }
})()
