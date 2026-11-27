const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createSettledPackage } = require('./asar-fixture.test-support.cjs')
const { createHash } = require('node:crypto')
const { SYSTEM_SERVICE_FILES, assertNoDefaultAppFallback, assertWindowsUpdateHandoffScript, inspectPackagedImageUpscale, inspectPackagedLaunchBoundary, inspectPackagedReleaseNotes, readImageUpscaleManifest, resolvePackagedExecutable } = require('./verify-packaged-hardening.cjs')

const currentLaunchBoundary = [
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
  'pwsh.exe',
  '系统 PowerShell 路径必须是绝对路径',
].join(' ')

async function createFixture(t, { service, facade = '', context = '', otherFiles = {}, omit = [], elevation = currentLaunchBoundary, releaseNotes, version = '0.2.9' }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-hardening-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  // Pack a sibling directory so the archive is never written inside the tree
  // being crawled.
  const source = path.join(root, 'app')
  await fs.mkdir(path.join(source, 'dist-electron'), { recursive: true })
  // 打开 CLI 窗口那一段在 provider-launch-service.js（#1070 第 3 步从 system-service.js 搬过去）。
  const files = {
    ...Object.fromEntries(SYSTEM_SERVICE_FILES.map((name) => [name, ''])),
    'system-service.js': facade,
    'system-service-context.js': context,
    ...otherFiles,
    'provider-launch-service.js': service,
    'windows-elevation.js': elevation,
  }
  for (const name of omit) delete files[name]
  for (const [name, text] of Object.entries(files)) {
    await fs.writeFile(path.join(source, 'dist-electron', name), text, 'utf8')
  }
  if (releaseNotes !== undefined) {
    await fs.writeFile(path.join(source, 'dist-electron', 'release-notes.json'), releaseNotes, 'utf8')
  }
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ version }), 'utf8')
  const archive = path.join(root, 'app.asar')
  await createSettledPackage(source, archive)
  return archive
}

test('rejects legacy bare PowerShell CLI launch sequences in packaged artifacts', async (t) => {
  const archive = await createFixture(t, {
    service: 'launchCliPowerShell(command, workspace); wt.exe -w new-tab powershell.exe -NoExit',
  })
  assert.throws(() => inspectPackagedLaunchBoundary(archive), /旧的裸 powershell\.exe/)
})

test('rejects a packaged CLI launch that still requests RunAs', async (t) => {
  const archive = await createFixture(t, {
    service: 'launchElevatedCliPowerShell(command, workspace)',
  })
  assert.throws(() => inspectPackagedLaunchBoundary(archive), /管理员提权启动链/)
})

test('accepts the current absolute-path same-user launch boundary', async (t) => {
  const archive = await createFixture(t, {
    service: 'launchCliPowerShell(command, workspace)',
  })
  assert.doesNotThrow(() => inspectPackagedLaunchBoundary(archive))
})

test('still rejects a legacy or elevated launch chain left in the facade or the shared context', async (t) => {
  const inFacade = await createFixture(t, {
    service: 'launchCliPowerShellForService(command, workspace)',
    facade: 'wt.exe -w new-tab powershell.exe -NoExit',
  })
  assert.throws(() => inspectPackagedLaunchBoundary(inFacade), /旧的裸 powershell\.exe/)
  const inContext = await createFixture(t, {
    service: 'launchCliPowerShellForService(command, workspace)',
    context: 'const launchCliPowerShellForService = launchElevatedCliPowerShell',
  })
  assert.throws(() => inspectPackagedLaunchBoundary(inContext), /管理员提权启动链/)
})

// 拆家前这两条否定检查读的是整份 system-service.js（#1333）：拆出去的每一份都还在查的范围里。
test('still rejects a legacy or elevated launch chain moved into any file split out of the system service', async (t) => {
  const moved = [
    'cli-install-service.js',
    'cli-native-package.js',
    'cli-uninstall-service.js',
    'config-save-service.js',
    'external-client-route-service.js',
    'npm-command-failure.js',
    'npm-registry.js',
    'official-credential-service.js',
    'runtime-install-service.js',
    'system-scan-service.js',
    'tool-route-follow-service.js',
  ]
  for (const name of moved) {
    assert.ok(SYSTEM_SERVICE_FILES.includes(name), `门禁的名单里少了 ${name}`)
    const elevated = await createFixture(t, {
      service: 'launchCliPowerShell(command, workspace)',
      otherFiles: { [name]: 'const launch = launchElevatedCliPowerShell' },
    })
    assert.throws(() => inspectPackagedLaunchBoundary(elevated), /管理员提权启动链/, name)
    const runAs = await createFixture(t, {
      service: 'launchCliPowerShell(command, workspace)',
      otherFiles: { [name]: 'Start-Process powershell.exe -Verb RunAs' },
    })
    assert.throws(() => inspectPackagedLaunchBoundary(runAs), /管理员提权启动链/, name)
    const terminal = await createFixture(t, {
      service: 'launchCliPowerShell(command, workspace)',
      otherFiles: { [name]: 'wt.exe -w new-tab powershell.exe -NoExit' },
    })
    assert.throws(() => inspectPackagedLaunchBoundary(terminal), /旧的裸 powershell\.exe/, name)
  }
})

