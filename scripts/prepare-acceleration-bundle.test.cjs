const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createHash } = require('node:crypto')
const { gzipSync } = require('node:zlib')
const {
  ALLOWED_HOSTS, assertAllowedUrl, fetchAccelerationCore, parseArguments,
  prepareAccelerationBundle, readCoreCatalog, resolveCoreTarget,
} = require('./prepare-acceleration-bundle.cjs')

const projectRoot = path.resolve(__dirname, '..')

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function workspace(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-accel-prepare-test-')))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function respond(body, extra = {}) {
  return {
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(body.length) : null) },
    arrayBuffer: async () => body,
    ...extra,
  }
}

function redirect(location) {
  return { status: 302, headers: { get: (name) => (name.toLowerCase() === 'location' ? location : null) }, arrayBuffer: async () => Buffer.alloc(0) }
}

const license = Buffer.from(`GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n${'license line\n'.repeat(2000)}END OF TERMS AND CONDITIONS\n`)
const core = Buffer.from('\xcf\xfa\xed\xfemock-mihomo-core')

function catalogFixture() {
  return {
    coreVersion: 'v1.19.29',
    sourceRef: 'v1.19.29',
    sourceUrl: 'https://github.com/MetaCubeX/mihomo',
    license: { path: 'LICENSE', sha256: digest(license) },
    targets: {
      'darwin-arm64': { asset: 'mihomo-darwin-arm64-v1.19.29.gz', assetSha256: digest(gzipSync(core)), archive: 'gzip', coreFile: 'mihomo', coreSha256: digest(core) },
    },
  }
}

function stubFetch(responses) {
  const seen = []
  return {
    seen,
    implementation: async (url) => {
      seen.push(url)
      const response = responses[url]
      if (!response) throw new Error(`没有为 ${url} 准备响应`)
      return typeof response === 'function' ? response() : response
    },
  }
}

test('the catalog shipped in the repository is a valid one', () => {
  // 对账表是这条链路唯一的信任根：它进了仓库、过了审查，下载回来的字节才有东西
  // 可比。一个格式跑偏的对账表在 CI 上表现为"打包到一半才失败"。
  const catalog = readCoreCatalog(projectRoot)
  assert.match(catalog.coreVersion, /^v\d+\.\d+\.\d+$/)
  assert.deepEqual(Object.keys(catalog.targets).sort(), ['darwin-arm64', 'darwin-x64', 'win32-x64'])
  for (const target of Object.keys(catalog.targets)) {
    const resolved = resolveCoreTarget(catalog, target)
    assert.ok(resolved.url.startsWith(`https://github.com/MetaCubeX/mihomo/releases/download/${catalog.coreVersion}/`))
    assert.equal(resolved.licenseUrl, `https://raw.githubusercontent.com/MetaCubeX/mihomo/${catalog.sourceRef}/LICENSE`)
    assert.equal(resolved.coreFile, target.startsWith('darwin-') ? 'mihomo' : 'mihomo.exe')
  }
})

test('a target the catalog does not pin is refused rather than guessed at', () => {
  const catalog = readCoreCatalog(projectRoot)
  assert.throws(() => resolveCoreTarget(catalog, 'linux-x64'), /没有目标/)
  assert.throws(() => resolveCoreTarget(catalog, '../win32-x64'), /没有目标/)
  assert.throws(() => resolveCoreTarget(catalog, '__proto__'), /没有目标/)
})

test('the catalog must agree with itself about which platform a core is for', () => {
  const catalog = catalogFixture()
  catalog.targets['darwin-arm64'].coreFile = 'mihomo.exe'
  assert.throws(() => resolveCoreTarget(catalog, 'darwin-arm64'), /文件名与目标平台不一致/)
})

test('an unpinned hash or archive format is a hard failure, never a warning', () => {
  for (const mutate of [
    (catalog) => { catalog.targets['darwin-arm64'].assetSha256 = 'not-a-hash' },
    (catalog) => { catalog.targets['darwin-arm64'].coreSha256 = '' },
    (catalog) => { catalog.targets['darwin-arm64'].archive = 'tar' },
    (catalog) => { catalog.targets['darwin-arm64'].asset = '../../etc/passwd' },
  ]) {
    const catalog = catalogFixture()
    mutate(catalog)
    assert.throws(() => resolveCoreTarget(catalog, 'darwin-arm64'))
  }
})

