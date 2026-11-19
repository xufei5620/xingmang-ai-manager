// 临时：用真 Codex 打线路2，核换模型 / 插话 / 停止 / 子代理会不会报错（2026-11-19 服务端转发层上线后），核完就删。
// Inputs: XM_KEY (never printed), BASE_URL, CODEX_BINS="label=/path/to/codex,...", CATALOG=path to models.json.
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const readline = require('readline')

const key = process.env.XM_KEY || ''
const baseUrl = process.env.BASE_URL || 'https://xm-direct.solov.cc/v1'
const catalog = process.env.CATALOG
const only = (process.env.ONLY || '').split(',').filter(Boolean)
if (!key) { console.log('XM_KEY missing'); process.exit(2) }
function redact(text) {
  let out = String(text)
  if (key) out = out.split(key).join('***')
  return out.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
}
const t0 = Date.now()
function log(...a) { console.log(redact(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ` + a.join(' '))) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const OLD = '' // 0.2.23-style: no interrupt switches, Codex defaults (instant_interrupt on)
const NEW = 'instant_interrupt = false\ndefer_mailbox_preemption = true' // what 0.2.24 writes

function makeHome(features) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-live-'))
  const codexHome = path.join(home, 'codex')
  const work = path.join(home, 'work')
  fs.mkdirSync(codexHome); fs.mkdirSync(work)
  let catalogLine = ''
  if (catalog) { fs.copyFileSync(catalog, path.join(codexHome, 'xingmang-models.json')); catalogLine = 'model_catalog_json = "xingmang-models.json"\n' }
  fs.writeFileSync(path.join(codexHome, 'config.toml'), `model_provider = "xingmang"
model = "gpt-6.2-astra"
model_reasoning_effort = "low"
approval_policy = "never"
sandbox_mode = "read-only"
check_for_update_on_startup = false
suppress_unstable_features_warning = true
${catalogLine}
[model_providers.xingmang]
name = "OpenAI"
base_url = "${baseUrl}"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = true

[features]
${features}

[analytics]
enabled = false
`)
  const auth = path.join(codexHome, 'auth.json')
  fs.writeFileSync(auth, JSON.stringify({ OPENAI_API_KEY: key }), { mode: 0o600 })
  return { home, codexHome, work }
}

class Client {
  constructor(bin, env) {
    this.child = spawn(bin, ['app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.nextId = 1; this.pending = new Map(); this.listeners = []
    this.ws = { connects: 0, fallback: 0, http: 0 }
    readline.createInterface({ input: this.child.stderr }).on('line', (line) => {
      // Only counts, never the raw line: it can carry headers.
      if (/successfully connected to Responses WebSocket/.test(line)) this.ws.connects++
      if (/falling back to HTTP/i.test(line)) this.ws.fallback++

    })
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      let msg; try { msg = JSON.parse(line) } catch { return }
      if (msg.id !== undefined && this.pending.has(msg.id) && (msg.result !== undefined || msg.error !== undefined)) {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result)
        return
      }
      if (msg.id !== undefined && msg.method) { this.child.stdin.write(JSON.stringify({ id: msg.id, result: { decision: 'decline' } }) + '\n'); return }
      if (msg.method) for (const l of [...this.listeners]) l(msg)
    })
  }
  request(method, params) {
    const id = this.nextId++
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} timeout`)) } }, 60000)
    })
  }
  async init(model) {
    await this.request('initialize', { clientInfo: { name: 'Codex Desktop', title: 'Codex Desktop', version: '26.1111.0' }, capabilities: { experimentalApi: true } })
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n')
    const started = await this.request('thread/start', { model, cwd: this.cwd })
    return started.thread.id
  }
  // Starts a turn and returns { done: Promise<record>, record, turnId }.
  async startTurn(threadId, text, model, onEvent) {
    const record = { errors: [], warnings: [], agent: [], items: new Set(), firstDeltaAt: 0, status: '', turnError: '' }
    let resolveDone
    const done = new Promise((r) => { resolveDone = r })
    const listener = (msg) => {
      const p = msg.params || {}
      if (msg.method === 'error') record.errors.push(`${p.willRetry ? '(retrying) ' : ''}${(p.error && p.error.message) || JSON.stringify(p)}`.slice(0, 300))
      else if (msg.method === 'warning') record.warnings.push(String(p.message || '').slice(0, 200))
      else if (msg.method === 'item/started' && p.item) record.items.add(p.item.type)
      else if (msg.method === 'item/completed' && p.item && p.item.type === 'agentMessage') record.agent.push(String(p.item.text || ''))
      else if (/delta/i.test(msg.method) && !record.firstDeltaAt) record.firstDeltaAt = Date.now()
      if (onEvent) onEvent(msg, record)
      if (msg.method === 'turn/completed') {
        record.status = p.turn && p.turn.status
        record.turnError = p.turn && p.turn.error ? String(p.turn.error.message || JSON.stringify(p.turn.error)).slice(0, 300) : ''
        record.completedAt = Date.now()
        this.listeners.splice(this.listeners.indexOf(listener), 1)
        resolveDone(record)
      }
    }
    this.listeners.push(listener)
    const params = { threadId, input: [{ type: 'text', text }] }
    if (model) params.model = model
    const turn = await this.request('turn/start', params)
    record.startedAt = Date.now()
    const timer = setTimeout(() => { record.status = 'TIMEOUT'; resolveDone(record) }, 240000)
    done.then(() => clearTimeout(timer))
    return { done, record, turnId: turn.turn.id }
  }
  close() { try { this.child.kill() } catch {} }
}