test('also scans a service file split out later that the list does not name yet', async (t) => {
  const archive = await createFixture(t, {
    service: 'launchCliPowerShell(command, workspace)',
    otherFiles: { 'future-split-service.js': 'const launch = launchElevatedCliPowerShell' },
  })
  assert.throws(() => inspectPackagedLaunchBoundary(archive), /管理员提权启动链/)
})

test('fails instead of scanning less when a named system service file is missing from the package', async (t) => {
  // 改了名、门禁没跟上时，宁可出包失败，也不能悄悄少查一份。
  const archive = await createFixture(t, {
    service: 'launchCliPowerShell(command, workspace)',
    omit: ['config-save-service.js'],
  })
  assert.throws(() => inspectPackagedLaunchBoundary(archive), /无法读取打包后的系统服务（config-save-service\.js）/)
})

test('rejects a packaged launch service that no longer opens CLI windows through launchCliPowerShell', async (t) => {
  // 只在门面里留着名字不算数：打开窗口那一段搬走以后，要在它现在所在的文件里找到。
  const archive = await createFixture(t, {
    service: 'spawn(command, workspace)',
    facade: 'launchCliPowerShell',
  })
  assert.throws(() => inspectPackagedLaunchBoundary(archive), /普通用户 CLI 启动边界/)
})

test('rejects a packaged elevation module that lost absolute path resolution', async (t) => {
  const archive = await createFixture(t, {
    service: 'launchCliPowerShell(command, workspace)',
    elevation: 'spawn("powershell.exe")',
  })
  assert.throws(() => inspectPackagedLaunchBoundary(archive), /缺少绝对 PowerShell 路径解析/)
})


test('rejects a packaged resources directory that still ships the Electron welcome app', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-default-app-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  assert.doesNotThrow(() => assertNoDefaultAppFallback(root))
  await fs.writeFile(path.join(root, 'default_app.asar'), 'not a real archive', 'utf8')
  assert.throws(() => assertNoDefaultAppFallback(root), /默认应用/)
})

test('requires the Windows update handoff script to be packaged exactly as it is in the repository', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-update-handoff-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'source.ps1')
  await fs.writeFile(source, 'exit 0\n', 'utf8')
  const resources = path.join(root, 'resources')
  await fs.mkdir(path.join(resources, 'update-handoff'), { recursive: true })
  assert.throws(() => assertWindowsUpdateHandoffScript(resources, source), /缺少更新安装脚本/)
  await fs.writeFile(path.join(resources, 'update-handoff', 'verified-install.ps1'), 'exit 1\n', 'utf8')
  assert.throws(() => assertWindowsUpdateHandoffScript(resources, source), /不一致/)
  await fs.writeFile(path.join(resources, 'update-handoff', 'verified-install.ps1'), 'exit 0\n', 'utf8')
  assert.doesNotThrow(() => assertWindowsUpdateHandoffScript(resources, source))
})

test('accepts bundled release notes that match the packaged version, including a build without notes', async (t) => {
  const withNotes = await createFixture(t, {
    service: 'launchCliPowerShell()',
    releaseNotes: JSON.stringify({ version: '0.2.9', notes: ['一条改动。'] }),
  })
  assert.deepEqual(inspectPackagedReleaseNotes(withNotes), { version: '0.2.9', count: 1 })
  const withoutNotes = await createFixture(t, {
    service: 'launchCliPowerShell()',
    releaseNotes: JSON.stringify({ version: '0.2.9', notes: null }),
  })
  assert.deepEqual(inspectPackagedReleaseNotes(withoutNotes), { version: '0.2.9', count: 0 })
})

test('rejects a package whose bundled release notes are missing, stale or malformed', async (t) => {
  // 客户端读不到这份文件时只会安静地不显示「这一版改了什么」，没有任何报错，
  // 所以缺文件、版本对不上都得在出包这一步当场失败。
  const missing = await createFixture(t, { service: 'launchCliPowerShell()' })
  assert.throws(() => inspectPackagedReleaseNotes(missing), /随包更新说明/)
  const stale = await createFixture(t, {
    service: 'launchCliPowerShell()',
    releaseNotes: JSON.stringify({ version: '0.2.8', notes: ['上一版。'] }),
  })
  assert.throws(() => inspectPackagedReleaseNotes(stale), /版本与应用版本 0\.2\.9 不一致/)
  const malformed = await createFixture(t, {
    service: 'launchCliPowerShell()',
    releaseNotes: JSON.stringify({ version: '0.2.9', notes: [42] }),
  })
  assert.throws(() => inspectPackagedReleaseNotes(malformed), /格式无效/)
  const broken = await createFixture(t, { service: 'launchCliPowerShell()', releaseNotes: '{' })
  assert.throws(() => inspectPackagedReleaseNotes(broken), /不是有效的 JSON/)
})

