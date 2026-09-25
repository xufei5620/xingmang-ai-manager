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
const publishJob = workflow.jobs.publish
const buildJobs = [windowsJob, macosJob]

// 产品所有者 2026-09-20 已经按这八个名字在 release 环境里建 secret 了。工作流读的
// 名字与他建的名字必须字字相同，否则表现是一条看不出原因的 403 或一个空取值。
const RELEASE_SECRET_NAMES = [
  'CSC_NAME',
  'R2_ACCESS_KEY_ID',
  'R2_ACCOUNT_ID',
  'R2_BUCKET',
  'R2_SECRET_ACCESS_KEY',
  'XINGMANG_MAC_SIGNING_P12_BASE64',
  'XINGMANG_MAC_SIGNING_P12_PASSWORD',
  'XINGMANG_MAC_SIGNING_SHA256',
  // 更新包签名私钥（2026-09-25 加）。产品所有者照 docs/RELEASING.md「更新包签名」
  // 在自己电脑上生成、加进 release 环境；缺了它 Windows 发布会在上传前失败。
  'XINGMANG_UPDATE_SIGNING_KEY',
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
  // 两个平台各有一份清单，两份都受这条约束。
  const touchingManifest = publishJob.steps.filter((step) => {
    const script = String(step.run || '')
    return /aws s3 cp/.test(script) && /latest(?:-mac)?\.yml/.test(script)
  })
  assert.equal(touchingManifest.length, 1)
  assert.match(String(touchingManifest[0].name), /Publish the update manifests/)
  assert.match(String(touchingManifest[0].run), /latest\.yml latest-mac\.yml/)
})

test('both platforms get their published feed re-verified end to end', () => {
  // 只复核 Windows 那一半的话，一次传坏的 latest-mac.yml 要等客户点更新才暴露。
  const feeds = publishJob.steps.filter((step) => /update:verify-feed/.test(String(step.run || '')))
  assert.deepEqual(
    feeds.map((step) => String(step.run).trim()),
    ['npm run update:verify-feed -- --platform=windows', 'npm run update:verify-feed -- --platform=macos'],
  )
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

test('the Windows build job holds no credentials at all', () => {
  // Windows 那一份是无签名发布，出包不需要任何 secret。少一个作业能读到凭据，
  // 「谁能读到证书和 R2 密钥」这个问题就少一个答案。
  assert.equal(windowsJob.environment, undefined)
  assert.equal(windowsJob.permissions, undefined)
  assert.doesNotMatch(YAML.stringify(windowsJob), /secrets\./)
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
  for (const job of [...buildJobs, publishJob]) {
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
        /echo\s+"?\$(AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|R2_ACCOUNT_ID|XINGMANG_MAC_SIGNING_P12_BASE64|XINGMANG_MAC_SIGNING_P12_PASSWORD|XINGMANG_UPDATE_SIGNING_KEY)/,
        step.name,
      )
    }
  }
})