function summarize(r) {
  const parts = [`status=${r.status}`]
  if (r.turnError) parts.push(`turnError="${r.turnError}"`)
  if (r.errors.length) parts.push(`errors=${JSON.stringify(r.errors)}`)
  const warn = r.warnings.filter((w) => !/^Model metadata/.test(w))
  if (warn.length) parts.push(`warnings=${JSON.stringify(warn)}`)
  if (r.agent.length) parts.push(`reply="${r.agent.join(' | ').replace(/\s+/g, ' ').slice(0, 80)}"`)
  return parts.join(' ')
}
const results = []
function verdict(name, ok, detail) { results.push({ name, ok, detail }); log(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${detail}`) }
const clean = (r) => r.status === 'completed' && !r.turnError && r.errors.length === 0

async function withClient(bin, features, fn) {
  const h = makeHome(features)
  const env = { ...process.env, CODEX_HOME: h.codexHome, RUST_LOG: 'codex_core::client=debug,codex_api=debug' }
  delete env.XM_KEY
  const c = new Client(bin, env)
  c.cwd = h.work
  try { return await fn(c) } finally {
    c.close()
    // The key file goes first and synchronously; the rest is best effort while Codex exits.
    try { fs.rmSync(path.join(h.codexHome, 'auth.json'), { force: true }) } catch {}
    await sleep(1000)
    try { fs.rmSync(h.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch {}
  }
}

const LONG = 'Write the integers from 1 to 800 separated by single spaces. Output nothing else.'

async function scenarioSwitch(label, bin) {
  await withClient(bin, NEW, async (c) => {
    const thread = await c.init('gpt-6.2-astra')
    const plan = [['hi, answer in one short sentence', null], ['hi again, one short sentence', 'gpt-6.2-sol'], ['one more short sentence', null], ['back, one short sentence', 'gpt-6.2-astra'], ['last short sentence', null]]
    const rounds = []
    for (const [text, model] of plan) {
      const t = await c.startTurn(thread, text, model)
      const r = await t.done
      rounds.push(r)
      log(`  switch round model=${model || '(same)'} ${summarize(r)}`)
    }
    const bad = rounds.filter((r) => !clean(r)).length
    verdict(`${label} 换模型 5 轮`, bad === 0, `${5 - bad}/5 clean; websocket connects=${c.ws.connects} fallback_to_http=${c.ws.fallback}`)
  })
}

async function scenarioSteer(label, bin, features, tag) {
  await withClient(bin, features, async (c) => {
    const thread = await c.init('gpt-6.2-astra')
    let steeredAt = 0
    let steerSent = false
    const t = await c.startTurn(thread, LONG, null, (msg, record) => {
      if (!steerSent && record.firstDeltaAt) {
        steerSent = true
        setTimeout(() => {
          steeredAt = Date.now()
          c.request('turn/steer', { threadId: thread, expectedTurnId: t.turnId, input: [{ type: 'text', text: 'Change of plan: after this, reply with just the word DONE.' }] })
            .catch((e) => record.errors.push('steer request failed: ' + e.message))
        }, 1500)
      }
    })
    const r = await t.done
    log(`  steer(${tag}) ${summarize(r)}`)
    const waited = steeredAt && r.completedAt ? ((r.completedAt - steeredAt) / 1000).toFixed(1) : '?'
    const sawDone = r.agent.some((a) => /DONE/.test(a))
    verdict(`${label} 插话(${tag})`, clean(r) && steeredAt > 0, `steer→turn end ${waited}s; follow-up said DONE=${sawDone}; replies=${r.agent.length}; websocket connects=${c.ws.connects} fallback_to_http=${c.ws.fallback}`)
  })
}

async function scenarioStop(label, bin, features, tag) {
  await withClient(bin, features, async (c) => {
    const thread = await c.init('gpt-6.2-astra')
    let stopAt = 0
    let sent = false
    const t = await c.startTurn(thread, LONG, null, (msg, record) => {
      if (!sent && record.firstDeltaAt) {
        sent = true
        setTimeout(() => {
          stopAt = Date.now()
          c.request('turn/interrupt', { threadId: thread, turnId: t.turnId }).catch((e) => record.errors.push('interrupt request failed: ' + e.message))
        }, 1500)
      }
    })
    const r = await t.done
    const stopMs = stopAt && r.completedAt ? r.completedAt - stopAt : -1
    log(`  stop(${tag}) took ${stopMs}ms ${summarize(r)}`)
    await sleep(500)
    const n = await c.startTurn(thread, 'Say OK in one word.', null)
    const nr = await n.done
    log(`  after stop ${summarize(nr)}`)
    verdict(`${label} 停止(${tag})`, r.status === 'interrupted' && stopMs >= 0 && stopMs < 3000 && clean(nr), `turn ${r.status}${stopAt ? '' : ' before stop was sent'}; stop took ${stopMs}ms; next turn ${nr.status}${nr.errors.length ? ' errors' : ''}; websocket connects=${c.ws.connects}`)
  })
}

async function scenarioSubagent(label, bin, features, tag) {
  await withClient(bin, `${features}\nmulti_agent_v2 = true`, async (c) => {
    const thread = await c.init('gpt-6.2-astra')
    const t = await c.startTurn(thread, 'Use your sub-agent tool to spawn exactly one sub-agent with the task: "Reply with the single word PONG." While it runs, write about 120 words on why prime numbers matter. Then wait for the sub-agent, and end your answer with the sub-agent result.', null)
    const r = await t.done
    log(`  subagent(${tag}) items=${JSON.stringify([...r.items])} ${summarize(r)}`)
    const spawned = [...r.items].some((i) => /agent|collab/i.test(i) && !/agentMessage/.test(i))
    const interruptErr = [...r.errors, r.turnError].some((e) => /response\.interrupt/.test(e))
    verdict(`${label} 子代理(${tag})`, clean(r) && !interruptErr, `spawned sub-agent=${spawned}; replies=${r.agent.length}; websocket connects=${c.ws.connects} fallback_to_http=${c.ws.fallback}`)
  })
}

;(async () => {
  const bins = (process.env.CODEX_BINS || '').split(',').filter(Boolean).map((s) => s.split('='))
  log(`base_url=${baseUrl} versions=${bins.map((b) => b[0]).join(',')}`)
  for (const [label, bin] of bins) {
    const want = (s) => only.length === 0 || only.includes(s)
    const fullSet = label.startsWith('0.169.1')
    try {
      if (want('switch')) await scenarioSwitch(label, bin)
      if (want('steer') && fullSet) { await scenarioSteer(label, bin, OLD, '0.2.23配置'); await scenarioSteer(label, bin, NEW, '0.2.24配置') }
      if (want('stop') && fullSet) { await scenarioStop(label, bin, NEW, '默认'); await scenarioStop(label, bin, `${NEW}\ninterrupt_on_cancel = true`, '开interrupt_on_cancel') }
      if (want('subagent')) await scenarioSubagent(label, bin, OLD, '0.2.23配置')
      if (want('subagent') && fullSet) await scenarioSubagent(label, bin, NEW, '0.2.24配置')
    } catch (e) { verdict(`${label} harness`, false, e.message) }
  }
  console.log('\n===== SUMMARY =====')
  for (const r of results) console.log(redact(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`))
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['| 结果 | 项 | 细节 |', '|---|---|---|', ...results.map((r) => `| ${r.ok ? '✅' : '❌'} | ${r.name} | ${redact(r.detail).replace(/\|/g, '/')} |`)].join('\n') + '\n')
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1)
})()
