#!/usr/bin/env node
// 发布在线加速节点，给 acceleration-nodes 工作流调用（客户端怎么读见 electron/acceleration-online-nodes.ts，
// 一步步的操作见 docs/GLOBAL-ACCELERATION.md「在线换节点」）：
//
//   preview --current <线上那份> [--withdraw] [--summary <文件>]
//     照仓库里现在的 bundled-acceleration/profile.yaml 算一遍这次要发布什么，写给批准的人看。不签名，
//     不需要私钥。
//
//   build --current <线上那份> --output <文件> [--withdraw] [--summary <文件>]
//     同上，再用环境变量 XINGMANG_UPDATE_SIGNING_KEY 签名，写出要上传的那份。写之前先确认这把私钥对应的公钥
//     在客户端内置的名单里，再用客户端同一套代码（编译好的 dist-electron/acceleration-online-nodes.js）确认
//     客户端会收下它。
//
//   check [--summary <文件>]
//     发版前跑（publish-release 的两个出包作业）：自己去读线上那份，客户端会用它、它又跟仓库里这次要装进
//     安装包的节点不一样，就报错停下。不签名，不需要私钥。为什么要这一道见 checkReleaseAgainstLive。
//
// 只发仓库里固定了 SHA-256 的那份节点：工作流的输入里没有节点和密码，换节点先走一次 PR，节点改了什么在
// PR 里看得到。--withdraw 发一份签过名的「撤回」，客户端读到后改用安装包自带的节点；直接删掉线上的文件
// 不行，客户端读不到时会接着用记下的那份。
//
// 签的内容与 electron/acceleration-online-nodes.ts 的 buildAccelerationNodesPayload 必须逐字一致，两边由
// 各自的测试钉住同一串字。
const fs = require('node:fs')
const path = require('node:path')
const { createHash, sign } = require('node:crypto')
const { UpdateSignatureError, exportPublicKey, loadSigningKey, readPinnedPublicKeys } = require('./update-manifest-signature.cjs')
const { projectAccelerationProfileSource } = require('./stage-acceleration-bundle.cjs')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const PAYLOAD_HEADER = 'xingmang-acceleration-nodes/v1'
const KEY_ENV = 'XINGMANG_UPDATE_SIGNING_KEY'
const MAX_DOCUMENT_BYTES = 256 * 1024
const LIVE_FETCH_TIMEOUT_MS = 30_000

class AccelerationNodesError extends Error {}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function buildPayload(issuedAt, profileSha256) {
  if (typeof issuedAt !== 'string' || !issuedAt || /[\r\n\0]/.test(issuedAt)) {
    throw new AccelerationNodesError('发布时间不能签名')
  }
  if (profileSha256 !== null && !/^[a-f\d]{64}$/.test(String(profileSha256))) {
    throw new AccelerationNodesError('节点的 SHA-256 不能签名')
  }
  return `${PAYLOAD_HEADER}\nissuedAt=${issuedAt}\nprofileSha256=${profileSha256 ?? 'none'}\n`
}

function loadRuntime() {
  try {
    return {
      parser: require('../dist-electron/acceleration-clash-config.js'),
      online: require('../dist-electron/acceleration-online-nodes.js'),
    }
  } catch {
    throw new AccelerationNodesError('请先编译主进程（tsc -p tsconfig.electron.json），再发布加速节点')
  }
}

/** 仓库里的节点，按 profile.sha256 核对过；对不上说明改节点时漏改了校验值。 */
function readRepositoryProfile(projectRoot = PROJECT_ROOT) {
  const directory = path.join(projectRoot, 'bundled-acceleration')
  const source = fs.readFileSync(path.join(directory, 'profile.yaml'), 'utf8')
  const pinned = fs.readFileSync(path.join(directory, 'profile.sha256'), 'utf8')
  if (!/^[a-f\d]{64}\n?$/.test(pinned) || sha256(source) !== pinned.trim()) {
    throw new AccelerationNodesError('仓库里的 profile.yaml 跟 profile.sha256 对不上，先在 PR 里把两个文件一起改好')
  }
  return source
}

