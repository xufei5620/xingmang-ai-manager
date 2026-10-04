const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('node:child_process')
const YAML = require('yaml')

const root = path.resolve(__dirname, '..')
const workflowPath = path.join(root, '.github', 'workflows', 'publish-release.yml')
const source = fs.readFileSync(workflowPath, 'utf8')
const workflow = YAML.parse(source)
const windowsJob = workflow.jobs['windows-build']
const macosJob = workflow.jobs['macos-build']
const linuxChecksJob = workflow.jobs['linux-checks']
const linuxBuildJob = workflow.jobs['linux-build']
const publishJob = workflow.jobs.publish
const buildJobs = [windowsJob, macosJob]
const allJobs = Object.values(workflow.jobs)
const { UPDATE_MANIFEST_NAMES } = require('./update-release-utils.cjs')
const MANIFEST_LOOP = `for manifest in ${UPDATE_MANIFEST_NAMES.join(' ')}; do`

// 已有发布凭据保留；COS 两个可选凭据只在打开镜像开关后使用。
// 名字与发布配置文档必须字字相同，否则只会得到 403 或空取值。
const RELEASE_SECRET_NAMES = [
  'COS_SECRET_ID',
  'COS_SECRET_KEY',
  'CSC_NAME',
  'R2_ACCESS_KEY_ID',
  'R2_ACCOUNT_ID',
  'R2_BUCKET',
  'R2_SECRET_ACCESS_KEY',
  'XINGMANG_MAC_SIGNING_P12_BASE64',
  'XINGMANG_MAC_SIGNING_P12_PASSWORD',
  'XINGMANG_MAC_SIGNING_SHA256',
]

function stepIndex(job, pattern) {
  return job.steps.findIndex((step) => pattern.test(`${step.name || ''}\n${step.run || ''}`))
}

function referencedSecretNames() {
  const names = new Set()
  for (const match of source.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) names.add(match[1])
  return [...names].sort()
}

test('the manifests are published last, after the installers are proven downloadable', () => {
  // latest.yml 是客户端用来判断「有没有新版本」的清单。它先落地，用户就会在安装包
  // 还没传完时被告知有新版本，点下载拿到 404。所以这三步的先后是发布正确性的一部分，
  // 不是风格问题：先传安装包与 blockmap，确认它们能从客户会用的地址下载且字节一致，
  // 最后才覆盖清单。
  const payload = stepIndex(publishJob, /Upload the installers and their blockmaps/)
  const verify = stepIndex(publishJob, /Verify the uploaded files are downloadable/)
  const manifest = stepIndex(publishJob, /Publish the update manifests/)
  const feed = stepIndex(publishJob, /update:verify-feed/)
  assert.ok(payload >= 0 && verify > payload, '下载校验必须排在安装包上传之后')
  assert.ok(manifest > verify, '清单必须排在下载校验之后')
  assert.ok(feed > manifest, '端到端复核必须排在清单发布之后')

  // 清单只能由那一步动。别的步骤顺手 cp 一次 latest.yml，上面那道顺序就形同虚设。
  // 每个平台的每份清单（Linux 两个架构各一份）都受这条约束。
  const touchingManifest = publishJob.steps.filter((step) => {
    const script = String(step.run || '')
    return /aws s3 cp/.test(script) && /latest(?:-[a-z0-9-]+)?\.yml/.test(script)
  })
  assert.equal(touchingManifest.length, 1)
  assert.match(String(touchingManifest[0].name), /Publish the update manifests/)
  // 备份与覆盖两圈都要列全 update-release-utils.cjs 登记的清单，漏一个就是那个平台
  // 没有备份可退、或者新清单根本没发出去。
  const loops = String(touchingManifest[0].run).split(MANIFEST_LOOP).length - 1
  assert.equal(loops, 2, `清单那一步的两圈都必须是「${MANIFEST_LOOP}」`)
})

test('every platform gets its published feed re-verified end to end', () => {
  // 只复核 Windows 那一半的话，一次传坏的 latest-mac.yml 要等客户点更新才暴露。
  const feeds = publishJob.steps.filter((step) => /update:verify-feed/.test(String(step.run || '')))
  assert.deepEqual(
    feeds.map((step) => String(step.run).trim()),
    [
      'npm run update:verify-feed -- --platform=windows',
      'npm run update:verify-feed -- --platform=macos',
      'npm run update:verify-feed -- --platform=linux',
    ],
  )
  // Linux 只在开关打开、这次真的发了 Linux 时复核；关着时线上没有 Linux 清单，复核
  // 必然 404。
  assert.equal(feeds[2].if, "${{ vars.XINGMANG_PUBLISH_LINUX == 'true' && needs.linux-build.result == 'success' }}")
})

test('uploading is gated on the release environment, which is where the owner approves', () => {
  // RELEASING.md 要求「上传文件、修改 R2 或切换线上 latest.yml 必须获得产品所有者
  // 针对当前版本的明确发布授权」。这条工作流把那道授权实现为 release 环境的
  // required reviewers：批准的就是这一次运行、这一个版本。少了这一行，凭据会对
  // 任意分支可见，而 workflow_dispatch 允许指定任意 ref。
  assert.equal(publishJob.environment, 'release')
  assert.equal(publishJob.permissions.contents, 'write')
  assert.equal(workflow.permissions.contents, 'read')
  assert.deepEqual(Object.keys(workflow.permissions), ['contents'])
})

test('the workflow reads exactly the secrets the owner was told to create', () => {
  assert.deepEqual(referencedSecretNames(), RELEASE_SECRET_NAMES)
})

test('COS synchronization runs as its own job after an approved publish and keeps its credentials in one opt-in step', () => {
  // 0.2.15 的 709 MB 往 COS 上海传了一个多小时，塞在 60 分钟的 publish 里传不完。
  // 单独成作业才有足够的时间，失败了也能只重跑它，不用再批一次、不再碰 R2。
  const cosJob = workflow.jobs['cos-sync']
  assert.equal(stepIndex(publishJob, /Tencent COS|sync-manager-release-cos/), -1)
  assert.deepEqual(cosJob.needs, ['publish', 'windows-build', 'macos-build', 'linux-build'])
  // 只认 publish 成功：那一下 Approve 放行的就是这一版。
  const runs = (publish, vars = { XINGMANG_COS_SYNC_ENABLED: 'true' }) => evaluateCondition(cosJob.if, {
    needs: { publish, 'windows-build': 'success', 'macos-build': 'skipped' },
    vars,
  })
  assert.equal(runs('success'), true)
  for (const result of ['failure', 'skipped', 'cancelled']) assert.equal(runs(result), false, result)
  for (const vars of [{}, { XINGMANG_COS_SYNC_ENABLED: 'false' }, { XINGMANG_COS_SYNC_ENABLED: '' }]) {
    assert.equal(runs('success', vars), false, JSON.stringify(vars))
  }
  // 挂 cos-sync 而不是 release：不多一次批准，也拿不到 R2 和证书。
  assert.equal(cosJob.environment, 'cos-sync')
  assert.equal(cosJob.permissions, undefined)
  assert.doesNotMatch(YAML.stringify(cosJob), /aws s3|R2_|XINGMANG_MAC_SIGNING|CSC_NAME|gh release/)
  // 和手动导入共用一个组（两边都写 xingmang/latest.json），不进 update-feed。
  assert.deepEqual(cosJob.concurrency, { group: 'cos-manager-publish', 'cancel-in-progress': false })
  // GitHub 托管的作业最长 6 小时。
  assert.ok(cosJob['timeout-minutes'] >= 300 && cosJob['timeout-minutes'] < 360, String(cosJob['timeout-minutes']))
  // publish 发了哪些平台就同步哪些。
  const downloads = (job) => job.steps.filter((step) => /actions\/download-artifact@/.test(String(step.uses || '')))
  assert.deepEqual(downloads(cosJob), downloads(publishJob))
  assert.equal(cosJob.env.PACKAGE_VERSION, publishJob.env.PACKAGE_VERSION)
  const index = stepIndex(cosJob, /Synchronize the successful release to Tencent COS/)
  assert.ok(index > Math.max(...downloads(cosJob).map((step) => cosJob.steps.indexOf(step))))
  assert.equal(cosJob.steps[index].if, undefined)
  assert.equal(cosJob.steps[index].run, 'node scripts/sync-manager-release-cos.cjs --directory release-artifacts --version "$PACKAGE_VERSION"')
  assert.deepEqual(cosJob.steps[index].env, {
    COS_BUCKET: "${{ vars.COS_BUCKET || 'xingmang-downloads-1342302199' }}",
    COS_REGION: "${{ vars.COS_REGION || 'ap-shanghai' }}",
    COS_SECRET_ID: '${{ secrets.COS_SECRET_ID }}',
    COS_SECRET_KEY: '${{ secrets.COS_SECRET_KEY }}',
    XINGMANG_COS_MULTIPART_ENABLED: "${{ vars.XINGMANG_COS_MULTIPART_ENABLED || 'false' }}",
    XINGMANG_COS_MULTIPART_CONCURRENCY: "${{ vars.XINGMANG_COS_MULTIPART_CONCURRENCY || '8' }}",
    XINGMANG_COS_ACCELERATE: "${{ vars.XINGMANG_COS_ACCELERATE || 'false' }}",
  })
  const readers = allJobs.flatMap((job) => job.steps)
    .filter((step) => /secrets\.COS_SECRET_(?:ID|KEY)/.test(YAML.stringify(step)))
  assert.deepEqual(readers, [cosJob.steps[index]])
  for (const job of [cosJob, publishJob]) {
    assert.equal(job.env.COS_SECRET_ID, undefined)
    assert.equal(job.env.COS_SECRET_KEY, undefined)
  }
  assert.equal(workflow.on.release, undefined)
})

test('the Windows build job holds no credentials at all', () => {
  // Windows 那一份是无签名发布，出包不需要任何 secret。少一个作业能读到凭据，
  // 「谁能读到证书和 R2 密钥」这个问题就少一个答案。
  assert.equal(windowsJob.environment, undefined)
  assert.equal(windowsJob.permissions, undefined)
  assert.doesNotMatch(YAML.stringify(windowsJob), /secrets\./)
})

test('the Linux jobs hold no credentials and need no approval', () => {
  // Linux 不签名，出包与测试都用不到任何 secret；挂上 release 环境就会平白多出一次
  // 只有产品所有者能点的批准，而且是在他还没决定发 Linux 的时候。
  for (const job of [linuxChecksJob, linuxBuildJob]) {
    assert.equal(job.environment, undefined)
    assert.equal(job.permissions, undefined)
    assert.doesNotMatch(YAML.stringify(job), /secrets\./)
  }
})

