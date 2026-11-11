// 提 PR 前的四道自查，一条命令跑完：`npm run selfcheck`。
//
// 为什么要有：四道（.github/pull_request_template.md「自查」一节）以前是四条命令各敲一遍，
// 再从几千行输出里手摘结尾的汇总行贴进 PR。每个会话都这么做一遍，云端容器里还要记得给
// 浏览器套件指路（AGENTS.md 第 3 节），周巡检那份存好的指令里写死的浏览器路径就这样过期过。
// 这里只做三件事，四道本身一个字不改：
// 1. 照 PR 模板的顺序把四道跑完。哪道红了也接着跑后面的，红的那道最后一起报。
// 2. Playwright 自己那份 Chromium 不在、而 $PLAYWRIGHT_BROWSERS_PATH/chromium 在（云端容器）时，
//    替这一次运行设上 XINGMANG_E2E_CHROMIUM。调用方自己设了，或 Playwright 那份在（CI、本机），
//    都不动，所以 CI 和本机跑到的仍是 Playwright 装的那份。
// 3. 把每道结尾的汇总行原样收在一起打印，贴进 PR 用。
//
// 它不替人装依赖：缺了就停下，把该敲的命令打出来。`npm ci` 会先删掉 node_modules，
// 有的环境里那是别处链过来的，删不删得由敲命令的人定。
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')

// 名字和顺序跟 PR 模板「自查」一节的四个勾选项一致，self-check.test.cjs 钉住。
const selfCheckStages = Object.freeze([
  Object.freeze({ label: 'npm run typecheck', npmArguments: Object.freeze(['run', 'typecheck']) }),
  Object.freeze({ label: 'npm test', npmArguments: Object.freeze(['test']) }),
  Object.freeze({ label: 'npm run check:v2', npmArguments: Object.freeze(['run', 'check:v2']) }),
  Object.freeze({ label: 'npm run test:v2', npmArguments: Object.freeze(['run', 'test:v2']) }),
])

// 跟 quality.yml 装依赖、装 Electron 的那两步是同一条命令（测试钉住），容器里照着敲就行。
const installDependenciesCommand = 'npm ci --registry=https://registry.npmjs.org/'
const installElectronCommand = 'node scripts/ci-ensure-electron-binary.cjs'