async function createImageUpscaleFixture(t, { omit = [], model = 'model bytes' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-hardening-upscale-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'app')
  const files = {
    'package.json': '{}',
    'bundled-catalog/image-upscale/realesr-general-x4v3.onnx': model,
    'dist-image-upscale/node_modules/onnxruntime-web/package.json': '{"name":"onnxruntime-web","version":"1.31.1"}',
    'dist-image-upscale/node_modules/onnxruntime-web/dist/ort.node.min.js': 'module.exports = {}',
    'dist-image-upscale/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs': 'export default {}',
    'dist-image-upscale/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm': 'wasm',
    'dist-image-upscale/node_modules/onnxruntime-common/package.json': '{"name":"onnxruntime-common","version":"1.31.1","type":"module"}',
    'dist-image-upscale/node_modules/onnxruntime-common/dist/cjs/package.json': '{"type":"commonjs"}',
    'dist-image-upscale/node_modules/onnxruntime-common/dist/cjs/index.js': 'module.exports = {}',
  }
  for (const [relative, text] of Object.entries(files)) {
    if (omit.includes(relative)) continue
    await fs.mkdir(path.dirname(path.join(source, relative)), { recursive: true })
    await fs.writeFile(path.join(source, relative), text, 'utf8')
  }
  const archive = path.join(root, 'app.asar')
  await createSettledPackage(source, archive)
  return archive
}

const fixtureManifest = { onnx: { file: 'realesr-general-x4v3.onnx', sha256: createHash('sha256').update('model bytes').digest('hex') } }

test('accepts a package that carries the upscaling model and every runtime file', async (t) => {
  assert.deepEqual(inspectPackagedImageUpscale(await createImageUpscaleFixture(t), fixtureManifest), { modelBytes: 11, runtimeFiles: 7 })
  // The repository's own manifest is what the release job checks against.
  assert.match(readImageUpscaleManifest().onnx.sha256, /^[0-9a-f]{64}$/)
})

test('rejects a package whose upscaling model or runtime file is missing or swapped', async (t) => {
  // 少一样，编译和出包都照样过，客户第一次点「变清晰」才失败，所以在出包这一步拦下。
  const swapped = await createImageUpscaleFixture(t, { model: 'other bytes' })
  assert.throws(() => inspectPackagedImageUpscale(swapped, fixtureManifest), /本机放大模型与 .* sha256 不一致/)
  for (const relative of [
    'bundled-catalog/image-upscale/realesr-general-x4v3.onnx',
    'dist-image-upscale/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
    'dist-image-upscale/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
    'dist-image-upscale/node_modules/onnxruntime-common/package.json',
    // Without it Node reads the CommonJS files as ES modules and the runtime never loads.
    'dist-image-upscale/node_modules/onnxruntime-common/dist/cjs/package.json',
  ]) {
    const missing = await createImageUpscaleFixture(t, { omit: [relative] })
    assert.throws(() => inspectPackagedImageUpscale(missing, fixtureManifest), new RegExp(`打包产物缺少.*${relative.replaceAll('.', '\\.')}`))
  }
  const withoutCommon = await createImageUpscaleFixture(t, { omit: ['dist-image-upscale/node_modules/onnxruntime-common/dist/cjs/index.js'] })
  assert.throws(() => inspectPackagedImageUpscale(withoutCommon, fixtureManifest), /打包产物缺少本机放大运行库目录 .*onnxruntime-common\/dist\/cjs/)
})

test('finds the one platform executable in an unpacked directory', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-hardening-exe-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const windows = path.join(root, 'win-unpacked')
  const linux = path.join(root, 'linux-unpacked')
  const empty = path.join(root, 'empty')
  for (const directory of [windows, linux, empty]) await fs.mkdir(directory)
  await fs.writeFile(path.join(windows, '星芒AI管理工具.exe'), '')
  await fs.writeFile(path.join(linux, 'xingmang-ai-manager'), '')

  assert.equal(resolvePackagedExecutable(windows), path.join(windows, '星芒AI管理工具.exe'))
  assert.equal(resolvePackagedExecutable(linux), path.join(linux, 'xingmang-ai-manager'))
  assert.throws(() => resolvePackagedExecutable(empty), /找不到打包后的主程序/)

  // Two executables mean the directory is not one build's output; guessing
  // would verify a binary that may not be the one being shipped.
  await fs.writeFile(path.join(linux, '星芒AI管理工具.exe'), '')
  assert.throws(() => resolvePackagedExecutable(linux), /多个平台的主程序/)
})
