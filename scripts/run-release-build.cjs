const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { resolveEmptyReleaseOutputDirectory } = require('./update-release-utils.cjs')
const packageVersion = require('../package.json').version

const root = path.resolve(__dirname, '..')

// 产品决定(2026-09-05):Windows 对外发布暂时没有代码签名证书,固定走无签名
// 模式。此前无签名入口是 package.json 里的一条 `compile + electron-builder`,
// 十道门禁一步都不跑(审查总表 M-01)。现在两种模式共用下面这一份步骤表:
// 无签名模式只把「Authenticode 签名主体比对」这一项标成跳过并打印原因,
// 其余每一步照跑。新增步骤默认对两种模式都生效,要跳过必须显式写出理由。
function buildReleaseEnvironment(environment, { releaseOutputDirectory, unsignedReleaseMode }) {
  const releaseEnvironment = {
    ...environment,
    XINGMANG_LOCAL_BUILD: '0',
    XINGMANG_OUTPUT_DIR: releaseOutputDirectory,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  }
  if (unsignedReleaseMode) {
    // electron-builder.config.cjs 拒绝两种发布模式并存,继承来的 XINGMANG_RELEASE
    // 会让整次构建在配置阶段就抛错;签名证书变量留着则会产出一个"其实签了名"的包,
    // 与这条入口声称的产物不符。
    releaseEnvironment.XINGMANG_UNSIGNED_RELEASE = '1'
    delete releaseEnvironment.XINGMANG_RELEASE
    for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) {
      delete releaseEnvironment[name]
    }
    return releaseEnvironment
  }
  releaseEnvironment.XINGMANG_RELEASE = '1'
  delete releaseEnvironment.XINGMANG_UNSIGNED_RELEASE
  for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) {
    if (environment[name] !== undefined) releaseEnvironment[name] = environment[name]
  }
  return releaseEnvironment
}

function buildReleaseSteps({ npmCli, releaseOutputDirectory, unsignedReleaseMode }) {
  const scripts = path.join(root, 'scripts')
  const e2e = path.join(root, 'e2e')
  const unpacked = path.join(releaseOutputDirectory, 'win-unpacked')
  return [
    { label: '发布前置检查', executable: process.execPath, args: [path.join(scripts, 'verify-release-environment.cjs')] },
    { label: 'TypeScript 类型检查', executable: process.execPath, args: [npmCli, 'run', 'typecheck'] },
    // 这里不区分平台:`npm test` 自己就是关文件级并行 + 30s 超时的那一套
    // (test:vitest 带 --no-file-parallelism --testTimeout=30000)。发布门禁跑在
    // 真实磁盘上,两阶段提交叠加 Defender 实时扫描会让若干用例卡过 vitest 默认的
    // 5s 超时(CLAUDE.md 的 Windows 基线一节 / Issue #40)。CI runner 上这几乎
    // 必现——2026-08-12 首次 CI 正式构建就死在 system-service.test.ts 的 5s
    // 超时上,而同一提交在 Linux 全绿。放宽的是超时不是断言:真回归照样红。
    { label: '全部测试', executable: process.execPath, args: [npmCli, 'test'] },
    // 上一步的用例集不含出货渲染层和画布:`npm test` 跑的是 `vitest run electron src`,
    // renderer-v2 的浏览器回归与 canvas-v2 单测各有独立入口。少了这三条,发布门禁
    // 对真正装到客户机器上的那个界面是 0 覆盖,比 quality.yml 的 windows 作业还弱
    // 一档(审查总表 M-03 /《发版前检查清单》缺口 4)。
    { label: '出货渲染层回归测试', executable: process.execPath, args: [npmCli, 'run', 'test:v2'] },
    { label: '画布单元测试', executable: process.execPath, args: [npmCli, 'run', 'test:canvas'] },
    { label: '旧回滚界面测试', executable: process.execPath, args: [npmCli, 'run', 'test:ui'] },
    { label: '编译应用', executable: process.execPath, args: [npmCli, 'run', 'compile'] },
    // 这两个冒烟脚本同时挂在 quality.yml 的 windows 作业上。门禁只跑 CI 也在跑的
    // 脚本,是 M-01 下半的根治:上一版门禁跑的 electron-smoke.mjs 没有任何 CI 会
    // 执行,于是它停在 legacy 的 .app-shell 选择器上半年也没人发现。
    // scripts/ci-workflow-config.test.cjs 钉住了这条对应关系。
    { label: 'Electron 启动冒烟测试', executable: process.execPath, args: [path.join(e2e, 'electron-ci-smoke.mjs')] },
    { label: '首次启动向导冒烟测试', executable: process.execPath, args: [path.join(e2e, 'onboarding-smoke.mjs')] },
    {
      label: unsignedReleaseMode ? '构建未签名 Windows 安装程序' : '构建已签名 Windows 安装程序',
      executable: process.execPath,
      args: [
        path.join(root, 'node_modules', 'electron-builder', 'cli.js'),
        '--config',
        'electron-builder.config.cjs',
        '--publish',
        'never',
      ],
    },
    { label: '校验 Electron 加固状态', executable: process.execPath, args: [path.join(scripts, 'verify-packaged-hardening.cjs'), unpacked] },
    {
      label: '启动加固后的生产程序',
      executable: process.execPath,
      args: [path.join(e2e, 'packaged-hardening-smoke.mjs'), path.join(unpacked, '星芒AI管理工具.exe')],
    },
    { label: '验证 ASAR 篡改会被拒绝', executable: process.execPath, args: [path.join(e2e, 'asar-tamper-smoke.mjs'), unpacked] },
    {
      label: unsignedReleaseMode
        ? '校验发布产物（latest.yml / SHA-512 / blockmap）'
        : '校验发布产物与 Authenticode 签名',
      executable: process.execPath,
      args: [path.join(scripts, 'verify-release-artifacts.cjs'), releaseOutputDirectory],
      skippedChecks: unsignedReleaseMode
        ? ['Authenticode 签名主体比对：无签名模式下没有可比对的证书主体']
        : [],
    },
  ]
}