test('the macOS build job reads the signing identity and nothing else', () => {
  // 它必须读 .p12，所以也挂 release 环境、也停下来等一次批准；但 R2 凭据与它无关。
  assert.equal(macosJob.environment, 'release')
  assert.equal(macosJob.permissions, undefined)
  const macosSecrets = new Set(
    [...YAML.stringify(macosJob).matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((match) => match[1]),
  )
  assert.deepEqual([...macosSecrets].sort(), [
    'CSC_NAME',
    'XINGMANG_MAC_SIGNING_P12_BASE64',
    'XINGMANG_MAC_SIGNING_P12_PASSWORD',
    'XINGMANG_MAC_SIGNING_SHA256',
  ])
})

test('the macOS signing keychain is always torn down, even when the build fails', () => {
  // 用户 keychain 搜索列表是全局状态，私钥落在 runner 磁盘上。构建失败或作业取消
  // 时跳过撤销，等于把签名私钥留给这台 runner 上后续的一切。
  const importIndex = stepIndex(macosJob, /macos-release-keychain\.cjs --import/)
  const buildIndex = stepIndex(macosJob, /dist:mac:free/)
  const releaseIndex = stepIndex(macosJob, /macos-release-keychain\.cjs --release/)
  assert.ok(importIndex >= 0 && importIndex < buildIndex, '导入必须排在构建之前')
  assert.ok(releaseIndex > buildIndex, '撤销必须排在构建之后')
  assert.equal(macosJob.steps[releaseIndex].if, '${{ always() }}')
})

test('the macOS packages are signed with the published identity, never an ephemeral one', () => {
  // 一次性身份签出来的包进了更新源，老用户的机器不认它会拒绝更新，新装用户拿到的
  // 又是一个没人认得的发布者。package-for-testing 才是那条路径。
  const build = macosJob.steps.find((step) => /dist:mac:free/.test(String(step.run || '')))
  assert.doesNotMatch(String(build.run), /--ci-temporary-signing/)
  assert.match(String(build.run), /--acceleration-arm64/)
  assert.match(String(build.run), /--acceleration-x64/)
  // 排练开关把台账对账的对象换成一张一次性证书。它在 PR 上是必要的，在这条工作流
  // 里出现就等于把「换证书会断掉全部已装 Mac 客户的自动更新」那道核对拆掉。
  // createRehearsalSigningLedger 已经拒绝真指纹，这一条挡的是别的写法。
  assert.doesNotMatch(JSON.stringify(workflow), /--rehearsal-identity/)
})

test('no dispatch input, secret or step output is substituted into a shell script', () => {
  // P-26：run 块里的 ${{ ... }} 是在 shell 解析之前做的文本替换。取值里的一个单引号
  // 就能闭合字符串并执行后面的内容 —— 在这条工作流里，那是持有发布凭据的那台机器。
  for (const job of allJobs) {
    for (const step of job.steps) {
      const script = String(step.run || '')
      if (!script) continue
      assert.doesNotMatch(script, /\$\{\{/, `${step.name || step.uses}：把取值绑进 env: 再读`)
    }
  }
})

test('the secrets are only ever bound, never echoed', () => {
  // 一次 echo 就把凭据写进了任何有仓库读权限的人都能看的运行日志里。
  for (const job of [macosJob, publishJob]) {
    for (const step of job.steps) {
      const script = String(step.run || '')
      assert.doesNotMatch(
        script,
        /echo\s+"?\$(AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|R2_ACCOUNT_ID|XINGMANG_MAC_SIGNING_P12_BASE64|XINGMANG_MAC_SIGNING_P12_PASSWORD)/,
        step.name,
      )
    }
  }
})

test('every third-party action is pinned to a full commit id', () => {
  for (const step of allJobs.flatMap((job) => job.steps)) {
    if (!step.uses) continue
    assert.match(step.uses, /@[0-9a-f]{40}$/, `${step.uses} 必须钉到完整提交号`)
  }
})

test('the build goes through the same release gate as a local release, with the lines carried', () => {
  const build = windowsJob.steps.find((step) => /release:build/.test(String(step.run || '')))
  assert.equal(String(build.run).trim(), 'npm run release:build:unsigned')
  assert.equal(build.env.XINGMANG_ACCELERATION_BUNDLE_DIR, '${{ runner.temp }}\\acceleration-win32-x64')
  const windowsPrepare = windowsJob.steps.filter((step) => /prepare-acceleration-bundle\.cjs/.test(String(step.run || '')))
  assert.equal(windowsPrepare.length, 1)
  // Mac 两个架构各要一份：资源清单里记着架构，内核也是按架构的 Mach-O。
  const macosPrepare = macosJob.steps.find((step) => /prepare-acceleration-bundle\.cjs/.test(String(step.run || '')))
  assert.match(String(macosPrepare.run), /--target darwin-arm64/)
  assert.match(String(macosPrepare.run), /--target darwin-x64/)
})

test('the Linux debs go through their own release gate, one native runner per architecture', () => {
  const build = linuxBuildJob.steps.find((step) => /release:package:linux/.test(String(step.run || '')))
  assert.equal(String(build.run).trim(), 'npm run release:package:linux -- --arch "$PACKAGE_ARCH"')
  assert.equal(linuxBuildJob.env.PACKAGE_ARCH, '${{ matrix.arch }}')
  assert.equal(linuxBuildJob.needs, 'linux-checks')
  // x64 机器装不了 arm64 的包，模拟器里起 Electron 也说明不了真机。
  assert.deepEqual(linuxBuildJob.strategy.matrix.include, [
    { arch: 'x64', runner: 'ubuntu-24.04' },
    { arch: 'arm64', runner: 'ubuntu-24.04-arm' },
  ])
  assert.equal(linuxBuildJob.strategy['fail-fast'], false)
  // 第一版 Linux 不带加速：没有 Linux 的加速内核，出包门禁也会把这个变量清掉。
  assert.doesNotMatch(YAML.stringify(linuxBuildJob), /acceleration/i)
  // release:build:unsigned 里会跑的那几套测试，Linux 在 linux-checks 里跑一遍。
  const checks = linuxChecksJob.steps.map((step) => String(step.run || '').trim())
  for (const command of ['npm run typecheck', 'npm test', 'npm run test:v2', 'npm run test:canvas', 'npm run test:ui']) {
    assert.ok(checks.includes(command), `linux-checks must run ${command}`)
  }
})

test('a Linux deb is installed, launched and removed like a customer would before it is uploaded', () => {
  const install = stepIndex(linuxBuildJob, /apt-get install/)
  const smoke = stepIndex(linuxBuildJob, /linux-deb-smoke\.mjs/)
  const hardening = stepIndex(linuxBuildJob, /packaged-hardening-smoke\.mjs/)
  const removal = stepIndex(linuxBuildJob, /apt-get remove/)
  const upload = linuxBuildJob.steps.findIndex((step) => /upload-artifact/.test(String(step.uses || '')))
  const build = stepIndex(linuxBuildJob, /release:package:linux/)
  assert.ok(build >= 0 && install > build && smoke > install && hardening > install && removal > hardening && upload > removal)
  // 上传的名字和 publish 作业下载时用的通配符必须对得上，否则开关打开了也下不到包。
  const uploaded = linuxBuildJob.steps[upload].with
  assert.equal(uploaded.name, 'linux-release-${{ matrix.arch }}-${{ steps.metadata.outputs.version }}')
  assert.match(uploaded.path, /\*\.deb/)
  assert.match(uploaded.path, /latest-linux\*\.yml/)
  const download = publishJob.steps.find((step) => /download-artifact/.test(String(step.uses || '')) && step.with?.pattern)
  assert.equal(download.with.pattern, 'linux-release-*-${{ needs.linux-build.outputs.version }}')
  assert.equal(download.with['merge-multiple'], true)
})

test('both jobs compile the main process before staging the acceleration bundles', () => {
  // prepare-acceleration-bundle.cjs 用的是主进程里那套安全读写与内核校验，没有
  // dist-electron 就在第一秒报「请先编译主进程」。2026-09-20 的首次正式发布就红在
  // 这里：Windows 那半条有这一步，照抄到 macOS 时漏了，而两个出包作业的步骤不一样，
  // 光看一边看不出来。
  for (const job of buildJobs) {
    const compile = stepIndex(job, /tsconfig\.electron\.json|npm run compile/)
    const prepare = stepIndex(job, /prepare-acceleration-bundle\.cjs/)
    assert.ok(compile >= 0, `${job.steps[0].uses}：缺少编译主进程这一步`)
    assert.ok(compile < prepare, '编译主进程必须排在准备加速资源之前')
  }
})

test('the requested version must match package.json before anything is built', () => {
  // 误发一个版本号的代价是线上 latest.yml 指向一个不存在或不该发的产物。
  for (const job of [...buildJobs, linuxBuildJob]) {
    const confirm = stepIndex(job, /Confirm the requested version/)
    const build = stepIndex(job, /release:build|dist:mac:free|release:package:linux/)
    assert.ok(confirm >= 0 && confirm < build)
  }
  const checksConfirm = stepIndex(linuxChecksJob, /Confirm the requested version/)
  assert.ok(checksConfirm >= 0 && checksConfirm < stepIndex(linuxChecksJob, /npm ci/))
  assert.equal(workflow.on.workflow_dispatch.inputs.confirm_version.required, true)
})

test('a single-platform publish does not silently skip the publish job', () => {
  // 被跳过的 needs 默认会把依赖它的作业也跳过，表现是「跑完了但什么都没发」。
  assert.deepEqual(publishJob.needs, ['release-tag', 'windows-build', 'macos-build', 'linux-checks', 'linux-build'])
  assert.match(String(publishJob.if), /!cancelled\(\)/)
  assert.match(String(publishJob.if), /needs\.release-tag\.result == 'success'/)
  assert.match(String(publishJob.if), /windows-build\.result != 'failure'/)
  assert.match(String(publishJob.if), /macos-build\.result != 'failure'/)
  assert.match(String(publishJob.if), /== 'success'/)
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.platforms.options, ['all', 'both', 'windows', 'macos', 'linux'])
  assert.equal(workflow.on.workflow_dispatch.inputs.platforms.default, 'all')
})

// 把作业与步骤上的 if 表达式按 GitHub 的规则算出来：needs 没跑就是 skipped，仓库变量
// 没建就是空串，字符串比较不分大小写。只认这几种写法，出现别的标识符就报错，免得
// 表达式改了而这里悄悄算错。
function evaluateCondition(expression, { inputs = {}, needs = {}, vars = {} }) {
  const body = String(expression).trim().replace(/^\$\{\{/, '').replace(/\}\}$/, '')
  const literal = (value) => JSON.stringify(String(value ?? '').toLowerCase())
  const javascript = body
    .replace(/!cancelled\(\)/g, 'true')
    .replace(/needs\.([a-z-]+)\.result/g, (_, id) => literal(needs[id] ?? 'skipped'))
    .replace(/vars\.([A-Za-z0-9_]+)/g, (_, name) => literal(vars[name]))
    .replace(/inputs\.([a-z_]+)/g, (_, name) => literal(inputs[name]))
    .replace(/'([^']*)'/g, (_, text) => JSON.stringify(text.toLowerCase()))
  const leftover = javascript.replace(/"[^"]*"/g, '').replace(/\btrue\b/g, '')
  assert.match(leftover, /^[\s()&|!=]*$/, `认不出的表达式：${body}`)
  return Function(`return (${javascript})`)()
}

test('each platform choice builds exactly its own jobs', () => {
  // 原来的写法是「不是 macos 就出 Windows」；多一个 linux 选项后，只选 linux 也会把
  // Windows 和 Mac 一起出一遍，Mac 那一半还要等一次批准。
  const expected = {
    all: ['windows-build', 'macos-build', 'linux-checks'],
    // 加 Linux 之前的默认值：照老习惯选它，还是原来的 Windows 与 macOS，不碰 Linux。
    both: ['windows-build', 'macos-build'],
    windows: ['windows-build'],
    macos: ['macos-build'],
    linux: ['linux-checks'],
  }
  for (const platforms of workflow.on.workflow_dispatch.inputs.platforms.options) {
    const started = Object.entries(workflow.jobs)
      .filter(([, job]) => job.if && job.needs === 'release-tag')
      .filter(([, job]) => evaluateCondition(job.if, { inputs: { platforms } }))
      .map(([id]) => id)
    assert.deepEqual(started, expected[platforms], platforms)
  }
  // linux-build 没有自己的 if：linux-checks 被跳过或失败，它就跟着跳过。
  assert.equal(linuxBuildJob.if, undefined)
})

test('Linux only reaches customers once the repository switch is on', () => {
  // tag 占好（release-tag 成功）是发布的前提，下面单独有一条测它；这里只看平台。
  const publishes = (needs, vars = {}, platforms = 'all') => evaluateCondition(publishJob.if, {
    needs: { 'release-tag': 'success', ...needs },
    vars,
    inputs: { platforms },
  })
  const ok = { 'windows-build': 'success', 'macos-build': 'success' }
  const linuxOk = { 'linux-checks': 'success', 'linux-build': 'success' }
  const linuxBuildRed = { 'linux-checks': 'success', 'linux-build': 'failure' }
  const linuxChecksRed = { 'linux-checks': 'failure', 'linux-build': 'skipped' }
  // 作业超过自己的 timeout-minutes 结束时是 cancelled，不是 failure。
  const linuxChecksTimedOut = { 'linux-checks': 'cancelled', 'linux-build': 'skipped' }
  const linuxBuildTimedOut = { 'linux-checks': 'success', 'linux-build': 'cancelled' }
  const on = { XINGMANG_PUBLISH_LINUX: 'true' }

  for (const vars of [{}, { XINGMANG_PUBLISH_LINUX: 'false' }, { XINGMANG_PUBLISH_LINUX: '' }]) {
    const label = JSON.stringify(vars)
    // 开关关着：Linux 红了也不挡 Windows / macOS。
    assert.equal(publishes({ ...ok, ...linuxOk }, vars), true, label)
    assert.equal(publishes({ ...ok, ...linuxBuildRed }, vars), true, label)
    assert.equal(publishes({ ...ok, ...linuxChecksRed }, vars), true, label)
    assert.equal(publishes({ ...ok, ...linuxChecksTimedOut }, vars), true, label)
    // 只选了 linux：整个发布作业跳过，连批准都不会要。
    assert.equal(publishes(linuxOk, vars, 'linux'), false, label)
  }

  // 开关打开：Linux 和别的平台一样，红了就不发。linux-checks 失败时 linux-build 是
  // skipped 而不是 failure，这一种也必须挡住。
  assert.equal(publishes({ ...ok, ...linuxOk }, on), true)
  assert.equal(publishes({ ...ok, ...linuxBuildRed }, on), false)
  assert.equal(publishes({ ...ok, ...linuxChecksRed }, on), false)
  // 超时也一样挡住：只挡 failure 的话，Windows / macOS 会悄悄不带 Linux 发出去。
  assert.equal(publishes({ ...ok, ...linuxChecksTimedOut }, on), false)
  assert.equal(publishes({ ...ok, ...linuxBuildTimedOut }, on), false)
  assert.equal(publishes(linuxOk, on, 'linux'), true)
  assert.equal(publishes(linuxChecksRed, on, 'linux'), false)
  assert.equal(publishes(linuxBuildTimedOut, on, 'linux'), false)
  // 只发 Windows 或 macOS（含老的 both）时 Linux 两个作业都是 skipped，不算失败。
  assert.equal(publishes(ok, on, 'both'), true)
  assert.equal(publishes(ok, {}, 'both'), true)
  assert.equal(publishes({ 'windows-build': 'success' }, on, 'windows'), true)
  assert.equal(publishes({ 'macos-build': 'success' }, on, 'macos'), true)
  // GitHub 比较字符串不分大小写，文档照这个写：TRUE 也算打开。
  assert.equal(publishes({ ...ok, ...linuxBuildRed }, { XINGMANG_PUBLISH_LINUX: 'TRUE' }), false)
  // 原有的规则不变：任何一个 Windows / macOS 出包失败都不发。
  assert.equal(publishes({ 'windows-build': 'failure', 'macos-build': 'success', ...linuxOk }, on), false)
  assert.equal(publishes({ 'windows-build': 'success', 'macos-build': 'failure' }, {}), false)

  // 关着时 Linux 的包连下载都不下载，下面的护栏、上传、清单、Release 附件就都碰不到它。
  const download = publishJob.steps.find((step) => /download-artifact/.test(String(step.uses || '')) && step.with?.pattern)
  assert.equal(evaluateCondition(download.if, { needs: linuxOk }), false)
  assert.equal(evaluateCondition(download.if, { needs: linuxOk, vars: on }), true)
  assert.equal(evaluateCondition(download.if, { needs: { 'linux-checks': 'success', 'linux-build': 'skipped' }, vars: on }), false)
  // 开关是仓库变量而不是代码里的常量：只有能改仓库设置的人能打开，线程合进来的代码
  // 打不开它。
  assert.doesNotMatch(source, /XINGMANG_PUBLISH_LINUX\s*:/)
})

test('two publishes cannot run at once', () => {
  // 同版本两套不同哈希的产物，而 latest.yml 里只能有一份 SHA-512。
  assert.equal(workflow.concurrency.group, 'publish-release')
  assert.equal(workflow.concurrency['cancel-in-progress'], false)
})

test('every job that writes the update feed shares one concurrency group', () => {
  // #492：发布、回滚、维护开关都是「读线上 → 算新内容 → 写回去」。并发组不同的话，
  // 回滚刚把清单换回旧版，发布又把新版盖上去，撤回名单里却还写着它。这里扫全部
  // 工作流而不是点名三个作业，以后新加一条往 R2 写东西的工作流也逃不掉。
  const workflowsDir = path.join(root, '.github', 'workflows')
  const writers = []
  for (const file of fs.readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name)).sort()) {
    const parsed = YAML.parse(fs.readFileSync(path.join(workflowsDir, file), 'utf8'))
    for (const [id, job] of Object.entries(parsed.jobs || {})) {
      if (!(job.steps || []).some((step) => /\baws s3\b/.test(String(step.run || '')))) continue
      writers.push(`${file}#${id}`)
      assert.equal(job.concurrency?.group, 'update-feed', `${file}#${id} must join the update-feed group`)
      assert.equal(job.concurrency?.['cancel-in-progress'], false, `${file}#${id} must never cancel a write in progress`)
      // 组挂在作业上。工作流级再挂一个同名组，publish-release 出包的一个多小时里
      // 就会一直挡着维护开关。
      assert.notEqual(parsed.concurrency?.group, 'update-feed', `${file} must hold the group per job`)
    }
  }
  assert.deepEqual(writers, ['publish-release.yml#publish', 'rollback-release.yml#rollback', 'service-status.yml#publish'])
})

