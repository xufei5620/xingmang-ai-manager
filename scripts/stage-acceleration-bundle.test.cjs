const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createHash } = require('node:crypto')
const { test } = require('node:test')
const yaml = require('yaml')
const ts = require('typescript')
const {
  BUNDLE_FILES, parseArguments, stageAccelerationBundle,
  resolveAccelerationBundleResources, verifyAccelerationBundleCore,
} = require('./stage-acceleration-bundle.cjs')

const projectRoot = path.resolve(__dirname, '..')
const sourceModules = new Map()

// Exercise the current safe-file helpers and parser without requiring a prior
// application compile or writing generated files into the working tree.
function sourceModule(name) {
  if (sourceModules.has(name)) return sourceModules.get(name)
  assert.ok(['safe-local-data', 'bounded-file', 'path-identity', 'acceleration-clash-config', 'acceleration-binary'].includes(name))
  const file = path.join(projectRoot, 'electron', `${name}.ts`)
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const module = { exports: {} }
  sourceModules.set(name, module.exports)
  vm.compileFunction(compiled, ['require', 'module', 'exports'], { filename: file })(
    (id) => id.startsWith('./') ? sourceModule(id.slice(2)) : require(id), module, module.exports,
  )
  return module.exports
}

function runtime() {
  return { safe: sourceModule('safe-local-data'), bounded: sourceModule('bounded-file'), parser: sourceModule('acceleration-clash-config'), binary: sourceModule('acceleration-binary') }
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-private-bundle-test-')))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const core = Buffer.from('MZmock-core-binary')
  const config = { version: 1, corePath: path.join(directory, 'source-core.exe'), coreSha256: digest(core), profilePath: path.join(directory, 'source.yaml') }
  const options = {
    configPath: path.join(directory, 'development.json'), outputDirectory: path.join(directory, 'bundle'),
    coreVersion: 'v1.19.12', sourceRef: 'v1.19.12', licensePath: path.join(directory, 'LICENSE-mihomo'),
  }
  fs.writeFileSync(config.corePath, core)
  fs.writeFileSync(options.configPath, JSON.stringify(config))
  fs.writeFileSync(options.licensePath, `GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n${'test license line\n'.repeat(1600)}END OF TERMS AND CONDITIONS\n`)
  fs.writeFileSync(config.profilePath, yaml.stringify({
    'external-controller': '0.0.0.0:9999', secret: 'source-controller-secret',
    'proxy-providers': { private: { url: 'https://private.example/subscription-token' } },
    rules: ['DOMAIN-SUFFIX,private.example,DIRECT'], dns: { enable: true }, tun: { enable: true },
    proxies: [{ name: '日本私有供应商名称', type: 'hysteria2', server: 'node.example.test', port: 443, password: 'test-upstream-secret', sni: 'node.example.test', 'client-fingerprint': 'source-field' }],
  }))
  return { directory, config, options, dependencies: { runtime: runtime() }, core }
}

test('stages only projected nodes, pinned binaries and required notices outside the repository', async (t) => {
  const { options, dependencies, config } = fixture(t)
  const result = await stageAccelerationBundle(options, dependencies)
  assert.equal(result.nodeCount, 1)
  assert.deepEqual(fs.readdirSync(options.outputDirectory).sort(), [...BUNDLE_FILES].sort())
  const source = fs.readFileSync(path.join(options.outputDirectory, 'profile.yaml'), 'utf8')
  const parsed = yaml.parse(source)
  assert.deepEqual(Object.keys(parsed), ['proxies'])
  assert.equal(parsed.proxies[0].name, '日本线路 1')
  assert.equal(parsed.proxies[0].password, 'test-upstream-secret')
  assert.equal(parsed.proxies[0]['client-fingerprint'], undefined)
  for (const privateValue of ['source-controller-secret', 'subscription-token', '私有供应商', config.corePath, config.profilePath]) {
    assert.equal(source.includes(privateValue), false)
    assert.equal(JSON.stringify(result).includes(privateValue), false)
  }
  const resolved = resolveAccelerationBundleResources(options.outputDirectory, projectRoot, dependencies.runtime)
  assert.deepEqual(resolved.metadata, result.manifest)
  assert.deepEqual(resolved.resources, [{ from: options.outputDirectory, to: 'acceleration', filter: BUNDLE_FILES }])
  await verifyAccelerationBundleCore(options.outputDirectory, result.manifest, dependencies.runtime)
  assert.equal(fs.readFileSync(path.join(options.outputDirectory, 'THIRD-PARTY-NOTICES.txt'), 'utf8').includes('/tree/v1.19.12'), true)
})