function main() {
  const unsignedReleaseMode = process.env.XINGMANG_UNSIGNED_RELEASE === '1'
  if (unsignedReleaseMode && process.env.XINGMANG_RELEASE === '1') {
    console.error('[release] XINGMANG_UNSIGNED_RELEASE=1 不能与 XINGMANG_RELEASE=1 同时启用')
    process.exit(1)
  }
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

  const npmCli = process.env.npm_execpath
  if (!npmCli || !fs.existsSync(npmCli)) {
    console.error('[release] 无法定位当前 npm CLI，请通过 npm run release:build 或 npm run release:build:unsigned 启动发布')
    process.exit(1)
  }

  const releaseEnvironment = buildReleaseEnvironment(process.env, { releaseOutputDirectory, unsignedReleaseMode })
  const steps = buildReleaseSteps({ npmCli, releaseOutputDirectory, unsignedReleaseMode })

  console.log(`[release] 已确认空发布目录：${releaseOutputDirectory}`)
  console.log(unsignedReleaseMode
    ? '[release] 发布模式：无签名（产品决定：暂无 Windows 代码签名证书）'
    : '[release] 发布模式：Authenticode 签名')
  for (const step of steps) {
    console.log(`\n[release] ${step.label}`)
    for (const reason of step.skippedChecks ?? []) console.log(`[release] 跳过 ${reason}`)
    const result = spawnSync(step.executable, step.args, {
      cwd: root,
      env: releaseEnvironment,
      stdio: 'inherit',
      windowsHide: true,
    })
    if (result.error) {
      console.error(`[release] 无法启动 ${step.label}：${result.error.message}`)
      process.exit(1)
    }
    if (result.status !== 0) process.exit(result.status ?? 1)
    if (step.label === '编译应用' && !fs.existsSync(path.join(root, 'dist', 'renderer-v2.flag'))) {
      // 门禁后续的冒烟脚本按 renderer-v2 的 data-testid 断言。产出的是 legacy
      // 界面时它们会以"选择器等不到"的形式超时,把构建配置问题伪装成测试问题。
      console.error('[release] 编译产物不是 renderer-v2：缺少 dist/renderer-v2.flag')
      process.exit(1)
    }
  }

  console.log(unsignedReleaseMode
    ? '\n[release] 未签名发布产物已通过全部本地门禁（Authenticode 主体比对除外）'
    : '\n[release] 已签名发布产物已通过全部本地门禁')
}

if (require.main === module) main()

module.exports = { buildReleaseEnvironment, buildReleaseSteps }