// tag 在触发时就占上（0.2.14 的收尾两次都是 HTTP 403）：作业用的 GITHUB_TOKEN 拿不到
// workflows 权限，出包之后 main 只要合进一个改 .github/workflows 的提交，GitHub 就不让
// 它在出包的 commit 上建 tag，建 Release 时传的 target_commitish 也一样被拒，原因见
// scripts/release-tag-plan.cjs 开头。占 tag 的是第一个作业 release-tag，先判断、再动手，
// 出包作业都等它。
const { ReleaseTagPlanError, planReleaseTag } = require('./release-tag-plan.cjs')

const tagJob = workflow.jobs['release-tag']
const planStep = tagJob.steps.find((step) => step.id === 'plan')
const reserveStep = tagJob.steps.find((step) => /Reserve the release tag/.test(step.name || ''))
const SHIPPED = 'a'.repeat(40)
const EARLIER = 'b'.repeat(40)
// 附注 tag 的 ref 指向 tag 对象而不是 commit，要再解一层。
const TAG_OBJECT_SHA = 'f'.repeat(40)

// 注释行不算：注释里会说明为什么不用某种写法。
function commandLines(script) {
  return String(script || '').split('\n').filter((line) => line.trim() && !/^\s*#/.test(line))
}

test('the release tag is reserved before anything is built', () => {
  // 出包作业不等它的话，tag 要到一个多小时之后才建，又回到 0.2.14 的样子。
  assert.equal(tagJob.needs, undefined)
  for (const job of [windowsJob, macosJob, linuxChecksJob]) {
    assert.equal(job.needs, 'release-tag')
    // if 里写了 always() 之类，占 tag 失败了照样出包。
    assert.doesNotMatch(String(job.if), /always\(\)|failure\(\)|cancelled\(\)/)
  }
  // 不设 if：被跳过会把后面的作业全部带着跳过，表现是「什么都没出」。
  assert.equal(tagJob.if, undefined)
  // 先判断、再动手，判断失败时动手那一步不跑。
  assert.ok(tagJob.steps.indexOf(planStep) >= 0 && tagJob.steps.indexOf(reserveStep) > tagJob.steps.indexOf(planStep))
  for (const step of [planStep, reserveStep]) {
    assert.equal(step.if, undefined)
    assert.equal(step['continue-on-error'], undefined)
  }
  // tag 没占好时收尾那一步不能跑起来，那样它又要自己去建 tag。
  const publishes = (reserved) => evaluateCondition(publishJob.if, {
    needs: { 'release-tag': reserved, 'windows-build': 'success', 'macos-build': 'success' },
    inputs: { platforms: 'both' },
  })
  assert.equal(publishes('success'), true)
  for (const reserved of ['failure', 'skipped', 'cancelled']) assert.equal(publishes(reserved), false, reserved)
})

test('only the tag job and the approved publish job can write to the repository', () => {
  const writers = Object.entries(workflow.jobs)
    .filter(([, job]) => job.permissions?.contents === 'write')
    .map(([id]) => id)
  assert.deepEqual(writers, ['release-tag', 'publish'])
  assert.deepEqual(tagJob.permissions, { contents: 'write' })
  assert.equal(tagJob.environment, undefined)
  assert.doesNotMatch(YAML.stringify(tagJob), /secrets\./)
})

test('the tag job installs nothing, so no third-party code ever holds its write token', () => {
  // 批准之前就拿着写权限的只有它。装了依赖，任何一个包的安装脚本、被 require 到的代码
  // 都拿得到这个令牌，所以它只跑 gh、curl 和仓库里不依赖第三方包的脚本；下面跑判断那一步
  // 时也不给它 node_modules。
  for (const step of tagJob.steps) {
    for (const line of commandLines(step.run)) assert.doesNotMatch(line, /^\s*(?:npm|npx|yarn|pnpm|corepack)\b/, line)
    if (/actions\/setup-node@/.test(String(step.uses || ''))) assert.equal(step.with?.cache, undefined)
    if (/actions\/checkout@/.test(String(step.uses || ''))) assert.equal(step.with?.['persist-credentials'], false)
  }
  for (const line of commandLines(reserveStep.run)) {
    assert.doesNotMatch(line, /^\s*(?:node|git)\b/, line)
    // 不用 PATCH 改 ref：那等于推一次从旧提交到新提交的更新，两次触发之间合进过改
    // 工作流的提交就会被拒。
    assert.doesNotMatch(line, /--method PATCH|force=/, line)
  }
  for (const line of commandLines(planStep.run)) assert.doesNotMatch(line, /--method|^\s*git\b|gh release/, line)
  // 线上每一份清单都要看：漏一个平台，那个平台已经发过这一版也会被当成没发过。
  assert.ok(String(planStep.run).includes(MANIFEST_LOOP), `判断那一步要列全清单：「${MANIFEST_LOOP}」`)
})

test('the tag plan creates, keeps or moves the tag only while the version has never shipped', () => {
  const plan = (options) => planReleaseTag({ version: '0.2.15', shippedSha: SHIPPED, ...options })
  const older = {
    'latest.yml': manifestText('0.2.14', 'windows'),
    'latest-mac.yml': manifestText('0.2.14', 'mac', 'XingMang-AI-Manager-0.2.14-arm64-mac.zip'),
  }
  assert.deepEqual(plan({}), { action: 'create' })
  assert.deepEqual(plan({ liveManifests: older, statusText: JSON.stringify({ badVersions: ['0.2.10'] }) }), { action: 'create' })
  // 重跑，或者同一个提交上补发另一个平台：Release 和线上清单都已经是这一版也照样留着。
  assert.deepEqual(plan({ tagTarget: SHIPPED, releaseExists: true, liveManifests: { 'latest.yml': manifestText('0.2.15', 'windows') } }), { action: 'keep' })
  // 上一次触发占了 tag、没发出去就取消，合进修复后重新触发（「补进来重出包」）。
  assert.deepEqual(plan({ tagTarget: EARLIER, liveManifests: older }), { action: 'move', from: EARLIER })
  // 这个作业不装 yaml，清单只读最外层的 version 一行；带引号、带注释也认得。
  assert.deepEqual(plan({ tagTarget: EARLIER, liveManifests: { 'latest.yml': "version: '0.2.14' # 上一版\nfiles: []\n" } }), { action: 'move', from: EARLIER })
})

test('the tag plan refuses a version that already shipped or was withdrawn', () => {
  const plan = (options) => planReleaseTag({ version: '0.2.15', shippedSha: SHIPPED, ...options })
  // GitHub 上已经有这一版的 Release：tag 指着当初发的那个提交，绝不挪。
  assert.throws(() => plan({ tagTarget: EARLIER, releaseExists: true }), /v0\.2\.15 已经从 bbbbbbb 发过/)
  // 没有 Release 却已经上过更新源（收尾那一步失败过）：一样不挪。
  assert.throws(
    () => plan({ tagTarget: EARLIER, liveManifests: { 'latest-mac.yml': manifestText('0.2.15', 'mac', 'XingMang-AI-Manager-0.2.15-arm64-mac.zip') } }),
    /v0\.2\.15 已经从 bbbbbbb 上过更新源/,
  )
  // 线上是这一版却没有 tag：说不清当初是从哪个提交发的，建在这次的提交上可能就建错了。
  assert.throws(() => plan({ liveManifests: { 'latest.yml': manifestText('0.2.15', 'windows') } }), /仓库里却没有 v0\.2\.15/)
  assert.throws(
    () => plan({ liveManifests: { 'latest-linux-arm64.yml': manifestText('0.2.16', 'deb', 'xingmang-ai-manager_0.2.16_arm64.deb') } }),
    /更高的 0\.2\.16/,
  )
  // #548：撤回过的版本。
  assert.throws(() => plan({ statusText: JSON.stringify({ badVersions: ['v0.2.15'] }) }), /0\.2\.15 已经被撤回/)
  assert.throws(() => plan({ tagTarget: EARLIER, statusText: JSON.stringify({ badVersions: ['0.2.15'] }) }), /已经被撤回/)
  // tag 就在这次的提交上也一样：撤回过的、线上已经更高的版本，同一个提交也不能再发。
  assert.throws(() => plan({ tagTarget: SHIPPED, statusText: JSON.stringify({ badVersions: ['0.2.15'] }) }), /已经被撤回/)
  assert.throws(() => plan({ tagTarget: SHIPPED, liveManifests: { 'latest.yml': manifestText('0.2.16', 'windows') } }), /更高的 0\.2\.16/)
  // 查不清的一律当成「不能动」，不当成「没有」。
  assert.throws(() => plan({ liveManifests: { 'latest.yml': '<!doctype html><html></html>' } }), /latest\.yml 读回来看不懂/)
  // 没有 version 那一行、有两行、只在缩进里出现、或者不是版本号，都算看不懂。
  for (const text of ['files: []\n', 'version: 0.2.14\nversion: 0.2.15\n', 'files:\n  - version: 0.2.15\n', 'version: 0.2.x\n']) {
    assert.throws(() => plan({ liveManifests: { 'latest.yml': text } }), /latest\.yml 读回来看不懂/, JSON.stringify(text))
  }
  assert.throws(() => plan({ statusText: '<!doctype html><html></html>' }), /service-status\.json 读回来看不懂/)
  assert.throws(() => plan({ statusText: JSON.stringify({ badVersions: '0.2.15' }) }), /撤回名单格式不对/)
  const malformed = [
    { version: '0.2' },
    { version: '0.2.15\naction=move' },
    { shippedSha: 'main' },
    { tagTarget: 'refs/heads/main' },
    { tagTarget: `${EARLIER}\n` },
  ]
  for (const options of malformed) assert.throws(() => plan(options), ReleaseTagPlanError, JSON.stringify(options))
})

// 下面把工作流里的那几段 `run` 真的跑起来，所以要一个 POSIX shell 和能当可执行文件用的
// 打桩脚本。这几个作业都 runs-on: ubuntu-latest，这些脚本永远不会在 Windows 上执行，
// 所以 Windows 分片上跳过的是「跑不起来的环境」，不是「在 Windows 上不成立的断言」——
// Linux 与 macOS 分片照跑，覆盖没有减少。
const SHELL_PATH = '/bin/bash'
const shellUnavailable = process.platform === 'win32' || !fs.existsSync(SHELL_PATH)
const posixOnly = { skip: shellUnavailable && `需要 ${SHELL_PATH}，这几个作业只在 ubuntu-latest 上跑` }

function readOutputs(file) {
  const outputs = {}
  if (!fs.existsSync(file)) return outputs
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const separator = line.indexOf('=')
    if (separator > 0) outputs[line.slice(0, separator)] = line.slice(separator + 1)
  }
  return outputs
}