function beijingTime(iso) {
  return `${new Date(Date.parse(iso) + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ')}（北京时间）`
}

function describeLines(profile) {
  return profile.nodes.map((node) => `${node.label}：${node.connection.server}:${node.connection.port}`)
}

/** 线上那份现在是什么。读不到（404）是 null；读到了就照客户端的口径校验，客户端不收的照实说。 */
function inspectLive(currentText, runtime, pinnedKeys) {
  if (currentText === null) return { state: 'missing' }
  const verdict = runtime.online.parseSignedAccelerationNodes(currentText, { publicKeys: pinnedKeys })
  if (!verdict.ok) return { state: 'rejected', reason: verdict.reason }
  const parsed = JSON.parse(currentText.replace(/^﻿/, ''))
  return { state: 'valid', issuedAt: verdict.document.issuedAt, profile: verdict.document.profile, source: parsed.profile }
}

/**
 * 算出这次要发布什么。发布时间取现在，必须比线上那份晚：客户端只收比记下的那份新的。跟线上一模一样、
 * 或者线上本来就没有在线节点还要撤回，都当场报错，不用白批一次。
 */
function planAccelerationNodes({ withdraw = false, profileSource, currentText = null, now = new Date(), runtime, pinnedKeys }) {
  const issuedAt = now.toISOString()
  const live = inspectLive(currentText, runtime, pinnedKeys)
  if (live.state === 'valid' && Date.parse(live.issuedAt) >= Date.parse(issuedAt)) {
    throw new AccelerationNodesError(`线上那份的发布时间（${live.issuedAt}）不比现在早，客户端不会收这次的，请过一分钟再跑`)
  }
  let profile = null
  let projected = null
  if (!withdraw) {
    projected = projectAccelerationProfileSource(runtime.parser.parseClashAccelerationProfile(profileSource))
    profile = runtime.parser.parseClashAccelerationProfile(projected)
    if (live.state === 'valid' && live.source === projected) {
      throw new AccelerationNodesError('仓库里的节点跟线上那份一模一样，不用再发')
    }
  } else if (live.state !== 'valid' || live.profile === null) {
    throw new AccelerationNodesError('线上现在没有在用的在线节点，客户端本来就用安装包自带的，不用撤回')
  }
  return { issuedAt, withdraw, profile, profileSource: projected, live }
}

/**
 * 发版前那道关（#1359）：线上有一份客户端会用的在线节点（签名对、没撤回），跟仓库里这次要装进安装包的又不一样，
 * 就不让出包。客户端记下过在线节点以后一直优先用它（electron/acceleration-worker-profile.ts），新版安装包换了
 * 节点也用不上：改了 profile.yaml 发了版、忘了跑 acceleration-nodes，记下过旧节点的老客户就一直连旧节点，
 * 旧节点要是已经不通，他们的加速就断了，新装的客户却正常，很难查。线上没有、撤回过、客户端不收的那份都放行：
 * 那几种客户端用的本来就是安装包自带的。
 */
function checkReleaseAgainstLive({ profileSource, currentText = null, runtime, pinnedKeys }) {
  const live = inspectLive(currentText, runtime, pinnedKeys)
  if (live.state === 'missing') return ['- 在线加速节点：线上还没发布过，客户端都用安装包自带的。']
  if (live.state === 'rejected') return [`- 在线加速节点：线上那份没通过客户端的校验（${live.reason}），客户端不会用它。`]
  if (live.profile === null) return [`- 在线加速节点：${beijingTime(live.issuedAt)}撤回过，客户端都用安装包自带的。`]
  const projected = projectAccelerationProfileSource(runtime.parser.parseClashAccelerationProfile(profileSource))
  if (live.source !== projected) {
    throw new AccelerationNodesError(`线上的在线加速节点（${beijingTime(live.issuedAt)}发布）跟这次安装包里的不一样。`
      + '记下过线上那份的客户端会一直用它，新版安装包里的节点用不上。'
      + '先在 Actions 里跑一次 acceleration-nodes（publish 发仓库里现在的节点，或 withdraw 撤回在线节点），再重跑发版。')
  }
  return [`- 在线加速节点：线上那份（${beijingTime(live.issuedAt)}发布）跟这次安装包里的一样。`]
}