function isRegularFile(candidate) {
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

// Electron 43 起 `npm ci` 不装二进制，第一次 require('electron') 才现场去下，那次下载不重试
// 也不限时（scripts/ci-ensure-electron-binary.cjs 开头写了两次红在这上面的经过）。所以依赖
// 装了、二进制没装也算没备齐。path.txt 是 Electron 的安装脚本解压完才写的。
function inspectPrerequisites({ root = projectRoot, exists = fs.existsSync } = {}) {
  if (!exists(path.join(root, 'node_modules', '.package-lock.json'))) {
    return [
      { missing: '依赖还没装', command: installDependenciesCommand },
      { missing: 'Electron 二进制还没装', command: installElectronCommand },
    ]
  }
  if (!exists(path.join(root, 'node_modules', 'electron', 'path.txt'))) {
    return [{ missing: 'Electron 二进制还没装', command: installElectronCommand }]
  }
  return []
}

// Playwright 这一版要的那份 Chromium 装在哪。问不出来（依赖没装全）就当它不在。
function resolvePlaywrightChromium({ root = projectRoot } = {}) {
  try {
    return require(require.resolve('@playwright/test', { paths: [root] })).chromium.executablePath()
  } catch {
    return null
  }
}

// 只在三个条件都成立时返回容器那份的路径：调用方没自己指定；Playwright 要的那份不在；
// $PLAYWRIGHT_BROWSERS_PATH 下有一个叫 chromium 的文件（云端容器里是指向实际版本的链接）。
// 托管 CI 和本机不设 PLAYWRIGHT_BROWSERS_PATH，走不到最后一步。
function resolveContainerChromium({ environment, playwrightChromium, isFile = isRegularFile }) {
  if (environment.XINGMANG_E2E_CHROMIUM) return null
  if (playwrightChromium && isFile(playwrightChromium)) return null
  if (!environment.PLAYWRIGHT_BROWSERS_PATH) return null
  const candidate = path.join(environment.PLAYWRIGHT_BROWSERS_PATH, 'chromium')
  return isFile(candidate) ? candidate : null
}

const ansiEscapes = /\u001b\[[0-9;]*[A-Za-z]/g
// npm 每起一条脚本先打一行 `> 包名@版本 脚本名`。`npm test` 一道里串着好几条脚本，
// 靠这一行知道后面的汇总是哪一条的。
const npmScriptHeader = /^> (?:@[\w.-]+\/)?[\w.-]+@\d+\.\d+\.\d+\S* (\S+)$/
const vitestSummary = /^\s*(?:Test Files|Tests)\s{2,}\S/
// node --test 的结尾计数：输出接管道时是 TAP（`# tests 21`），接终端时是 `ℹ tests 21`。
const nodeTestCounter = /^(?:#|ℹ) (tests|suites|pass|fail|cancelled|skipped|todo) \d+$/

// 从一道的全部输出里挑出结尾的汇总行，原样保留、不改数字：
// - vitest 的 `Test Files …` 和 `Tests …` 各一行；
// - node --test 每个套件组的计数（tests、pass、fail……）并成一行；
// - 两样都没有时（check:v2 只打一行清点结果）取最后一行非空输出；连这个也没有就是空的
//   （typecheck 通过时 tsc 不出声）。
function summarizeOutput(output) {
  const lines = output.replace(ansiEscapes, '').split(/\r?\n/).map((line) => line.trimEnd())
  const summary = []
  let script = null
  let counters = null
  let lastPlainLine = null

  function tagged(text) {
    return script ? `${script}  ${text}` : text
  }
  function flushCounters() {
    if (counters) summary.push(tagged(counters.join('  ')))
    counters = null
  }

  for (const line of lines) {
    const header = npmScriptHeader.exec(line)
    if (header) {
      flushCounters()
      script = header[1]
      continue
    }
    if (vitestSummary.test(line)) {
      flushCounters()
      summary.push(tagged(line.trim().replace(/\s{2,}/g, '  ')))
      continue
    }
    const counter = nodeTestCounter.exec(line)
    if (counter) {
      if (counter[1] === 'tests') flushCounters()
      counters = counters ?? []
      counters.push(line)
      continue
    }
    if (line.trim() && !line.startsWith('> ')) lastPlainLine = line.trim()
  }
  flushCounters()
  if (summary.length === 0 && lastPlainLine) summary.push(lastPlainLine)
  return summary
}

function formatDuration(milliseconds) {
  const seconds = Math.round(milliseconds / 1000)
  if (seconds < 60) return `${seconds} 秒`
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

function describeOutcome(result) {
  if (result.error) return `没跑起来（${result.error.message}）`
  if (result.signal) return `被 ${result.signal} 中止`
  if (result.status === 0) return '通过'
  return `没过（退出码 ${result.status}）`
}

function stagePassed(result) {
  return !result.error && !result.signal && result.status === 0
}

// 跑一道：输出照常往外打（后台跑的人看得到进度），同时存一份完整的到 logFile，
// 结束后从里面挑汇总行。
function runStage(stage, { npmCli, environment, logFile, write, cwd = projectRoot }) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const chunks = []
    let settled = false

    function finish(outcome) {
      if (settled) return
      settled = true
      const output = Buffer.concat(chunks).toString('utf8')
      fs.writeFileSync(logFile, output)
      resolve({
        label: stage.label,
        status: null,
        signal: null,
        error: null,
        ...outcome,
        durationMs: Date.now() - startedAt,
        summary: summarizeOutput(output),
        logFile,
      })
    }
    function collect(chunk) {
      chunks.push(chunk)
      write(chunk)
    }

    const child = spawn(process.execPath, [npmCli, ...stage.npmArguments], {
      cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (error) => finish({ error }))
    child.on('close', (status, signal) => finish({ status, signal }))
  })
}

// 最后那段汇总。每道一行结论，下面缩进跟着它的汇总行；没过的那道带上完整输出存在哪。
function renderReport(results, { chromium = null } = {}) {
  const lines = ['', '===== 自查汇总（原样贴进 PR 的「自查」一节）=====']
  if (chromium) lines.push(`浏览器套件用的是 XINGMANG_E2E_CHROMIUM=${chromium}`)
  for (const result of results) {
    lines.push(`${result.label}：${describeOutcome(result)}，用时 ${formatDuration(result.durationMs)}`)
    for (const line of result.summary) lines.push(`  ${line}`)
    if (!stagePassed(result)) lines.push(`  完整输出：${result.logFile}`)
  }
  const failed = results.filter((result) => !stagePassed(result))
  lines.push(failed.length === 0
    ? `${results.length} 道都过了。`
    : `${results.length} 道里有 ${failed.length} 道没过：${failed.map((result) => result.label).join('、')}。`)
  return lines
}

async function main() {
  if (process.argv.length > 2) {
    console.error('[selfcheck] 不接受参数，四道都跑。只想重跑某一道，直接敲那一条命令。')
    process.exit(2)
  }
  const npmCli = process.env.npm_execpath
  if (!npmCli || !fs.existsSync(npmCli)) {
    console.error('[selfcheck] 找不到当前的 npm，请用 npm run selfcheck 启动。')
    process.exit(2)
  }
  const prerequisites = inspectPrerequisites()
  if (prerequisites.length > 0) {
    console.error('[selfcheck] 还没备齐，四道一道都没跑。先在仓库根目录依次敲：')
    for (const { missing, command } of prerequisites) console.error(`  ${command}    # ${missing}`)
    process.exit(2)
  }

  const containerChromium = resolveContainerChromium({
    environment: process.env,
    playwrightChromium: resolvePlaywrightChromium(),
  })
  const environment = containerChromium
    ? { ...process.env, XINGMANG_E2E_CHROMIUM: containerChromium }
    : process.env
  if (containerChromium) {
    console.log(`[selfcheck] Playwright 自己那份 Chromium 不在，这一次用容器里的：${containerChromium}`)
  }

  const logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-selfcheck-'))
  const results = []
  for (const [index, stage] of selfCheckStages.entries()) {
    console.log(`\n[selfcheck] 第 ${index + 1} 道：${stage.label}`)
    results.push(await runStage(stage, {
      npmCli,
      environment,
      logFile: path.join(logDirectory, `${index + 1}-${stage.label.replace(/[^\w]+/g, '-')}.log`),
      write: (chunk) => process.stdout.write(chunk),
    }))
  }

  console.log(renderReport(results, { chromium: environment.XINGMANG_E2E_CHROMIUM || null }).join('\n'))
  process.exitCode = results.every(stagePassed) ? 0 : 1
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[selfcheck] ${error.stack || error.message}`)
    process.exitCode = 2
  })
}

module.exports = {
  describeOutcome,
  formatDuration,
  inspectPrerequisites,
  installDependenciesCommand,
  installElectronCommand,
  renderReport,
  resolveContainerChromium,
  runStage,
  selfCheckStages,
  summarizeOutput,
}