// 判断那一步在没有 node_modules 的地方跑：这个作业不装依赖，脚本哪天在顶层 require 了
// 第三方包，要到发布那天才会在这一步炸掉。复制一份 scripts 而不是链接过去：Node 顺着
// 链接的真实路径往上找，还是会找到仓库里的 node_modules。
let scriptsWithoutDependencies = null
test.after(() => {
  if (scriptsWithoutDependencies) fs.rmSync(path.dirname(scriptsWithoutDependencies), { recursive: true, force: true })
})

function copyScriptsWithoutDependencies() {
  if (!scriptsWithoutDependencies) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-publish-scripts-'))
    fs.cpSync(path.join(root, 'scripts'), path.join(directory, 'scripts'), { recursive: true })
    scriptsWithoutDependencies = path.join(directory, 'scripts')
  }
  return scriptsWithoutDependencies
}

// 判断那一步：gh 桩按 matching-refs / git/tags / releases 回话，curl 桩从一个本地「更新
// 目录」取文件，取不到时和真的服务器一样把 404 页面写进输出文件。两个列表接口都分页：
// 不带 --paginate 只回第一页，而要找的那一项总排在后面。
function runPlanStep({
  version = '0.2.15',
  confirm = version,
  platforms = 'all',
  publishLinux = '',
  ref = 'refs/heads/main',
  tagSha = null,
  annotated = false,
  lookupFails = false,
  releases = [],
  olderReleases = 0,
  releasesFail = false,
  live = {},
  liveCodes = {},
} = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-publish-plan-'))
  const binDirectory = path.join(workspace, 'bin')
  const served = path.join(workspace, 'served')
  for (const directory of [binDirectory, served]) fs.mkdirSync(directory)
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ version }))
  fs.symlinkSync(copyScriptsWithoutDependencies(), path.join(workspace, 'scripts'))
  for (const [name, text] of Object.entries(live)) fs.writeFileSync(path.join(served, name), text)
  const logPath = path.join(workspace, 'commands.log')
  const outputPath = path.join(workspace, 'github-output')
  // matching-refs 按前缀匹配：v0.2.150 也会被列出来，只能认完整的 ref 名。
  const firstRefPage = `printf 'refs/tags/v%s0 commit %s\\n' ${JSON.stringify(version)} ${JSON.stringify('c'.repeat(40))}`
  const laterRefPages = tagSha === null
    ? ':'
    : `printf 'refs/tags/v%s %s %s\\n' ${JSON.stringify(version)} ${annotated ? `tag ${JSON.stringify(TAG_OBJECT_SHA)}` : `commit ${JSON.stringify(tagSha)}`}`
  const [firstRelease, ...laterReleases] = releases
  const releasePage = (tags) => tags.map((tag) => `printf '%s\\n' ${JSON.stringify(tag)}`).join('; ') || ':'
  // olderReleases：再在后面几页补上这么多个老版本，列表就有几百 KB 长。
  const olderPages = olderReleases > 0 ? `; for index in $(seq 1 ${olderReleases}); do printf 'v0.0.%s\\n' "$index"; done` : ''
  const ghStub = `#!/bin/bash
printf 'gh %s\\n' "$*" >> ${JSON.stringify(logPath)}
paginate=''
case " $* " in *' --paginate '*) paginate=1 ;; esac
case "$*" in
  *'/git/matching-refs/tags/'*)
    ${lookupFails ? `echo 'gh: Server Error (HTTP 502)' >&2; exit 1` : `${firstRefPage}; if [ -n "$paginate" ]; then ${laterRefPages}; fi`} ;;
  *'/git/tags/'*) printf '%s\\n' ${JSON.stringify(tagSha || '')} ;;
  *'/releases'*)
    ${releasesFail ? `echo 'gh: Server Error (HTTP 502)' >&2; exit 1` : `${releasePage(firstRelease ? [firstRelease] : [])}; if [ -n "$paginate" ]; then ${releasePage(laterReleases)}${olderPages}; fi`} ;;
esac
exit 0
`
  // 最后一个参数是地址；liveCodes 里点了名的文件回那个状态码，其余按文件名去 served
  // 目录里找，没有就是 404。
  const forced = Object.entries(liveCodes)
    .map(([name, code]) => `  ${JSON.stringify(name)}) printf '<html>%s</html>' ${code} > "$output"; printf ${code}; exit 0 ;;`)
  const curlStub = `#!/bin/bash
printf 'curl %s\\n' "$*" >> ${JSON.stringify(logPath)}
output=''
while [ "$#" -gt 1 ]; do
  if [ "$1" = '--output' ]; then output=$2; shift; fi
  shift
done
name=$(basename "$1")
case "$name" in
${forced.join('\n')}
esac
if [ -f ${JSON.stringify(served)}/"$name" ]; then
  cp ${JSON.stringify(served)}/"$name" "$output"
  printf 200
else
  printf '<!doctype html><html><body>404 Not Found</body></html>' > "$output"
  printf 404
fi
`
  for (const [name, body] of [['gh', ghStub], ['curl', curlStub]]) {
    const executable = path.join(binDirectory, name)
    fs.writeFileSync(executable, body)
    fs.chmodSync(executable, 0o755)
  }
  const result = spawnSync(SHELL_PATH, ['-c', planStep.run], {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      PATH: `${binDirectory}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: workspace,
      RUNNER_TEMP: workspace,
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: 'xufei5620/xingmang-ai-manager',
      GH_TOKEN: 'stub',
      CONFIRM_VERSION: confirm,
      PLATFORMS: platforms,
      PUBLISH_LINUX: publishLinux,
      DISPATCH_REF: ref,
      SHIPPED_SHA: SHIPPED,
    },
  })
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
  const outputs = readOutputs(outputPath)
  fs.rmSync(workspace, { recursive: true, force: true })
  return { status: result.status, output: result.stdout + result.stderr, log, outputs }
}

test('a Linux-only run with Linux publishing off neither checks nor reserves a tag', posixOnly, () => {
  for (const publishLinux of ['', 'false']) {
    const run = runPlanStep({ platforms: 'linux', publishLinux })
    assert.equal(run.status, 0, run.output)
    assert.deepEqual(run.outputs, { action: 'none' })
    assert.equal(run.log, '')
  }
  // 开关照 GitHub 表达式的规矩不分大小写：TRUE 也算打开，这次要对外发，就得占 tag。
  const on = runPlanStep({ platforms: 'linux', publishLinux: 'TRUE' })
  assert.equal(on.status, 0, on.output)
  assert.deepEqual(on.outputs, { tag: 'v0.2.15', action: 'create' })
})

test('the tag is reserved whenever the publish job could run', posixOnly, () => {
  // 判断那一步只在「这次什么都不对外发」时不占 tag。它和 publish 作业的 if 各写各的，
  // 对不上的话 publish 照样跑起来，收尾时才去建 tag，又回到 0.2.14 的样子。
  const results = (job, platforms) => (evaluateCondition(job.if, { inputs: { platforms } })
    ? ['success', 'failure', 'cancelled', 'skipped']
    : ['skipped'])
  for (const platforms of workflow.on.workflow_dispatch.inputs.platforms.options) {
    for (const publishLinux of ['', 'false', 'true', 'TRUE']) {
      let couldPublish = false
      for (const windows of results(windowsJob, platforms)) {
        for (const macos of results(macosJob, platforms)) {
          // linux-build 只在 linux-checks 跑了时才可能不是 skipped。
          for (const linux of results(linuxChecksJob, platforms)) {
            const needs = { 'release-tag': 'success', 'windows-build': windows, 'macos-build': macos, 'linux-build': linux }
            const vars = { XINGMANG_PUBLISH_LINUX: publishLinux }
            if (evaluateCondition(publishJob.if, { inputs: { platforms }, vars, needs })) couldPublish = true
          }
        }
      }
      const run = runPlanStep({ platforms, publishLinux })
      const label = `${platforms}，开关 ${JSON.stringify(publishLinux)}`
      assert.equal(run.status, 0, `${label}\n${run.output}`)
      assert.equal(run.outputs.action === 'none', !couldPublish, label)
    }
  }
})

test('a release is only dispatched from main, for the version package.json declares', posixOnly, () => {
  // release 环境只放行 main：从别处触发，Mac 出包和上传都会被环境拒掉，tag 却已经占在
  // 一个发不出去的提交上了。从这一版自己的 tag 触发也一样不行。
  for (const ref of ['refs/heads/claude/fix', 'refs/tags/v0.2.14', 'refs/tags/v0.2.15']) {
    const run = runPlanStep({ ref, tagSha: SHIPPED })
    assert.notEqual(run.status, 0, ref)
    assert.ok(run.output.includes(`::error::正式发布只能从 main 触发，这次是 ${ref}`), run.output)
    assert.equal(run.log, '', ref)
  }

  const mismatch = runPlanStep({ confirm: '0.2.16' })
  assert.notEqual(mismatch.status, 0)
  assert.match(mismatch.output, /::error::版本不一致：package\.json 是 0\.2\.15，本次触发填的是 0\.2\.16/)
  assert.equal(mismatch.log, '')
  // 下一步要把 tag 名拼进接口地址，版本号先按整串对一遍格式。
  const malformed = runPlanStep({ version: '0.2' })
  assert.notEqual(malformed.status, 0)
  assert.match(malformed.output, /::error::0\.2 不是有效的版本号/)
  assert.equal(malformed.log, '')
})

test('the first run of a new version plans to create its tag', posixOnly, () => {
  // Linux 两份清单线上没有：curl 桩和真的服务器一样把 404 页面写进文件，判断那一步要
  // 把它删掉，否则会被当成一份看不懂的清单。
  const run = runPlanStep({
    live: {
      'latest.yml': manifestText('0.2.14', 'windows'),
      'latest-mac.yml': manifestText('0.2.14', 'mac', 'XingMang-AI-Manager-0.2.14-arm64-mac.zip'),
      'service-status.json': JSON.stringify({ badVersions: ['0.2.10'] }),
    },
  })
  assert.equal(run.status, 0, run.output)
  assert.deepEqual(run.outputs, { tag: 'v0.2.15', action: 'create' })
  for (const manifest of UPDATE_MANIFEST_NAMES) assert.ok(run.log.includes(`/${manifest}\n`), `判断要读线上的 ${manifest}`)
  assert.doesNotMatch(run.log, /--method/)
})

test('a rerun on the commit the tag already points at keeps it unless the version was withdrawn or overtaken', posixOnly, () => {
  // 同一个提交上重跑、补发另一个平台：线上已经是这一版也照样留着。
  for (const annotated of [false, true]) {
    const run = runPlanStep({ tagSha: SHIPPED, annotated, live: { 'latest.yml': manifestText('0.2.15', 'windows') } })
    assert.equal(run.status, 0, run.output)
    assert.deepEqual(run.outputs, { tag: 'v0.2.15', action: 'keep' })
  }
  // 留着 tag 也要看线上：撤回过的、已经被更高版本盖过的，同一个提交也不能再出包，否则要
  // 等一个多小时、批过一次，到上传前那道关才停。
  const withdrawn = runPlanStep({ tagSha: SHIPPED, live: { 'service-status.json': JSON.stringify({ badVersions: ['0.2.15'] }) } })
  assert.notEqual(withdrawn.status, 0)
  assert.match(withdrawn.output, /::error::0\.2\.15 已经被撤回/)
  const overtaken = runPlanStep({ tagSha: SHIPPED, live: { 'latest.yml': manifestText('0.2.16', 'windows') } })
  assert.notEqual(overtaken.status, 0)
  assert.match(overtaken.output, /::error::线上的 latest\.yml 已经是更高的 0\.2\.16/)
  for (const run of [withdrawn, overtaken]) assert.equal(run.outputs.action, undefined)
})

test('a tag left by a run that never shipped is planned to move to the commit being built', posixOnly, () => {
  // 只认完整的 tag 名：v0.2.150 的 Release 不算这一版的。
  const run = runPlanStep({ tagSha: EARLIER, releases: ['v0.2.150', 'v0.2.14'], live: { 'latest.yml': manifestText('0.2.14', 'windows') } })
  assert.equal(run.status, 0, run.output)
  assert.deepEqual(run.outputs, { tag: 'v0.2.15', action: 'move', from: EARLIER })
})

test('a version that already shipped is refused before anything is built', posixOnly, () => {
  // 原来要等一个多小时出完包、批过一次，到上传前那道关才发现。这一版的 Release 排在
  // 第二页：不带 --paginate 就看不见它，会被当成没发过、把 tag 挪走。
  const released = runPlanStep({ tagSha: EARLIER, releases: ['v0.2.150', 'v0.2.15'] })
  assert.notEqual(released.status, 0)
  assert.match(released.output, /::error::v0\.2\.15 已经从 bbbbbbb 发过/)

  const live = runPlanStep({ tagSha: EARLIER, live: { 'latest-mac.yml': manifestText('0.2.15', 'mac', 'XingMang-AI-Manager-0.2.15-arm64-mac.zip') } })
  assert.notEqual(live.status, 0)
  assert.match(live.output, /::error::v0\.2\.15 已经从 bbbbbbb 上过更新源/)

  const withdrawn = runPlanStep({ live: { 'service-status.json': JSON.stringify({ badVersions: ['0.2.15'] }) } })
  assert.notEqual(withdrawn.status, 0)
  assert.match(withdrawn.output, /::error::0\.2\.15 已经被撤回/)
  for (const run of [released, live, withdrawn]) assert.equal(run.outputs.action, undefined)
})

test('a long Release list cannot hide the Release this version already has', posixOnly, () => {
  // 列表从新到旧排，这一版排在最前面。经管道喂给 grep -q 的话，它一找到就退出，后面
  // 还没写完的几百 KB 让 printf 被 SIGPIPE 打断，pipefail 下判断算「没有」，tag 就被挪走。
  const run = runPlanStep({ tagSha: EARLIER, releases: ['v0.2.15'], olderReleases: 50000 })
  assert.notEqual(run.status, 0)
  assert.match(run.output, /::error::v0\.2\.15 已经从 bbbbbbb 发过/)
  assert.equal(run.outputs.action, undefined)
})

test('anything the plan cannot read stops it instead of being read as nothing there', posixOnly, () => {
  const lookup = runPlanStep({ lookupFails: true })
  assert.notEqual(lookup.status, 0)
  assert.match(lookup.output, /::error::查不了 v0\.2\.15 是否已存在/)

  const releases = runPlanStep({ tagSha: EARLIER, releasesFail: true })
  assert.notEqual(releases.status, 0)
  assert.match(releases.output, /::error::查不了 v0\.2\.15 有没有 Release/)

  const manifest = runPlanStep({ liveCodes: { 'latest-mac.yml': 502 } })
  assert.notEqual(manifest.status, 0)
  assert.match(manifest.output, /::error::读取线上 latest-mac\.yml 失败（HTTP 502）/)

  const status = runPlanStep({ liveCodes: { 'service-status.json': 500 } })
  assert.notEqual(status.status, 0)
  assert.match(status.output, /::error::读取线上 service-status\.json 失败（HTTP 500）/)
  for (const run of [lookup, releases, manifest, status]) assert.equal(run.outputs.action, undefined)
})

// 动手的那一步：gh 桩记着 tag 现在指向哪里（空串是没有），建、删都会改它，后面的查询
// 读到的就是改过之后的样子。raceTo：建 tag 被拒的同时，别处刚好把它建在了这个提交上。
function runReserveStep({
  action,
  tag = 'v0.2.15',
  confirm = '0.2.15',
  from = '',
  current = '',
  annotated = false,
  lookupFails = false,
  createFails = false,
  raceTo = '',
  deleteFails = false,
}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-publish-reserve-'))
  const binDirectory = path.join(workspace, 'bin')
  fs.mkdirSync(binDirectory)
  const logPath = path.join(workspace, 'commands.log')
  const statePath = path.join(workspace, 'tag-target')
  fs.writeFileSync(statePath, current)
  const create = createFails
    ? `${raceTo ? `printf '%s' ${JSON.stringify(raceTo)} > "$state"; ` : ''}echo 'gh: Resource not accessible by integration (HTTP 403)' >&2; exit 1`
    : `for argument in "$@"; do case "$argument" in sha=*) printf '%s' "\${argument#sha=}" > "$state" ;; esac; done; exit 0`
  const lookup = lookupFails
    ? `echo 'gh: Server Error (HTTP 502)' >&2; exit 1`
    : `printf 'refs/tags/%s0 commit %s\\n' "$TAG" ${JSON.stringify('c'.repeat(40))}
    target=$(cat "$state")
    if [ -n "$target" ]; then printf 'refs/tags/%s %s\\n' "$TAG" ${annotated ? `"tag ${TAG_OBJECT_SHA}"` : '"commit $target"'}; fi`
  const ghStub = `#!/bin/bash
printf 'gh %s\\n' "$*" >> ${JSON.stringify(logPath)}
state=${JSON.stringify(statePath)}
case "$*" in
  *'--method POST '*)
    ${create} ;;
  *'--method DELETE '*)
    ${deleteFails ? `echo 'gh: Not Found (HTTP 404)' >&2; exit 1` : `: > "$state"; exit 0`} ;;
  *'/git/matching-refs/tags/'*)
    ${lookup} ;;
  *'/git/tags/'*) cat "$state"; echo ;;
