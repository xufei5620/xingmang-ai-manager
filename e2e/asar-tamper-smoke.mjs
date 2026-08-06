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

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-asar-tamper-'))
const tamperedDirectory = path.join(temporaryRoot, 'win-unpacked')
const extractedDirectory = path.join(temporaryRoot, 'app-extracted')
const rebuiltAsar = path.join(temporaryRoot, 'tampered.asar')
let application = null

try {
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
  })
  const exitCode = await waitForExit(application, 10_000)
  if (exitCode === null) throw new Error('被篡改的 app.asar 仍然可以持续运行')
  if (exitCode === 0) throw new Error('被篡改的 app.asar 返回了成功退出码')

  console.log(`ASAR 篡改拦截校验通过：生产程序以非零退出码 ${exitCode} 拒绝启动`)
} finally {
  if (application?.exitCode === null) application.kill()
  await fs.rm(temporaryRoot, { recursive: true, force: true })
}