test('downloads are confined to GitHub over https, on every hop', () => {
  // release 资产必然跳一次到对象存储，所以这里不能一律拒绝重定向；能做的是把
  // 每一跳都重新过一遍来源校验，跳出 GitHub 就当场停。
  for (const host of ALLOWED_HOSTS) assert.equal(assertAllowedUrl(`https://${host}/a`).hostname, host)
  assert.throws(() => assertAllowedUrl('http://github.com/a'), /不在允许的来源内/)
  assert.throws(() => assertAllowedUrl('https://github.com.evil.test/a'), /不在允许的来源内/)
  assert.throws(() => assertAllowedUrl('https://evil.test/github.com'), /不在允许的来源内/)
  assert.throws(() => assertAllowedUrl('file:///etc/passwd'), /不在允许的来源内/)
})

test('a redirect that leaves GitHub stops the download instead of following it', async (t) => {
  const catalog = catalogFixture()
  const target = resolveCoreTarget(catalog, 'darwin-arm64')
  const { implementation } = stubFetch({ [target.url]: redirect('https://mirror.evil.test/mihomo.gz') })
  await assert.rejects(
    fetchAccelerationCore(target, workspace(t), { fetchImplementation: implementation }),
    /不在允许的来源内/,
  )
})

test('a release asset that does not match the pinned hash is discarded', async (t) => {
  const catalog = catalogFixture()
  const target = resolveCoreTarget(catalog, 'darwin-arm64')
  const { implementation } = stubFetch({ [target.url]: respond(gzipSync(Buffer.from('a different core'))) })
  await assert.rejects(
    fetchAccelerationCore(target, workspace(t), { fetchImplementation: implementation }),
    /资产与对账表的 SHA256 不一致/,
  )
})

test('an asset that unpacks to something other than the pinned core is discarded', async (t) => {
  // 两道哈希各防一件事：第一道防传输和上游资产被换掉，第二道防"资产没换、解出
  // 来的东西换了"。缺了第二道，压缩包里塞第二个文件就有机会被带进安装包。
  const catalog = catalogFixture()
  catalog.targets['darwin-arm64'].coreSha256 = digest(Buffer.from('some other bytes'))
  const target = resolveCoreTarget(catalog, 'darwin-arm64')
  const { implementation } = stubFetch({ [target.url]: respond(gzipSync(core)) })
  await assert.rejects(
    fetchAccelerationCore(target, workspace(t), { fetchImplementation: implementation }),
    /解出的加速内核与对账表的 SHA256 不一致/,
  )
})

test('the GPL text is pinned to the same tag as the core it accompanies', async (t) => {
  // GPL v3 的正文到处都有，但随内核分发的必须是这一版对应源码里的那一份。对账
  // 表钉住它的哈希，等于把"许可来自哪个 tag"也变成可验证的事实。
  const catalog = catalogFixture()
  const target = resolveCoreTarget(catalog, 'darwin-arm64')
  const { implementation } = stubFetch({
    [target.url]: respond(gzipSync(core)),
    [target.licenseUrl]: respond(Buffer.from('GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n')),
  })
  await assert.rejects(
    fetchAccelerationCore(target, workspace(t), { fetchImplementation: implementation }),
    /许可文本与对账表的 SHA256 不一致/,
  )
})

test('a verified core and licence land as ordinary owner-only files', async (t) => {
  const directory = workspace(t)
  const catalog = catalogFixture()
  const target = resolveCoreTarget(catalog, 'darwin-arm64')
  const { implementation, seen } = stubFetch({
    [target.url]: redirect('https://objects.githubusercontent.com/mihomo.gz'),
    'https://objects.githubusercontent.com/mihomo.gz': respond(gzipSync(core)),
    [target.licenseUrl]: respond(license),
  })
  const result = await fetchAccelerationCore(target, directory, { fetchImplementation: implementation })
  assert.equal(seen.length, 3)
  assert.equal(result.corePath, path.join(directory, 'mihomo'))
  assert.deepEqual(fs.readFileSync(result.corePath), core)
  assert.deepEqual(fs.readFileSync(result.licensePath), license)
  assert.equal(result.coreSha256, digest(core))
})