esac
exit 0
`
  const executable = path.join(binDirectory, 'gh')
  fs.writeFileSync(executable, ghStub)
  fs.chmodSync(executable, 0o755)
  const result = spawnSync(SHELL_PATH, ['-c', reserveStep.run], {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      PATH: `${binDirectory}:/usr/bin:/bin`,
      HOME: workspace,
      GITHUB_REPOSITORY: 'xufei5620/xingmang-ai-manager',
      GH_TOKEN: 'stub',
      ACTION: action,
      TAG: tag,
      PLANNED_FROM: from,
      CONFIRM_VERSION: confirm,
      SHIPPED_SHA: SHIPPED,
    },
  })
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
  const target = fs.readFileSync(statePath, 'utf8')
  fs.rmSync(workspace, { recursive: true, force: true })
  return { status: result.status, output: result.stdout + result.stderr, log, target }
}

const CREATE_TAG = `gh api --method POST repos/xufei5620/xingmang-ai-manager/git/refs -f ref=refs/tags/v0.2.15 -f sha=${SHIPPED} --silent`
const DELETE_TAG = 'gh api --method DELETE repos/xufei5620/xingmang-ai-manager/git/refs/tags/v0.2.15 --silent'

test('nothing is reserved when nothing will be published', posixOnly, () => {
  const run = runReserveStep({ action: 'none', tag: '' })
  assert.equal(run.status, 0, run.output)
  assert.equal(run.log, '')
})

test('the reservation refuses a malformed plan and never passes it to the API', posixOnly, () => {
  const cases = [
    [{ action: '' }, /看不懂上一步给的结论/],
    [{ action: 'delete' }, /看不懂上一步给的结论/],
    [{ action: 'create', tag: '' }, /tag 名字不对/],
    [{ action: 'create', tag: 'main' }, /tag 名字不对/],
    [{ action: 'create', tag: 'v0.2.15/../../heads/main' }, /tag 名字不对/],
    // grep 按行匹配，夹一个换行就能混过去；这里必须按整串对。
    [{ action: 'create', tag: 'v0.2.15\nmain' }, /tag 名字不对/],
    // 只动这一次要发的那个版本的 tag。
    [{ action: 'create', tag: 'v0.2.14' }, /tag 名字不对/],
    [{ action: 'move', from: '' }, /原来指向哪个提交不对/],
    [{ action: 'move', from: `${EARLIER}\nmain` }, /原来指向哪个提交不对/],
  ]
  for (const [options, message] of cases) {
    const run = runReserveStep(options)
    const label = JSON.stringify(options)
    assert.notEqual(run.status, 0, label)
    assert.match(run.output, message, label)
    assert.equal(run.log, '', label)
  }
})

test('create puts the tag on the commit being built, through the API', posixOnly, () => {
  // GITHUB_TOKEN 推不了新 ref（0.2.8 的 git push 就是这样红的），走 API。
  const run = runReserveStep({ action: 'create' })
  assert.equal(run.status, 0, run.output)
  assert.equal(run.target, SHIPPED)
  assert.ok(run.log.split('\n').includes(CREATE_TAG), run.log)
  // 判断之后、动手之前，别处刚好把它建在了这次的提交上：不再建。
  const again = runReserveStep({ action: 'create', current: SHIPPED })
  assert.equal(again.status, 0, again.output)
  assert.doesNotMatch(again.log, /--method/)
})

test('create stops when the tag appeared on another commit after the plan', posixOnly, () => {
  const run = runReserveStep({ action: 'create', current: EARLIER })
  assert.notEqual(run.status, 0)
  assert.match(run.output, /::error::v0\.2\.15 在检查之后被建在了 b{40} 上/)
  assert.doesNotMatch(run.log, /--method/)
  assert.equal(run.target, EARLIER)
})

test('a refused create tells the owner to dispatch again from the latest main', posixOnly, () => {
  // 触发到占 tag 之间通常只有一两分钟（排在前一次发布后面时要等它跑完），这期间 main 又
  // 合进改工作流的提交，GitHub 就不让这个令牌在这次的提交上建 tag。什么都还没发，重新
  // 触发就好。
  const refused = runReserveStep({ action: 'create', createFails: true })
  assert.notEqual(refused.status, 0)
  assert.match(refused.output, /::error::GitHub 不让在 a{40} 上建 v0\.2\.15/)
  assert.match(refused.output, /从最新的 main 重新触发/)
  assert.equal(refused.target, '')
  // 建不上是因为别处刚好建在了同一个提交上：照样算占好。
  const raced = runReserveStep({ action: 'create', createFails: true, raceTo: SHIPPED })
  assert.equal(raced.status, 0, raced.output)
  const lost = runReserveStep({ action: 'create', createFails: true, raceTo: EARLIER })
  assert.notEqual(lost.status, 0)
  assert.match(lost.output, /::error::GitHub 不让在 a{40} 上建 v0\.2\.15/)
})

test('keep only passes while the tag still points at the commit being built', posixOnly, () => {
  for (const annotated of [false, true]) {
    const run = runReserveStep({ action: 'keep', current: SHIPPED, annotated })
    assert.equal(run.status, 0, run.output)
    assert.doesNotMatch(run.log, /--method/)
    if (annotated) assert.match(run.log, /gh api repos\/.*\/git\/tags\/f{40}/)
  }
  for (const current of [EARLIER, '']) {
    const run = runReserveStep({ action: 'keep', current })
    assert.notEqual(run.status, 0, current)
    assert.match(run.output, /::error::v0\.2\.15 在检查之后变了/)
    assert.doesNotMatch(run.log, /--method/)
  }
})

test('move deletes the tag a cancelled run left and recreates it on the commit being built', posixOnly, () => {
  const run = runReserveStep({ action: 'move', from: EARLIER, current: EARLIER })
  assert.equal(run.status, 0, run.output)
  assert.equal(run.target, SHIPPED)
  const lines = run.log.split('\n')
  assert.ok(lines.indexOf(DELETE_TAG) >= 0 && lines.indexOf(CREATE_TAG) > lines.indexOf(DELETE_TAG), run.log)
  // 判断之后、动手之前，别处刚好把它挪到了这次的提交上：什么都不做。
  const done = runReserveStep({ action: 'move', from: EARLIER, current: SHIPPED })
  assert.equal(done.status, 0, done.output)
  assert.doesNotMatch(done.log, /--method/)
})

test('move leaves the tag alone when it changed since the plan or cannot be deleted', posixOnly, () => {
  const changed = runReserveStep({ action: 'move', from: EARLIER, current: 'c'.repeat(40) })
  assert.notEqual(changed.status, 0)
  assert.match(changed.output, /::error::v0\.2\.15 在检查之后变了（现在指向 c{40}）/)
  assert.doesNotMatch(changed.log, /--method/)
  assert.equal(changed.target, 'c'.repeat(40))
  // 判断时还在、这会儿不在了：有人在动它，不接着建。判断和动手在同一个作业里，重跑时
  // 一起重来，那时它会被判成「还没有」直接建。
  const vanished = runReserveStep({ action: 'move', from: EARLIER, current: '' })
  assert.notEqual(vanished.status, 0)
  assert.match(vanished.output, /::error::v0\.2\.15 在检查之后变了（现在指向 （没有））/)
  assert.doesNotMatch(vanished.log, /--method/)

  const stuck = runReserveStep({ action: 'move', from: EARLIER, current: EARLIER, deleteFails: true })
  assert.notEqual(stuck.status, 0)
  assert.match(stuck.output, /::error::删不掉还指向 b{40} 的旧 v0\.2\.15/)
  assert.doesNotMatch(stuck.log, /--method POST/)
  assert.equal(stuck.target, EARLIER)

  // 删掉之后建不上：那一版本来就没发出去过，从最新的 main 重新触发会直接建。
  const refused = runReserveStep({ action: 'move', from: EARLIER, current: EARLIER, createFails: true })
  assert.notEqual(refused.status, 0)
  assert.match(refused.output, /从最新的 main 重新触发/)
})

test('a failing lookup is never read as no tag when reserving', posixOnly, () => {
  for (const action of ['create', 'keep', 'move']) {
    const run = runReserveStep({ action, from: EARLIER, current: EARLIER, lookupFails: true })
    assert.notEqual(run.status, 0, action)
    assert.match(run.output, /::error::查不了 v0\.2\.15 现在指向哪里/, action)
    assert.doesNotMatch(run.log, /--method/, action)
  }
})

// 收尾那一步排在上传产物与覆盖更新清单**之后**。它失败时线上已经是新版本了，作业却
// 报红，而「究竟发出去没有」是发布现场最不该需要人去猜的一件事。platforms 选单个
// 平台时一个版本要分两次发，第二次跑到这里 tag 与 Release 都已经存在——原来的写法
// 会在那里直接炸。
function runTagStep({ existingTagSha = null, releaseExists = false, assets = true, annotated = false, lookupFails = false, createFails = false }) {
  // assets：true 是 Windows 与 Mac 各一个包，'linux' 是只有 Linux 两个架构的 deb。
  const step = publishJob.steps.find((entry) => /Tag the commit that shipped/.test(entry.name || ''))
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-publish-tag-'))
  const binDirectory = path.join(workspace, 'bin')
  fs.mkdirSync(binDirectory)
  fs.mkdirSync(path.join(workspace, 'release-artifacts'))
  // 名字要照发行名来：assets 是 *Setup.exe / *.dmg 两个 glob，nullglob 下不匹配
  // 就是空数组，而空数组下 gh release upload 会报错——那正是要防的那一类收尾失败。
  if (assets === 'linux') {
    fs.writeFileSync(path.join(workspace, 'release-artifacts', 'xingmang-ai-manager_9.9.9_amd64.deb'), 'deb')
    fs.writeFileSync(path.join(workspace, 'release-artifacts', 'xingmang-ai-manager_9.9.9_arm64.deb'), 'deb')
    fs.writeFileSync(path.join(workspace, 'release-artifacts', 'latest-linux.yml'), 'manifest')
  } else if (assets) {
    fs.writeFileSync(path.join(workspace, 'release-artifacts', 'XingMang-AI-Manager-9.9.9-Setup.exe'), 'installer')
    fs.writeFileSync(path.join(workspace, 'release-artifacts', 'XingMang-AI-Manager-9.9.9-Apple-Silicon-arm64.dmg'), 'image')
  }
  const logPath = path.join(workspace, 'commands.log')

  // 打标走的是 gh，git 一次都不该被调到；留着这个桩就是为了在日志里抓到它。
  const gitStub = `#!/bin/bash