test('default packaging does not access private data or require compiled runtime modules', () => {
  for (const directory of [undefined, '']) assert.deepEqual(resolveAccelerationBundleResources(directory), { resources: [], metadata: undefined })
})

test('refuses output and private inputs inside the repository', async (t) => {
  const { options, dependencies } = fixture(t)
  for (const changed of [
    { outputDirectory: projectRoot },
    { outputDirectory: path.join(projectRoot, 'private-nodes') },
    { configPath: path.join(projectRoot, 'private.json') },
    { outputDirectory: 'relative-directory' },
  ]) await assert.rejects(stageAccelerationBundle({ ...options, ...changed }, dependencies), /项目目录之外|绝对路径/)
  assert.equal(fs.existsSync(options.outputDirectory), false)
})

test('refuses to overwrite existing staging files', async (t) => {
  const { options, dependencies } = fixture(t)
  fs.mkdirSync(options.outputDirectory)
  fs.writeFileSync(path.join(options.outputDirectory, 'keep.txt'), 'unchanged')
  await assert.rejects(stageAccelerationBundle(options, dependencies), /不存在或为空/)
  assert.equal(fs.readFileSync(path.join(options.outputDirectory, 'keep.txt'), 'utf8'), 'unchanged')
})

test('rejects mismatched core digests before creating output', async (t) => {
  const { options, dependencies, config } = fixture(t)
  fs.writeFileSync(config.corePath, 'MZchanged-core')
  await assert.rejects(stageAccelerationBundle(options, dependencies), /SHA256/)
  assert.equal(fs.existsSync(options.outputDirectory), false)
})

