import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createPackage, extractAll } = require('@electron/asar')
const sourceDirectory = path.resolve(process.argv[2] || 'release/win-unpacked')

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitForExit(child, timeoutMilliseconds) {
  if (child.exitCode !== null) return child.exitCode
  return Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    delay(timeoutMilliseconds).then(() => null),
  ])
}

const temporaryRoot = path.resolve(await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-asar-tamper-')))
const tamperedDirectory = path.join(temporaryRoot, 'win-unpacked')
const extractedDirectory = path.join(temporaryRoot, 'app-extracted')
const rebuiltAsar = path.join(temporaryRoot, 'tampered.asar')
const isolatedHome = path.join(temporaryRoot, 'home')
const codexHome = path.join(isolatedHome, '.codex')
const childEnvironment = { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome, CODEX_HOME: codexHome }
let application = null

// 清理阶段的问题不能顶掉 try 里的真实失败原因。旧写法把清理失败直接 throw 在
// finally 里，安全断言「被篡改的 app.asar 仍然可以持续运行」会被「未确认篡改测试
// 进程退出」替换掉，CI 日志里看到的是错误的根因。这里改成收集问题，只有在断言
// 本身没挂时才由它们决定退出码。
async function cleanUpTamperFixture() {
  const problems = []
  if (application?.exitCode === null) {
    application.kill()
    if (await waitForExit(application, 5_000) === null) {
      // 进程可能仍持有临时目录里的文件，此时不清理，保留现场供排查。
      problems.push('未确认篡改测试进程退出，已保留临时目录')
      return problems
    }
  }
  // Windows Defender may retain the executable briefly after the integrity
  // check terminates it. Retry bounded cleanup only after confirming exit.
  if (path.dirname(temporaryRoot) !== path.resolve(os.tmpdir()) || !path.basename(temporaryRoot).startsWith('xingmang-asar-tamper-')) {
    problems.push('拒绝清理测试临时根目录以外的路径')
    return problems
  }
  try {
    await fs.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
  } catch (error) {
    problems.push(`清理测试临时目录失败：${error?.message ?? error}`)
  }
  return problems
}

let failure = null
let interceptedExitCode = null
try {
  await fs.mkdir(codexHome, { recursive: true })
  await fs.cp(sourceDirectory, tamperedDirectory, { recursive: true })
  const asarPath = path.join(tamperedDirectory, 'resources', 'app.asar')
  extractAll(asarPath, extractedDirectory)

  const mainScript = path.join(extractedDirectory, 'dist-electron', 'main.js')
  await fs.appendFile(mainScript, '\n// deliberate integrity-test modification\n', 'utf8')
  await createPackage(extractedDirectory, rebuiltAsar)
  await fs.copyFile(rebuiltAsar, asarPath)

  application = spawn(path.join(tamperedDirectory, '星芒AI管理工具.exe'), [
    `--user-data-dir=${path.join(temporaryRoot, 'user-data')}`,
  ], {
    stdio: 'ignore',
    windowsHide: true,
    env: childEnvironment,
  })
  const exitCode = await waitForExit(application, 10_000)
  if (exitCode === null) throw new Error('被篡改的 app.asar 仍然可以持续运行')
  if (exitCode === 0) throw new Error('被篡改的 app.asar 返回了成功退出码')
  interceptedExitCode = exitCode
} catch (error) {
  failure = error
}

const cleanupProblems = await cleanUpTamperFixture()
for (const problem of cleanupProblems) console.error(`ASAR 篡改校验清理阶段问题：${problem}`)
if (failure) throw failure
if (cleanupProblems.length > 0) throw new Error(cleanupProblems.join('；'))

console.log(`ASAR 篡改拦截校验通过：生产程序以非零退出码 ${interceptedExitCode} 拒绝启动`)