printf 'git %s\\n' "$*" >> ${JSON.stringify(logPath)}
exit 0
`
  // 0.1.x 那批 tag 是 git tag -a 推上去的附注 tag，ref 指向 tag 对象而不是 commit；
  // 现在建的是轻量 tag，ref 直接指向 commit。补发一个平台时两种都可能撞上，所以
  // 桩要能演出两种形状，解引用漏掉一层会让比对永远不相等、把补发判成版本号撞车。
  // matching-refs 按前缀匹配，v9.9.90 也会被列出来，只能认完整的 ref 名。
  const refLines = [`printf 'refs/tags/v9.9.90 commit %s\\n' ${JSON.stringify('c'.repeat(40))}`]
  if (existingTagSha !== null) {
    refLines.push(`printf 'refs/tags/v9.9.9 %s\\n' ${JSON.stringify(annotated ? `tag ${TAG_OBJECT_SHA}` : `commit ${existingTagSha}`)}`)
  }
  const ghStub = `#!/bin/bash
printf 'gh %s\\n' "$*" >> ${JSON.stringify(logPath)}
if [ "$1" = 'api' ]; then
  case "$*" in
    *'--method POST '*) exit ${createFails ? '1' : '0'} ;;
    *'/git/matching-refs/tags/'*) ${lookupFails ? `echo 'gh: Server Error (HTTP 502)' >&2; exit 1` : refLines.join('; ')} ;;
    *'/git/tags/'*) printf '%s\\n' ${JSON.stringify(existingTagSha || '')} ;;
  esac
  exit 0
fi
if [ "$1" = 'release' ] && [ "$2" = 'view' ]; then exit ${releaseExists ? '0' : '1'}; fi
exit 0
`
  const nodeStub = `#!/bin/bash