/**
 * 发版时自己读线上那份，读法跟客户端一样：限时、限大小、不跟跳转。404 是还没发布过；别的读不到一律停下：
 * 查不清就当不能发（#493），这会儿线上还是旧版本，停下没有代价。
 */
async function fetchLiveDocument(url, fetchImpl = globalThis.fetch) {
  const failure = (detail) => new AccelerationNodesError(`读不到线上的在线加速节点（${detail}），查不清就先不出包，过几分钟重跑`)
  let response
  try {
    response = await fetchImpl(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS) })
  } catch {
    throw failure('连不上')
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined)
    return null
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw failure(`HTTP ${response.status}`)
  }
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_DOCUMENT_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    return 'not a node list'
  }
  const chunks = []
  let total = 0
  try {
    for await (const chunk of response.body ?? []) {
      total += chunk.byteLength
      // 超过上限的不是节点文件，客户端也不收；当成「客户端不收的那份」，照常放行。
      if (total > MAX_DOCUMENT_BYTES) return 'not a node list'
      chunks.push(Buffer.from(chunk))
    }
  } catch {
    throw failure('读到一半断了')
  }
  return Buffer.concat(chunks).toString('utf8')
}

function liveNodesUrl() {
  const { resolveUpdateUrlForVersion } = require('./update-release-utils.cjs')
  const { version } = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'))
  return new URL('acceleration-nodes.json', `${resolveUpdateUrlForVersion(version).replace(/\/+$/, '')}/`).href
}

function describePlan(plan) {
  const lines = ['## 这次要发布的加速节点', '']
  if (plan.withdraw) {
    lines.push('- 这次是**撤回**：客户端下一次读到后（最迟一小时），改用安装包自带的节点。')
  } else {
    lines.push(`- 一共 ${plan.profile.nodes.length} 条线路（连接密码不在这里列出）：`)
    for (const line of describeLines(plan.profile)) lines.push(`  - ${line}`)
    lines.push('- 批准以后，客户端最迟一小时内换上，下一次连接起用（0.2.21 及以后的版本才认）。')
  }
  lines.push(`- 发布时间：${beijingTime(plan.issuedAt)}`)
  const { live } = plan
  if (live.state === 'missing') lines.push('- 线上现在：还没发布过在线节点，客户端都用安装包自带的。')
  else if (live.state === 'rejected') lines.push(`- 线上现在：有一份，但没通过客户端的校验（${live.reason}），客户端不会用它，这次会盖掉它。`)
  else if (live.profile === null) lines.push(`- 线上现在：${beijingTime(live.issuedAt)}撤回过，客户端都用安装包自带的。`)
  else lines.push(`- 线上现在：${beijingTime(live.issuedAt)}发布的 ${live.profile.nodes.length} 条线路（${describeLines(live.profile).join('；')}）。`)
  return lines
}

/** 签名并写出要上传的那份；写之前用客户端的代码再收一遍。 */
function signAccelerationNodes(plan, { privateKey, pinnedKeys, runtime }) {
  const derived = exportPublicKey(privateKey)
  if (!pinnedKeys.includes(derived)) {
    throw new AccelerationNodesError(`${KEY_ENV} 对应的公钥不在客户端内置名单里，签出来的节点客户端不会收。公钥是：${derived}`)
  }
  const digest = plan.profileSource === null ? null : sha256(plan.profileSource)
  const signature = sign(null, Buffer.from(buildPayload(plan.issuedAt, digest), 'utf8'), privateKey).toString('base64')
  const text = `${JSON.stringify({ format: 1, issuedAt: plan.issuedAt, profile: plan.profileSource, signature }, null, 2)}\n`
  if (Buffer.byteLength(text, 'utf8') > MAX_DOCUMENT_BYTES) throw new AccelerationNodesError('节点文件超过客户端的 256 KB 上限')
  const verdict = runtime.online.parseSignedAccelerationNodes(text, { publicKeys: pinnedKeys })
  if (!verdict.ok || (verdict.document.profile === null) !== plan.withdraw) {
    throw new AccelerationNodesError(`签好的节点文件客户端不收（${verdict.ok ? '内容不对' : verdict.reason}），这次不发`)
  }
  return text
}