test('every third-party action is pinned to a full commit id', () => {
  for (const step of [...windowsJob.steps, ...macosJob.steps, ...publishJob.steps]) {
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
  for (const job of buildJobs) {
    const confirm = stepIndex(job, /Confirm the requested version/)
    const build = stepIndex(job, /release:build|dist:mac:free/)
    assert.ok(confirm >= 0 && confirm < build)
  }
  assert.equal(workflow.on.workflow_dispatch.inputs.confirm_version.required, true)
})

test('a single-platform publish does not silently skip the publish job', () => {
  // 被跳过的 needs 默认会把依赖它的作业也跳过，表现是「跑完了但什么都没发」。
  assert.deepEqual(publishJob.needs, ['windows-build', 'macos-build'])
  assert.match(String(publishJob.if), /!cancelled\(\)/)
  assert.match(String(publishJob.if), /windows-build\.result != 'failure'/)
  assert.match(String(publishJob.if), /macos-build\.result != 'failure'/)
  assert.match(String(publishJob.if), /== 'success'/)
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.platforms.options, ['both', 'windows', 'macos'])
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

// 这一步排在上传产物与覆盖更新清单**之后**。它失败时线上已经是新版本了，作业却
// 报红，而「究竟发出去没有」是发布现场最不该需要人去猜的一件事。platforms 选单个
// 平台时一个版本要分两次发，第二次跑到这里 tag 与 Release 都已经存在——原来的写法
// 会在那里直接炸。
//
// 这几条把工作流里的那段 `run` 真的跑起来，所以要一个 POSIX shell 和能当可执行文件
// 用的打桩脚本。publish 作业本身 runs-on: ubuntu-latest，这段脚本永远不会在 Windows
// 上执行，所以 Windows 分片上跳过的是「跑不起来的环境」，不是「在 Windows 上不成立
// 的断言」——Linux 与 macOS 分片照跑，覆盖没有减少。
const SHELL_PATH = '/bin/bash'
const shellUnavailable = process.platform === 'win32' || !fs.existsSync(SHELL_PATH)
const posixOnly = { skip: shellUnavailable && `需要 ${SHELL_PATH}，publish 作业只在 ubuntu-latest 上跑` }

function runTagStep({ existingTagSha, releaseExists, assets = true, annotated = false }) {
  const step = publishJob.steps.find((entry) => /Tag the commit that shipped/.test(entry.name || ''))
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-publish-tag-'))
  const binDirectory = path.join(workspace, 'bin')
  fs.mkdirSync(binDirectory)
  fs.mkdirSync(path.join(workspace, 'release-artifacts'))
  // 名字要照发行名来：assets 是 *Setup.exe / *.dmg 两个 glob，nullglob 下不匹配
  // 就是空数组，而空数组下 gh release upload 会报错——那正是要防的那一类收尾失败。
  if (assets) {
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
  const TAG_OBJECT_SHA = 'f'.repeat(40)
  const refResponse = existingTagSha === null
    ? 'exit 1'
    : (annotated
      ? `printf 'tag %s\\n' ${JSON.stringify(TAG_OBJECT_SHA)}`
      : `printf 'commit %s\\n' ${JSON.stringify(existingTagSha)}`)
  const ghStub = `#!/bin/bash
printf 'gh %s\\n' "$*" >> ${JSON.stringify(logPath)}
if [ "$1" = 'api' ]; then
  case "$2" in
    */git/ref/tags/*) ${refResponse} ;;
    */git/tags/*) printf '%s\\n' ${JSON.stringify(existingTagSha || '')} ;;
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
      SHIPPED_SHA: 'a'.repeat(40),
      GH_TOKEN: 'stub',
      GITHUB_REPOSITORY: 'xufei5620/xingmang-ai-manager',
    },
  })
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
  fs.rmSync(workspace, { recursive: true, force: true })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, log }
}

test('a first release of a version tags the commit that shipped and creates the Release', posixOnly, () => {
  const run = runTagStep({ existingTagSha: null, releaseExists: false })

  assert.equal(run.status, 0, run.stderr)
  // tag 由 --target 建出来，指向本次出包的那个 commit。
  assert.match(run.log, new RegExp(`gh release create v9\\.9\\.9 --target ${'a'.repeat(40)}`))
  assert.doesNotMatch(run.log, /gh release upload/)
})

test('the release tag is created through the API instead of git push', posixOnly, () => {
  // GITHUB_TOKEN 是 GitHub App 令牌，推新 ref 会被「没有 workflows 权限就不许创建或
  // 更新 .github/workflows/*」拒掉，而那个权限给不了。0.2.8 就是这样红在最后一步的。
  const run = runTagStep({ existingTagSha: null, releaseExists: false })

  assert.doesNotMatch(run.log, /^git /m)
})

test('re-publishing the same version adds its assets instead of failing on the existing tag', posixOnly, () => {
  const run = runTagStep({ existingTagSha: 'a'.repeat(40), releaseExists: true })

  assert.equal(run.status, 0, run.stderr)
  // 先发 Windows、之后补发 macOS 是被支持的发布方式；第二次不该在收尾炸掉。
  assert.match(run.log, /gh release upload v9\.9\.9 .*--clobber/)
  // 正文不重写：发布者可能已经在上面补过话。
  assert.doesNotMatch(run.log, /gh release create/)
})

test('an annotated tag from an older release is dereferenced before it is compared', posixOnly, () => {
  const run = runTagStep({ existingTagSha: 'a'.repeat(40), releaseExists: true, annotated: true })

  // 漏掉解引用那一层，比对的就是 tag 对象的 id，永远不等于出包的 commit，
  // 补发会被判成「同一个版本号发过两份不同的产物」而停掉。
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.log, /gh api repos\/.*\/git\/tags\/f{40}/)
  assert.match(run.log, /gh release upload v9\.9\.9 .*--clobber/)
})

test('a tag left behind by a failed finish still gets its Release', posixOnly, () => {
  // 0.2.8 的收尾就停在两者之间：tag 推上去之前失败，Release 也没建。补发时
  // tag 可能已经在了而 Release 还没有，这一支不能报红。
  const run = runTagStep({ existingTagSha: 'a'.repeat(40), releaseExists: false })

  assert.equal(run.status, 0, run.stderr)
  assert.match(run.log, /gh release create v9\.9\.9/)
})

test('a tag that already points somewhere else stops the job instead of being moved', posixOnly, () => {
  const run = runTagStep({ existingTagSha: 'b'.repeat(40), releaseExists: true })

  // 同一个版本号发过两份不同的产物，这必须有人来看。
  assert.notEqual(run.status, 0)
  assert.match(run.stdout + run.stderr, /::error::/)
  assert.doesNotMatch(run.log, /gh release (create|upload)/)
})

test('the release tag is never moved or force-pushed', () => {
  const step = publishJob.steps.find((entry) => /Tag the commit that shipped/.test(entry.name || ''))

  // 移动一个已发布的 tag 会让所有按 tag 取源码的人拿到和当初不同的东西。
  assert.doesNotMatch(String(step.run), /git tag -f|--force|-d\s+"?v?\$/)
  // 注释里提到 git push 是在说明为什么不走它，所以只认行首的真命令。
  assert.doesNotMatch(String(step.run), /^\s*git push/m)
})


// #493：往更新目录写任何东西之前先确认这一版可以发。
const { PublishGuardError, assessPublish } = require('./publish-guard.cjs')

function manifestText(version, bytes, name = `XingMang-AI-Manager-${version}-Setup.exe`) {
  const sha512 = require('node:crypto').createHash('sha512').update(bytes).digest('base64')
  return YAML.stringify({ version, files: [{ url: name, sha512, size: Buffer.byteLength(bytes) }], path: name, sha512, releaseDate: '2026-09-24T00:00:00.000Z' })
}

test('the publish guard runs before the first upload', () => {
  const guard = stepIndex(publishJob, /Refuse to overwrite a version that already shipped/)
  const firstUpload = publishJob.steps.findIndex((step) => /aws s3 cp/.test(String(step.run || '')))
  assert.ok(guard >= 0 && firstUpload > guard, '同版本检查必须排在第一次上传之前')
})

test('the Windows manifest is signed before anything is checked or uploaded, and re-verified live', () => {
  // 签名要赶在同版本检查之前：检查比的就是这份要传上去的清单；也要赶在第一次上传
  // 之前，线上绝不能出现一份没签名的 Windows 清单——新客户端会全部拒装。
  const sign = stepIndex(publishJob, /update-manifest-signature\.cjs sign/)
  const guard = stepIndex(publishJob, /Refuse to overwrite a version that already shipped/)
  const firstUpload = publishJob.steps.findIndex((step) => /aws s3 cp/.test(String(step.run || '')))
  const manifest = stepIndex(publishJob, /Publish the update manifests/)
  const live = stepIndex(publishJob, /update-manifest-signature\.cjs verify/)
  assert.ok(sign >= 0 && sign < guard && sign < firstUpload, '签名必须排在同版本检查与第一次上传之前')
  assert.ok(live > manifest, '线上清单的签名复核必须排在清单发布之后')
  const step = publishJob.steps[sign]
  assert.equal(step.if, "${{ needs.windows-build.result == 'success' }}")
  assert.match(String(step.run), /--manifest release-artifacts\/latest\.yml$/)
  // 只签 Windows：macOS 由 Squirrel.Mac 按钉住的发布证书验签。
  assert.doesNotMatch(String(step.run), /latest-mac/)
  assert.deepEqual(Object.keys(step.env), ['XINGMANG_UPDATE_SIGNING_KEY'])
  // 签名私钥只给这一步，别的步骤一个都不许读到。
  const readers = publishJob.steps.filter((item) => /XINGMANG_UPDATE_SIGNING_KEY/.test(YAML.stringify(item)))
  assert.deepEqual(readers, [step])
})

test('the publish guard allows a first release, an upgrade and a rerun of the same build only', () => {
  const ours = manifestText('0.2.11', 'build A')
  assert.equal(assessPublish(ours, null, 'latest-mac.yml'), 'first')
  assert.equal(assessPublish(ours, manifestText('0.2.10', 'old'), 'latest-mac.yml'), 'upgrade')
  assert.equal(assessPublish(ours, ours, 'latest-mac.yml'), 'same')
  // 同一个版本号换一批字节：Mac 出包不可复现，重新出包就是这样。
  assert.throws(() => assessPublish(ours, manifestText('0.2.11', 'build B'), 'latest-mac.yml'), /不能换内容/)
  assert.throws(() => assessPublish(ours, manifestText('0.2.12', 'newer'), 'latest-mac.yml'), /更高的 0\.2\.12/)
  assert.throws(() => assessPublish(ours, null, 'latest-linux.yml'), PublishGuardError)
  assert.throws(() => assessPublish(ours, '<!doctype html><html></html>', 'latest-mac.yml'), /HTML/)
})

function runGuardStep({ existingTagSha = null, live = {}, artifacts }) {
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
  const ghStub = `#!/bin/bash
case "$2" in
  */git/ref/tags/*) ${existingTagSha ? `printf 'commit %s\\n' ${JSON.stringify(existingTagSha)}` : 'exit 1'} ;;
esac
exit 0
`
  // 最后一个参数是地址；按文件名去 live 目录里找，没有就是 404。
  const curlStub = `#!/bin/bash
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
  fs.rmSync(workspace, { recursive: true, force: true })
  return { status: result.status, output: result.stdout + result.stderr }
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