printf 'node %s\\n' "$*" >> ${JSON.stringify(logPath)}
: > "${'$'}{RUNNER_TEMP}/release-section.md"
exit 0
`
  for (const [name, body] of [['git', gitStub], ['gh', ghStub], ['node', nodeStub]]) {
    const executable = path.join(binDirectory, name)
    fs.writeFileSync(executable, body)
    fs.chmodSync(executable, 0o755)
  }

  const result = spawnSync(SHELL_PATH, ['-c', step.run], {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      PATH: `${binDirectory}:/usr/bin:/bin`,
      HOME: workspace,
      RUNNER_TEMP: workspace,
      PACKAGE_VERSION: '9.9.9',
      SHIPPED_SHA: SHIPPED,
      GH_TOKEN: 'stub',
      GITHUB_REPOSITORY: 'xufei5620/xingmang-ai-manager',
    },
  })
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
  fs.rmSync(workspace, { recursive: true, force: true })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, log }
}

test('the Release is created on the tag reserved at dispatch, without naming a commit', posixOnly, () => {
  // 0.2.8 的收尾停在 tag 和 Release 之间，补发时 tag 已经在了而 Release 还没有；现在 tag
  // 触发时就占好了，这就是正常的那一支，不能报红。
  const run = runTagStep({ existingTagSha: SHIPPED, releaseExists: false })

  assert.equal(run.status, 0, run.stderr)
  const create = run.log.split('\n').find((line) => line.startsWith('gh release create '))
  assert.match(create, /^gh release create v9\.9\.9 --verify-tag --title 9\.9\.9 --notes-file /)
  assert.match(create, /release-artifacts\/XingMang-AI-Manager-9\.9\.9-Setup\.exe/)
  // 0.2.14 两次 403 都是因为传了 --target：GitHub 按它指向的提交判断工作流文件，出包
  // 之后 main 改过工作流就拒绝。不传时按默认分支的最新提交判断，必然一致。
  assert.doesNotMatch(run.log, /--target|target_commitish/)
  assert.doesNotMatch(run.log, /--method|gh release upload/)
})

test('a reserved tag that went missing is recreated on the shipped commit through the API', posixOnly, () => {
  const run = runTagStep({ existingTagSha: null, releaseExists: false })

  assert.equal(run.status, 0, run.stderr)
  const lines = run.log.split('\n')
  const recreate = lines.indexOf(`gh api --method POST repos/xufei5620/xingmang-ai-manager/git/refs -f ref=refs/tags/v9.9.9 -f sha=${SHIPPED} --silent`)
  const release = lines.findIndex((line) => line.startsWith('gh release create v9.9.9 --verify-tag '))
  assert.ok(recreate >= 0 && release > recreate, run.log)
  // GITHUB_TOKEN 推不了新 ref（0.2.8 的 git push 就是这样红的）。
  assert.doesNotMatch(run.log, /^git /m)
  assert.doesNotMatch(run.log, /--target/)
})

test('a missing tag that cannot be recreated stops with the command to run by hand', posixOnly, () => {
  // 出包之后 main 改过工作流文件，这个令牌补建不了。更新源已经是新版本，只差发布页。
  const run = runTagStep({ existingTagSha: null, releaseExists: false, createFails: true })

  assert.notEqual(run.status, 0)
  const output = run.stdout + run.stderr
  assert.match(output, /::error::v9\.9\.9 不在了/)
  assert.ok(output.includes(`gh api --method POST repos/xufei5620/xingmang-ai-manager/git/refs -f ref=refs/tags/v9.9.9 -f sha=${SHIPPED}`), output)
  assert.doesNotMatch(run.log, /gh release (create|upload)/)
})

test('a failing tag lookup at the finish is never read as a missing tag', posixOnly, () => {
  const run = runTagStep({ lookupFails: true })

  assert.notEqual(run.status, 0)
  assert.match(run.stdout + run.stderr, /::error::查不了 v9\.9\.9 指向哪里/)
  assert.doesNotMatch(run.log, /--method|gh release/)
})

test('re-publishing the same version adds its assets instead of failing on the existing tag', posixOnly, () => {
  const run = runTagStep({ existingTagSha: SHIPPED, releaseExists: true })

  assert.equal(run.status, 0, run.stderr)
  // 先发 Windows、之后补发 macOS 是被支持的发布方式；第二次不该在收尾炸掉。
  assert.match(run.log, /gh release upload v9\.9\.9 .*--clobber/)
  // 正文不重写：发布者可能已经在上面补过话。
  assert.doesNotMatch(run.log, /gh release create/)
})

test('a Linux-only publish attaches both debs to the Release and nothing else', posixOnly, () => {
  const run = runTagStep({ existingTagSha: SHIPPED, releaseExists: true, assets: 'linux' })

  assert.equal(run.status, 0, run.stderr)
  const upload = run.log.split('\n').find((line) => /gh release upload/.test(line))
  assert.match(upload, /release-artifacts\/xingmang-ai-manager_9\.9\.9_amd64\.deb/)
  assert.match(upload, /release-artifacts\/xingmang-ai-manager_9\.9\.9_arm64\.deb/)
  // 清单是给自动更新读的，挂到 Release 页面上只会让人点错。
  assert.doesNotMatch(upload, /latest-linux/)
})

test('an annotated tag from an older release is dereferenced before it is compared', posixOnly, () => {
  const run = runTagStep({ existingTagSha: SHIPPED, releaseExists: true, annotated: true })

  // 漏掉解引用那一层，比对的就是 tag 对象的 id，永远不等于出包的 commit，
  // 补发会被判成「同一个版本号发过两份不同的产物」而停掉。
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.log, /gh api repos\/.*\/git\/tags\/f{40}/)
  assert.match(run.log, /gh release upload v9\.9\.9 .*--clobber/)
})

test('a tag that already points somewhere else stops the job instead of being moved', posixOnly, () => {
  const run = runTagStep({ existingTagSha: EARLIER, releaseExists: true })

  // 同一个版本号发过两份不同的产物，这必须有人来看。
  assert.notEqual(run.status, 0)
  assert.match(run.stdout + run.stderr, /::error::v9\.9\.9 已存在且指向 b{40}/)
  assert.doesNotMatch(run.log, /--method|gh release (create|upload)/)
})

test('the finish never moves, deletes or retargets the release tag', () => {
  const step = publishJob.steps.find((entry) => /Tag the commit that shipped/.test(entry.name || ''))
  const commands = commandLines(step.run).join('\n')

  // 移动一个已发布的 tag 会让所有按 tag 取源码的人拿到和当初不同的东西。
  assert.doesNotMatch(commands, /git tag -f|--force|-d\s+"?v?\$|--method (?:DELETE|PATCH)/)
  assert.doesNotMatch(commands, /^\s*git push/m)
  // 也不指定 Release 挂哪个提交：见上面 0.2.14 那一条。
  assert.doesNotMatch(commands, /--target|target_commitish/)
})


// #493：往更新目录写任何东西之前先确认这一版可以发。
const { PublishGuardError, assertNotWithdrawn, assessPublish } = require('./publish-guard.cjs')

function manifestText(version, bytes, name = `XingMang-AI-Manager-${version}-Setup.exe`) {
  const sha512 = require('node:crypto').createHash('sha512').update(bytes).digest('base64')
  return YAML.stringify({ version, files: [{ url: name, sha512, size: Buffer.byteLength(bytes) }], path: name, sha512, releaseDate: '2026-09-24T00:00:00.000Z' })
}

// 上传与逐字节复核两步真的跑一遍：aws 桩把文件放进一个本地「桶」目录并记下类型，
// curl 桩从那个目录取回。两步的通配符只要有一边漏了 deb，开关打开时就会出现清单
// 指向一个没传、或者传了没核过的安装包。
function runUploadAndVerify(artifacts) {
  const upload = publishJob.steps.find((entry) => /Upload the installers and their blockmaps/.test(entry.name || ''))
  const verify = publishJob.steps.find((entry) => /Verify the uploaded files are downloadable/.test(entry.name || ''))
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-publish-upload-'))
  const binDirectory = path.join(workspace, 'bin')
  const bucket = path.join(workspace, 'bucket')
  for (const directory of [binDirectory, bucket, path.join(workspace, 'release-artifacts')]) fs.mkdirSync(directory)
  for (const [name, text] of Object.entries(artifacts)) fs.writeFileSync(path.join(workspace, 'release-artifacts', name), text)
  const logPath = path.join(workspace, 'uploads.log')
  const awsStub = `#!/bin/bash
type=''
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  if [ "\${args[$i]}" = '--content-type' ]; then type=\${args[$((i + 1))]}; fi
done
name=$(basename "$4")
cp "$3" ${JSON.stringify(bucket)}/"$name"
printf '%s %s\\n' "$name" "$type" >> ${JSON.stringify(logPath)}
`
  const curlStub = `#!/bin/bash
output=''
while [ "$#" -gt 1 ]; do
  if [ "$1" = '--output' ]; then output=$2; shift; fi
  shift
done
name=$(basename "$1")
[ -f ${JSON.stringify(bucket)}/"$name" ] || exit 22
cp ${JSON.stringify(bucket)}/"$name" "$output"
`
  for (const [name, body] of [['aws', awsStub], ['curl', curlStub]]) {
    const executable = path.join(binDirectory, name)
    fs.writeFileSync(executable, body)
    fs.chmodSync(executable, 0o755)
  }
  const env = {
    PATH: `${binDirectory}:/usr/bin:/bin`,
    HOME: workspace,
    RUNNER_TEMP: workspace,
    OBJECT_PREFIX: 'xingmang-manager',
    R2_ACCOUNT_ID: 'stub',
    R2_BUCKET: 'stub',
    PUBLIC_BASE: 'https://updates.example.test/xingmang-manager',
  }
  const uploaded = spawnSync(SHELL_PATH, ['-c', upload.run], { cwd: workspace, encoding: 'utf8', env })
  const verified = spawnSync(SHELL_PATH, ['-c', verify.run], { cwd: workspace, encoding: 'utf8', env })
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
  fs.rmSync(workspace, { recursive: true, force: true })
  return { uploaded, verified, log }
}

test('with Linux on, both debs are uploaded and checked byte for byte before any manifest', posixOnly, () => {
  const run = runUploadAndVerify({
    'XingMang-AI-Manager-0.2.11-Setup.exe': 'installer',
    'XingMang-AI-Manager-0.2.11-Setup.exe.blockmap': 'blockmap',
    'xingmang-ai-manager_0.2.11_amd64.deb': 'deb x64',
    'xingmang-ai-manager_0.2.11_arm64.deb': 'deb arm64',
    'latest.yml': 'manifest',
    'latest-linux.yml': 'manifest',
    'latest-linux-arm64.yml': 'manifest',
  })
  assert.equal(run.uploaded.status, 0, run.uploaded.stderr)
  assert.equal(run.verified.status, 0, run.verified.stdout + run.verified.stderr)
  assert.match(run.log, /^xingmang-ai-manager_0\.2\.11_amd64\.deb application\/vnd\.debian\.binary-package$/m)
  assert.match(run.log, /^xingmang-ai-manager_0\.2\.11_arm64\.deb application\/vnd\.debian\.binary-package$/m)
  // 清单不在这一步传：它们只能由最后那一步动。
  assert.doesNotMatch(run.log, /latest/)
  assert.match(run.verified.stdout, /已逐字节复核 4 个产物/)

  // 开关关着时产物里没有 Linux 的东西，这两步和加 Linux 之前一样：只传、只核 Windows
  // 与 macOS 的文件。
  const withoutLinux = runUploadAndVerify({
    'XingMang-AI-Manager-0.2.11-Setup.exe': 'installer',
    'XingMang-AI-Manager-0.2.11-Setup.exe.blockmap': 'blockmap',
    'XingMang-AI-Manager-0.2.11-Apple-Silicon-arm64.dmg': 'image',
    'XingMang-AI-Manager-0.2.11-Apple-Silicon-arm64.zip': 'zip',
    'latest.yml': 'manifest',
    'latest-mac.yml': 'manifest',
  })
  assert.equal(withoutLinux.uploaded.status, 0, withoutLinux.uploaded.stderr)
  assert.equal(withoutLinux.verified.status, 0, withoutLinux.verified.stdout + withoutLinux.verified.stderr)
  assert.deepEqual(withoutLinux.log.trim().split('\n').sort(), [
    'XingMang-AI-Manager-0.2.11-Apple-Silicon-arm64.dmg application/x-apple-diskimage',
    'XingMang-AI-Manager-0.2.11-Apple-Silicon-arm64.zip application/zip',
    'XingMang-AI-Manager-0.2.11-Setup.exe application/vnd.microsoft.portable-executable',
    'XingMang-AI-Manager-0.2.11-Setup.exe.blockmap application/octet-stream',
  ])
  assert.match(withoutLinux.verified.stdout, /已逐字节复核 4 个产物/)
})

test('the publish guard runs before the first upload', () => {
  const guard = stepIndex(publishJob, /Refuse to overwrite a version that already shipped/)
  const firstUpload = publishJob.steps.findIndex((step) => /aws s3 cp/.test(String(step.run || '')))
  assert.ok(guard >= 0 && firstUpload > guard, '同版本检查必须排在第一次上传之前')
})

test('the publish guard allows a first release, an upgrade and a rerun of the same build only', () => {
  const ours = manifestText('0.2.11', 'build A')
  assert.equal(assessPublish(ours, null, 'latest-mac.yml'), 'first')
  assert.equal(assessPublish(ours, manifestText('0.2.10', 'old'), 'latest-mac.yml'), 'upgrade')
  assert.equal(assessPublish(ours, ours, 'latest-mac.yml'), 'same')
  // 同一个版本号换一批字节：Mac 出包不可复现，重新出包就是这样。
  assert.throws(() => assessPublish(ours, manifestText('0.2.11', 'build B'), 'latest-mac.yml'), /不能换内容/)
  assert.throws(() => assessPublish(ours, manifestText('0.2.12', 'newer'), 'latest-mac.yml'), /更高的 0\.2\.12/)
  assert.throws(() => assessPublish(ours, '<!doctype html><html></html>', 'latest-mac.yml'), /HTML/)
  // Linux 两个架构的清单和别的平台走同一套规则；不认识的名字照样拒绝。
  const linux = manifestText('0.2.11', 'deb A', 'xingmang-ai-manager_0.2.11_amd64.deb')
  assert.equal(assessPublish(linux, null, 'latest-linux.yml'), 'first')
  assert.equal(assessPublish(linux, manifestText('0.2.10', 'deb old', 'xingmang-ai-manager_0.2.10_amd64.deb'), 'latest-linux.yml'), 'upgrade')
  assert.throws(() => assessPublish(linux, manifestText('0.2.11', 'deb B', 'xingmang-ai-manager_0.2.11_amd64.deb'), 'latest-linux.yml'), /不能换内容/)
  assert.equal(assessPublish(linux, null, 'latest-linux-arm64.yml'), 'first')
  assert.throws(() => assessPublish(linux, null, 'latest-linux-ia32.yml'), PublishGuardError)
})

function runGuardStep({ existingTagSha = null, tagLookupFails = false, createFails = false, live = {}, artifacts }) {
  const step = publishJob.steps.find((entry) => /Refuse to overwrite a version that already shipped/.test(entry.name || ''))
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-publish-guard-'))
  const binDirectory = path.join(workspace, 'bin')
  fs.mkdirSync(binDirectory)
  fs.mkdirSync(path.join(workspace, 'release-artifacts'))
  fs.symlinkSync(path.join(root, 'scripts'), path.join(workspace, 'scripts'))
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(workspace, 'node_modules'))
  for (const [name, text] of Object.entries(artifacts)) fs.writeFileSync(path.join(workspace, 'release-artifacts', name), text)
  const liveDirectory = path.join(workspace, 'live')
  fs.mkdirSync(liveDirectory)
  for (const [name, text] of Object.entries(live)) fs.writeFileSync(path.join(liveDirectory, name), text)
  const logPath = path.join(workspace, 'commands.log')
  const ghStub = `#!/bin/bash