test('rejects hardlinked inputs and junction output directories', async (t) => {
  const { options, dependencies, config, directory } = fixture(t)
  const original = path.join(directory, 'original.exe')
  fs.renameSync(config.corePath, original)
  fs.linkSync(original, config.corePath)
  await assert.rejects(stageAccelerationBundle(options, dependencies), /单链接/)
  fs.unlinkSync(config.corePath)
  fs.renameSync(original, config.corePath)
  const target = path.join(directory, 'target')
  fs.mkdirSync(target)
  fs.symlinkSync(target, options.outputDirectory, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(stageAccelerationBundle(options, dependencies), /符号链接|目录联接/)
  assert.deepEqual(fs.readdirSync(target), [])
})

test('rejects malformed sensitive YAML without returning the parser source excerpt', async (t) => {
  const { options, dependencies, config } = fixture(t)
  fs.writeFileSync(config.profilePath, 'proxies: [test-upstream-secret')
  await assert.rejects(stageAccelerationBundle(options, dependencies), (error) => {
    assert.equal(error.message.includes('test-upstream-secret'), false)
    return true
  })
  assert.equal(fs.existsSync(options.outputDirectory), false)
})

test('rejects missing licenses and unpinned source revisions before staging', async (t) => {
  const { options, dependencies } = fixture(t)
  await assert.rejects(stageAccelerationBundle({ ...options, sourceRef: 'main' }, dependencies), /源码版本/)
  fs.writeFileSync(options.licensePath, 'GPL-3.0-only')
  await assert.rejects(stageAccelerationBundle(options, dependencies), /完整.*许可/)
  assert.equal(fs.existsSync(options.outputDirectory), false)
})

test('packager detects modification of each pinned resource', async (t) => {
  const { options, dependencies } = fixture(t)
  const { manifest } = await stageAccelerationBundle(options, dependencies)
  for (const file of ['mihomo.exe', 'profile.yaml']) {
    const target = path.join(options.outputDirectory, file)
    const original = fs.readFileSync(target)
    fs.writeFileSync(target, Buffer.concat([original, Buffer.from('changed')]))
    await assert.rejects(verifyAccelerationBundleCore(options.outputDirectory, manifest, dependencies.runtime), /不一致/)
    fs.writeFileSync(target, original)
  }
  fs.writeFileSync(path.join(options.outputDirectory, 'unexpected-secret.txt'), 'private')
  assert.throws(() => resolveAccelerationBundleResources(options.outputDirectory, projectRoot, dependencies.runtime), /非预期/)
})

test('argument parser rejects missing, duplicate and unknown options', () => {
  const args = ['--config', '/private/config.json', '--output', '/private/bundle', '--core-version', 'v1.19.12', '--source-ref', 'v1.19.12', '--license', '/private/LICENSE']
  assert.equal(parseArguments(args).configPath, '/private/config.json')
  for (const invalid of [[], args.slice(0, -2), [...args, '--config', '/other.json'], [...args, '--unknown', 'x']]) {
    assert.throws(() => parseArguments(invalid))
  }
})

for (const arch of ['arm64', 'x64']) {
  test(`stages a pinned ${arch} Mach-O core with an explicit Darwin manifest`, async (t) => {
    const { options, dependencies, config } = fixture(t)
    const core = Buffer.alloc(64)
    core.writeUInt32LE(0xfeedfacf, 0)
    core.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4)
    core.writeUInt32LE(2, 12)
    fs.writeFileSync(config.corePath, core)
    fs.writeFileSync(options.configPath, JSON.stringify({ ...config, coreSha256: digest(core) }))
    const result = await stageAccelerationBundle({ ...options, platform: 'darwin', arch }, dependencies)
    assert.equal(result.manifest.version, 2)
    assert.equal(result.manifest.platform, 'darwin')
    assert.equal(result.manifest.arch, arch)
    assert.equal(result.manifest.coreFile, 'mihomo')
    assert.equal(fs.existsSync(path.join(options.outputDirectory, 'mihomo.exe')), false)
    assert.deepEqual(fs.readFileSync(path.join(options.outputDirectory, 'mihomo')), core)
    const resolved = resolveAccelerationBundleResources(options.outputDirectory, projectRoot, dependencies.runtime)
    assert.equal(resolved.metadata.arch, arch)
    await verifyAccelerationBundleCore(options.outputDirectory, result.manifest, dependencies.runtime, { platform: 'darwin', arch })
    await assert.rejects(verifyAccelerationBundleCore(options.outputDirectory, result.manifest, dependencies.runtime, { platform: 'darwin', arch: arch === 'arm64' ? 'x64' : 'arm64' }), /架构/)
    await assert.rejects(verifyAccelerationBundleCore(options.outputDirectory, result.manifest, dependencies.runtime, { platform: 'win32', arch: 'x64' }), /平台/)
  })
}

test('Darwin staging rejects Windows executables, mismatched CPU and dylibs before output creation', async (t) => {
  const { options, dependencies, config } = fixture(t)
  await assert.rejects(stageAccelerationBundle({ ...options, platform: 'darwin', arch: 'arm64' }, dependencies), /Mac|macOS|Mach-O/)
  const core = Buffer.alloc(64)
  core.writeUInt32LE(0xfeedfacf, 0)
  core.writeUInt32LE(0x01000007, 4)
  core.writeUInt32LE(2, 12)
  fs.writeFileSync(config.corePath, core)
  fs.writeFileSync(options.configPath, JSON.stringify({ ...config, coreSha256: digest(core) }))
  await assert.rejects(stageAccelerationBundle({ ...options, platform: 'darwin', arch: 'arm64' }, dependencies), /架构/)
  core.writeUInt32LE(6, 12)
  fs.writeFileSync(config.corePath, core)
  fs.writeFileSync(options.configPath, JSON.stringify({ ...config, coreSha256: digest(core) }))
  await assert.rejects(stageAccelerationBundle({ ...options, platform: 'darwin', arch: 'x64' }, dependencies), /可执行/)
  assert.equal(fs.existsSync(options.outputDirectory), false)
})

test('Darwin staging requires an explicit supported architecture', () => {
  const args = ['--config', '/private/config.json', '--output', '/private/bundle', '--core-version', 'v1.19.29', '--source-ref', 'v1.19.29', '--license', '/private/LICENSE', '--platform', 'darwin']
  assert.throws(() => parseArguments(args), /架构/)
  assert.throws(() => parseArguments([...args, '--arch', 'ia32']), /架构/)
  const options = parseArguments([...args, '--arch', 'arm64'])
  assert.equal(options.platform, 'darwin')
  assert.equal(options.arch, 'arm64')
})
