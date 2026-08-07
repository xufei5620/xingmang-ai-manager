const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { resolveEmptyReleaseOutputDirectory } = require('./update-release-utils.cjs')
const packageVersion = require('../package.json').version

const root = path.resolve(__dirname, '..')
let releaseOutputDirectory
try {
  releaseOutputDirectory = resolveEmptyReleaseOutputDirectory(
    root,
    packageVersion,
    process.env.XINGMANG_OUTPUT_DIR,
  )
} catch (error) {
  console.error(`[release] 发布输出目录检查失败 [${error.code || 'UNKNOWN'}]：${error.message}`)
  process.exit(1)
}
const releaseEnvironment = {
  ...process.env,
  XINGMANG_LOCAL_BUILD: '0',
  XINGMANG_RELEASE: '1',
  XINGMANG_OUTPUT_DIR: releaseOutputDirectory,
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
}
for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) {
  if (process.env[name] !== undefined) releaseEnvironment[name] = process.env[name]
}

function run(label, executable, args) {
  console.log(`\n[release] ${label}`)
  const result = spawnSync(executable, args, {
    cwd: root,
    env: releaseEnvironment,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) {
    console.error(`[release] 无法启动 ${label}：${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const npmCli = process.env.npm_execpath
if (!npmCli || !fs.existsSync(npmCli)) {
  console.error('[release] 无法定位当前 npm CLI，请通过 npm run release:build 启动发布')
  process.exit(1)
}

console.log(`[release] 已确认空发布目录：${releaseOutputDirectory}`)
run('发布前置检查', process.execPath, [path.join(__dirname, 'verify-release-environment.cjs')])
run('TypeScript 类型检查', process.execPath, [npmCli, 'run', 'typecheck'])
run('全部测试', process.execPath, [npmCli, 'test'])
run('编译应用', process.execPath, [npmCli, 'run', 'compile'])
run('Electron 主界面冒烟测试', process.execPath, [
  path.join(root, 'e2e', 'electron-smoke.mjs'),
])
run('首次启动向导冒烟测试', process.execPath, [
  path.join(root, 'e2e', 'onboarding-smoke.mjs'),
])
run('构建已签名 Windows 安装程序', process.execPath, [
  path.join(root, 'node_modules', 'electron-builder', 'cli.js'),
  '--config',
  'electron-builder.config.cjs',
  '--publish',
  'never',
])
run('校验 Electron 加固状态', process.execPath, [
  path.join(__dirname, 'verify-packaged-hardening.cjs'),
  path.join(releaseOutputDirectory, 'win-unpacked'),
])
run('启动加固后的生产程序', process.execPath, [
  path.join(root, 'e2e', 'packaged-hardening-smoke.mjs'),
  path.join(releaseOutputDirectory, 'win-unpacked', '星芒AI管理工具.exe'),
])
run('验证 ASAR 篡改会被拒绝', process.execPath, [
  path.join(root, 'e2e', 'asar-tamper-smoke.mjs'),
  path.join(releaseOutputDirectory, 'win-unpacked'),
])
run('校验发布产物与 Authenticode 签名', process.execPath, [
  path.join(__dirname, 'verify-release-artifacts.cjs'),
  releaseOutputDirectory,
])

console.log('\n[release] 已签名发布产物已通过全部本地门禁')