printf 'gh %s\\n' "$*" >> ${JSON.stringify(logPath)}
case "$*" in
  *'--method POST '*) ${createFails ? `echo 'gh: Resource not accessible by integration (HTTP 403)' >&2; exit 1` : 'exit 0'} ;;
  *'/git/matching-refs/tags/'*) ${tagLookupFails
    ? `echo 'gh: Server Error (HTTP 502)' >&2; exit 1`
    // 按前缀匹配：v0.2.110 也会被列出来，只能认完整的 ref 名。
    : `printf 'refs/tags/v0.2.110 commit %s\\n' ${JSON.stringify('c'.repeat(40))}${existingTagSha ? `; printf 'refs/tags/v0.2.11 commit %s\\n' ${JSON.stringify(existingTagSha)}` : ''}`} ;;
esac
exit 0
`
  // 最后一个参数是地址；按文件名去 live 目录里找，没有就是 404。
  const curlStub = `#!/bin/bash
printf 'curl %s\\n' "$*" >> ${JSON.stringify(logPath)}
output=''
while [ "$#" -gt 1 ]; do
  if [ "$1" = '--output' ]; then output=$2; shift; fi
  shift
done
name=$(basename "$1")
if [ -f ${JSON.stringify(liveDirectory)}/"$name" ]; then
  cp ${JSON.stringify(liveDirectory)}/"$name" "$output"
  printf 200
else
  printf 404
fi
`
  for (const [name, body] of [['gh', ghStub], ['curl', curlStub]]) {
    const executable = path.join(binDirectory, name)
    fs.writeFileSync(executable, body)
    fs.chmodSync(executable, 0o755)
  }
  const result = spawnSync(SHELL_PATH, ['-c', step.run], {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      PATH: `${binDirectory}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: workspace,
      RUNNER_TEMP: workspace,
      PACKAGE_VERSION: '0.2.11',
      SHIPPED_SHA: 'a'.repeat(40),
      PUBLIC_BASE: 'https://updates.example.test/xingmang-manager',
      GH_TOKEN: 'stub',
      GITHUB_REPOSITORY: 'xufei5620/xingmang-ai-manager',
    },
  })
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
  fs.rmSync(workspace, { recursive: true, force: true })
  return { status: result.status, output: result.stdout + result.stderr, log }
}

test('a macOS-only publish of a version that already shipped stops before any upload', posixOnly, () => {
  const ours = manifestText('0.2.11', 'mac build B', 'XingMang-AI-Manager-0.2.11-arm64-mac.zip')
  const shipped = manifestText('0.2.11', 'mac build A', 'XingMang-AI-Manager-0.2.11-arm64-mac.zip')

  // 版本号撞车：tag 已从别的 commit 发过。
  const otherCommit = runGuardStep({ existingTagSha: 'b'.repeat(40), artifacts: { 'latest-mac.yml': ours } })
  assert.notEqual(otherCommit.status, 0)
  assert.match(otherCommit.output, /::error::v0\.2\.11 已存在/)

  // 同一个 commit 重新出包，线上已是这个版本的另一批字节。
  const rebuilt = runGuardStep({ existingTagSha: 'a'.repeat(40), live: { 'latest-mac.yml': shipped }, artifacts: { 'latest-mac.yml': ours } })
  assert.notEqual(rebuilt.status, 0)
  assert.match(rebuilt.output, /不能换内容/)

  // 同一次出包的发布作业被重跑：一样的文件，放行。
  const rerun = runGuardStep({ existingTagSha: 'a'.repeat(40), live: { 'latest-mac.yml': ours }, artifacts: { 'latest-mac.yml': ours } })
  assert.equal(rerun.status, 0, rerun.output)
})

test('publishing macOS later for a version Windows already shipped from the same commit is allowed', posixOnly, () => {
  const ours = manifestText('0.2.11', 'mac build', 'XingMang-AI-Manager-0.2.11-arm64-mac.zip')
  const older = manifestText('0.2.10', 'old mac build', 'XingMang-AI-Manager-0.2.10-arm64-mac.zip')
  const run = runGuardStep({
    existingTagSha: 'a'.repeat(40),
    live: { 'latest.yml': manifestText('0.2.11', 'windows build'), 'latest-mac.yml': older },
    artifacts: { 'latest-mac.yml': ours },
  })
  assert.equal(run.status, 0, run.output)
  assert.match(run.output, /latest-mac\.yml：线上是旧版本，可以发/)
  const first = runGuardStep({ artifacts: { 'latest-mac.yml': ours } })
  assert.equal(first.status, 0, first.output)
  assert.match(first.output, /第一次发布/)
})

// #493 剩下的那半：查 tag 时只有「确实没有」才算没有，接口报错不能当成没有。
test('publishing Linux later for a version that already shipped elsewhere is allowed, both architectures at once', posixOnly, () => {
  const x64 = manifestText('0.2.11', 'deb x64', 'xingmang-ai-manager_0.2.11_amd64.deb')
  const arm64 = manifestText('0.2.11', 'deb arm64', 'xingmang-ai-manager_0.2.11_arm64.deb')
  const live = { 'latest.yml': manifestText('0.2.11', 'windows build') }

  // 开关打开以后在同一个 commit 上只发 linux：线上没有 Linux 清单，算第一次发布。
  const later = runGuardStep({ existingTagSha: 'a'.repeat(40), live, artifacts: { 'latest-linux.yml': x64, 'latest-linux-arm64.yml': arm64 } })
  assert.equal(later.status, 0, later.output)
  assert.match(later.output, /线上还没有 latest-linux\.yml，这是这个平台的第一次发布/)
  assert.match(later.output, /线上还没有 latest-linux-arm64\.yml，这是这个平台的第一次发布/)

  // 只到了一个架构：宁可停下，也不让一半的 Linux 客户看到新版本。
  const half = runGuardStep({ existingTagSha: 'a'.repeat(40), live, artifacts: { 'latest-linux.yml': x64 } })
  assert.notEqual(half.status, 0)
  assert.match(half.output, /::error::产物里只有一个架构的 Linux 更新清单/)
  assert.doesNotMatch(half.output, /可以发/)
})

test('a failing tag lookup stops the publish instead of being read as no tag', posixOnly, () => {
  const ours = manifestText('0.2.11', 'mac build', 'XingMang-AI-Manager-0.2.11-arm64-mac.zip')
  const run = runGuardStep({ tagLookupFails: true, live: { 'latest-mac.yml': manifestText('0.2.10', 'old') }, artifacts: { 'latest-mac.yml': ours } })
  assert.notEqual(run.status, 0)
  assert.match(run.output, /::error::查不了 v0\.2\.11 是否已存在/)
  assert.doesNotMatch(run.output, /可以发/)
})

test('a tag that went missing is recreated before the upload, or nothing is published', posixOnly, () => {
  // tag 一开始就由 release-tag 占好了，这会儿不在多半是有人删了。等传完、覆盖完清单再去
  // 补建，建不上时线上已经是新版本了，GitHub 上却没有 tag。
  const ours = manifestText('0.2.11', 'mac build', 'XingMang-AI-Manager-0.2.11-arm64-mac.zip')
  const live = { 'latest-mac.yml': manifestText('0.2.10', 'old mac build', 'XingMang-AI-Manager-0.2.10-arm64-mac.zip') }
  const createTag = `gh api --method POST repos/xufei5620/xingmang-ai-manager/git/refs -f ref=refs/tags/v0.2.11 -f sha=${SHIPPED} --silent`
  const recreated = runGuardStep({ live, artifacts: { 'latest-mac.yml': ours } })
  assert.equal(recreated.status, 0, recreated.output)
  assert.ok(recreated.log.split('\n').includes(createTag), recreated.log)
  assert.match(recreated.output, /v0\.2\.11 不在了，已补建在本次出包的 a{40} 上/)

  // 补建不了：这一步失败，后面的上传都不会跑。
  const refused = runGuardStep({ createFails: true, live, artifacts: { 'latest-mac.yml': ours } })
  assert.notEqual(refused.status, 0)
  assert.match(refused.output, /::error::v0\.2\.11 不在了，这个令牌也补建不了/)
  assert.match(refused.output, /线上什么都没改/)

  // 别的检查先停下的，不把别人删掉的 tag 又建回来。
  const withdrawn = runGuardStep({
    live: { ...live, 'service-status.json': JSON.stringify({ badVersions: ['0.2.11'] }) },
    artifacts: { 'latest-mac.yml': ours },
  })
  assert.notEqual(withdrawn.status, 0)
  assert.match(withdrawn.output, /0\.2\.11 已经被撤回/)
  assert.doesNotMatch(withdrawn.log, /--method/)

  // 正常情况：tag 在，指着这次的提交，不再建。
  const present = runGuardStep({ existingTagSha: SHIPPED, live, artifacts: { 'latest-mac.yml': ours } })
  assert.equal(present.status, 0, present.output)
  assert.doesNotMatch(present.log, /--method/)
  // 只会补建，不挪也不删。
  const step = publishJob.steps.find((entry) => /Refuse to overwrite a version that already shipped/.test(entry.name || ''))
  assert.doesNotMatch(commandLines(step.run).join('\n'), /--method (?:DELETE|PATCH)|--target|target_commitish|force=/)
})

test('the tag lookup never swallows errors from the GitHub API', () => {
  const step = publishJob.steps.find((entry) => /Refuse to overwrite a version that already shipped/.test(entry.name || ''))
  assert.doesNotMatch(String(step.run), /\|\|\s*true/)
  assert.doesNotMatch(String(step.run), /2>\s*\/dev\/null/)
})

// #548：回退之后重跑坏版本的发布，会把清单又指回它。
test('the publish guard refuses a version on the withdrawn list', () => {
  const ours = manifestText('0.2.11', 'build A')
  assert.doesNotThrow(() => assertNotWithdrawn(ours, null, 'latest.yml'))
  assert.doesNotThrow(() => assertNotWithdrawn(ours, JSON.stringify({ badVersions: ['0.2.9'] }), 'latest.yml'))
  assert.doesNotThrow(() => assertNotWithdrawn(ours, JSON.stringify({ maintenance: { active: false } }), 'latest.yml'))
  assert.throws(() => assertNotWithdrawn(ours, JSON.stringify({ badVersions: ['0.2.11'] }), 'latest.yml'), /0\.2\.11 已经被撤回/)
  assert.throws(() => assertNotWithdrawn(ours, JSON.stringify({ badVersions: ['v0.2.11'] }), 'latest.yml'), /已经被撤回/)
  // 看不懂的状态文件不能当成「没有撤回名单」。
  assert.throws(() => assertNotWithdrawn(ours, '<!doctype html><html></html>', 'latest.yml'), /看不懂/)
  assert.throws(() => assertNotWithdrawn(ours, JSON.stringify({ badVersions: '0.2.11' }), 'latest.yml'), /格式不对/)
})

test('re-running the publish of a withdrawn version after a rollback stops before any upload', posixOnly, () => {
  const bad = manifestText('0.2.11', 'windows build')
  const restored = manifestText('0.2.10', 'previous build')
  const status = JSON.stringify({ badVersions: ['0.2.11'] })
  const rerun = runGuardStep({ existingTagSha: 'a'.repeat(40), live: { 'latest.yml': restored, 'service-status.json': status }, artifacts: { 'latest.yml': bad } })
  assert.notEqual(rerun.status, 0)
  assert.match(rerun.output, /0\.2\.11 已经被撤回/)
  // 撤回名单里没有它时照常放行；状态文件不存在也照常放行。
  const clean = runGuardStep({ existingTagSha: 'a'.repeat(40), live: { 'latest.yml': restored, 'service-status.json': JSON.stringify({ badVersions: ['0.2.9'] }) }, artifacts: { 'latest.yml': bad } })
  assert.equal(clean.status, 0, clean.output)
  const noStatus = runGuardStep({ live: { 'latest.yml': restored }, artifacts: { 'latest.yml': bad } })
  assert.equal(noStatus.status, 0, noStatus.output)
  assert.match(noStatus.output, /没有撤回名单/)
})