test('an oversized body is refused on its declared length, before it is read', async (t) => {
  const catalog = catalogFixture()
  const target = resolveCoreTarget(catalog, 'darwin-arm64')
  const { implementation } = stubFetch({
    [target.url]: {
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(1024 * 1024 * 1024) : null) },
      arrayBuffer: async () => { throw new Error('不应该读取超限的响应体') },
    },
  })
  await assert.rejects(
    fetchAccelerationCore(target, workspace(t), { fetchImplementation: implementation }),
    /超过允许上限/,
  )
})

test('preparing a macOS bundle tells the staging step which architecture it is', async (t) => {
  // stage-acceleration-bundle 用 arch 去校验 Mach-O 头，也把它写进 manifest；传错
  // 或者不传，做出来的是一个"两个架构装同一份内核"的包。
  const root = workspace(t)
  fs.mkdirSync(path.join(root, 'bundled-acceleration'))
  fs.writeFileSync(path.join(root, 'bundled-acceleration', 'cores.json'), JSON.stringify(catalogFixture()))
  const target = resolveCoreTarget(catalogFixture(), 'darwin-arm64')
  const { implementation } = stubFetch({ [target.url]: respond(gzipSync(core)), [target.licenseUrl]: respond(license) })
  const staged = []
  const result = await prepareAccelerationBundle(
    { projectRoot: root, target: 'darwin-arm64', outputDirectory: path.join(root, 'bundle') },
    {
      fetchImplementation: implementation,
      stage: async (options, dependencies) => {
        staged.push({ options, dependencies })
        assert.deepEqual(JSON.parse(fs.readFileSync(options.configPath, 'utf8')), { version: 1, corePath: path.join(path.dirname(options.configPath), 'mihomo'), coreSha256: digest(core) })
        return { outputDirectory: options.outputDirectory, nodeCount: 12 }
      },
    },
  )
  assert.equal(staged.length, 1)
  assert.equal(staged[0].options.platform, 'darwin')
  assert.equal(staged[0].options.arch, 'arm64')
  assert.equal(staged[0].options.coreVersion, 'v1.19.29')
  assert.equal(staged[0].options.sourceRef, 'v1.19.29')
  assert.equal(staged[0].dependencies.projectRoot, root)
  // 没有 profilePath 就是"用仓库里那份节点配置"，stage 会再拿 profile.sha256 对一遍。
  assert.equal(staged[0].options.profilePath, undefined)
  assert.equal(result.nodeCount, 12)
})

test('the download workspace does not survive the run, successful or not', async (t) => {
  const root = workspace(t)
  fs.mkdirSync(path.join(root, 'bundled-acceleration'))
  fs.writeFileSync(path.join(root, 'bundled-acceleration', 'cores.json'), JSON.stringify(catalogFixture()))
  const target = resolveCoreTarget(catalogFixture(), 'darwin-arm64')
  const { implementation } = stubFetch({ [target.url]: respond(gzipSync(core)), [target.licenseUrl]: respond(license) })
  let workingDirectory
  await assert.rejects(prepareAccelerationBundle(
    { projectRoot: root, target: 'darwin-arm64', outputDirectory: path.join(root, 'bundle') },
    {
      fetchImplementation: implementation,
      stage: async (options) => {
        workingDirectory = path.dirname(options.configPath)
        throw new Error('打包失败')
      },
    },
  ), /打包失败/)
  assert.equal(fs.existsSync(workingDirectory), false)
})

test('the command line takes exactly one target and one destination', () => {
  assert.deepEqual(parseArguments(['--target', 'win32-x64', '--output', '/tmp/bundle']), { target: 'win32-x64', outputDirectory: '/tmp/bundle' })
  assert.throws(() => parseArguments([]), /缺少/)
  assert.throws(() => parseArguments(['--target', 'win32-x64']), /参数无效|缺少/)
  assert.throws(() => parseArguments(['--target', 'win32-x64', '--target', 'darwin-x64', '--output', '/tmp/b']), /参数无效/)
  assert.throws(() => parseArguments(['--target', '--output', '/tmp/b']), /参数无效/)
  assert.throws(() => parseArguments(['--wat', 'x', '--output', '/tmp/b']), /参数无效/)
})