function parseArguments(argv) {
  const [command, ...rest] = argv
  if (command !== 'preview' && command !== 'build' && command !== 'check') {
    throw new AccelerationNodesError('用法：acceleration-nodes.cjs preview|build --current <文件> [--output <文件>] [--withdraw] [--summary <文件>]，或 check [--summary <文件>]')
  }
  const options = { command, withdraw: false }
  // check 自己去读线上那份、只核对仓库里的节点，所以不收 --current、--output、--withdraw。
  const flags = command === 'check' ? ['--summary'] : ['--current', '--output', '--summary']
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]
    if (flag === '--withdraw' && command !== 'check') {
      options.withdraw = true
      continue
    }
    const value = rest[index + 1]
    if (!flags.includes(flag) || !value || value.startsWith('--') || options[flag] !== undefined) {
      throw new AccelerationNodesError(`参数不对：${flag}`)
    }
    options[flag] = value
    index += 1
  }
  if (command === 'check') return options
  if (!options['--current']) throw new AccelerationNodesError('缺少 --current（线上那份的下载位置，线上没有时文件不存在即可）')
  if (command === 'build' && !options['--output']) throw new AccelerationNodesError('build 需要 --output')
  return options
}

function readCurrent(file) {
  if (!fs.existsSync(file)) return null
  const stat = fs.statSync(file)
  if (!stat.isFile() || stat.size > MAX_DOCUMENT_BYTES) return 'not a node list'
  return fs.readFileSync(file, 'utf8')
}

async function main(argv, environment = process.env, fetchImpl = globalThis.fetch) {
  const options = parseArguments(argv)
  const runtime = loadRuntime()
  const pinnedKeys = readPinnedPublicKeys()
  if (options.command === 'check') {
    const lines = checkReleaseAgainstLive({
      profileSource: readRepositoryProfile(),
      currentText: await fetchLiveDocument(liveNodesUrl(), fetchImpl),
      runtime,
      pinnedKeys,
    })
    if (options['--summary']) fs.appendFileSync(options['--summary'], `${lines.join('\n')}\n`)
    console.log(lines.join('\n'))
    return
  }
  const plan = planAccelerationNodes({
    withdraw: options.withdraw,
    profileSource: options.withdraw ? null : readRepositoryProfile(),
    currentText: readCurrent(options['--current']),
    runtime,
    pinnedKeys,
  })
  const summary = describePlan(plan)
  if (options['--summary']) fs.appendFileSync(options['--summary'], `${summary.join('\n')}\n`)
  console.log(summary.join('\n'))
  if (options.command === 'build') {
    const text = signAccelerationNodes(plan, { privateKey: loadSigningKey(environment[KEY_ENV]), pinnedKeys, runtime })
    fs.writeFileSync(options['--output'], text, { flag: 'wx', mode: 0o600 })
    console.log('节点文件已签名，客户端校验通过')
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    // 只报自己写的那几句：别的错误（YAML 解析之类）可能带出节点密码。
    const known = error instanceof AccelerationNodesError || error instanceof UpdateSignatureError
    console.error(`::error::${known ? error.message : '加速节点发布失败，请看上面的步骤'}`)
    process.exit(1)
  })
}

module.exports = {
  AccelerationNodesError,
  buildPayload,
  checkReleaseAgainstLive,
  describePlan,
  fetchLiveDocument,
  liveNodesUrl,
  parseArguments,
  planAccelerationNodes,
  readRepositoryProfile,
  signAccelerationNodes,
}
