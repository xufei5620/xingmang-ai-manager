const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('node:child_process')
const YAML = require('yaml')
const {
  StatusInputError,
  applyAccountGroups,
  applyBadVersions,
  applyCliModels,
  applyMinimumVersion,
  applyRollout,
  applyStatusChanges,
  describeStatus,
  describeStatusWarnings,
  escapeWorkflowCommand,
  normalizeUntil,
  parseCurrentStatus,
  parsePublishedDates,
} = require('./service-status.cjs')

const now = new Date('2026-09-23T08:00:00.000Z')

test('turning maintenance on writes an active block with the message and a UTC end time', () => {
  const next = applyStatusChanges({}, { maintenance: 'on', message: ' 服务升级中，\n预计 23:00 恢复 ', until: '2026-09-23 23:00' }, now)
  assert.deepEqual(next.maintenance, { active: true, message: '服务升级中， 预计 23:00 恢复', until: '2026-09-23T15:00:00.000Z' })
  assert.equal(next.updatedAt, now.toISOString())
  assert.deepEqual(describeStatus(next).slice(0, 1), ['维护：打开，说明「服务升级中， 预计 23:00 恢复」，2026-09-23T15:00:00.000Z 自动结束'])
})

test('turning maintenance off removes the block but keeps every other field', () => {
  const current = { maintenance: { active: true, message: 'x' }, badVersions: ['0.2.10'], custom: 1 }
  const next = applyStatusChanges(current, { maintenance: 'off' }, now)
  assert.equal(next.maintenance, undefined)
  assert.deepEqual(next.badVersions, ['0.2.10'])
  assert.equal(next.custom, 1)
})

test('keep leaves maintenance alone and refuses a message that would go nowhere', () => {
  const current = { maintenance: { active: true, message: 'x' } }
  assert.deepEqual(applyStatusChanges(current, { maintenance: 'keep', message: '', until: '' }, now).maintenance, current.maintenance)
  assert.throws(() => applyStatusChanges(current, { maintenance: 'keep', message: 'y' }, now), StatusInputError)
})

test('rejects an end time that is unreadable or already past, and an overlong message', () => {
  assert.throws(() => normalizeUntil('tonight', now), /看不懂这个时间/)
  assert.throws(() => normalizeUntil('2026-09-23 15:59', now), /已经过去了/)
  assert.equal(normalizeUntil('2026-09-24T00:00:00+08:00', now), '2026-09-23T16:00:00.000Z')
  assert.throws(() => applyStatusChanges({}, { maintenance: 'on', message: '长'.repeat(201) }, now), /最多 200 个字/)
  assert.throws(() => applyStatusChanges({}, { maintenance: 'maybe' }, now), /on \/ off \/ keep/)
})

test('only a live file that does not exist starts from a blank status', () => {
  assert.deepEqual(parseCurrentStatus(null), {})
  assert.deepEqual(parseCurrentStatus('\uFEFF{"a":1}'), { a: 1 })
  // #500：200 回来却读不懂，多半是缓存或路由回了网页，线上真正的文件里可能还有撤回名单。
  for (const text of ['', '  \n', '<!doctype html><html></html>', 'not json', '[]', 'null', '"text"', '42']) {
    assert.throws(() => parseCurrentStatus(text), StatusInputError, JSON.stringify(text))
  }
})

test('a corrupt live file stops the script before anything is written', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-status-'))
  try {
    const current = path.join(directory, 'current.json')
    const output = path.join(directory, 'service-status.json')
    const script = path.join(__dirname, 'service-status.cjs')
    fs.writeFileSync(current, '<html>502 Bad Gateway</html>')
    const corrupt = spawnSync(process.execPath, [script, '--current', current, '--output', output, '--maintenance', 'off'], { encoding: 'utf8' })
    assert.equal(corrupt.status, 1)
    assert.match(corrupt.stderr, /不是有效的 JSON 对象/)
    assert.equal(fs.existsSync(output), false)

    // 有效的文件：只改这次填的，撤回名单与分批放量原样留着。
    fs.writeFileSync(current, JSON.stringify({ badVersions: ['0.2.10'], rollout: { version: '0.2.11', percent: 20 }, extra: 1 }))
    const valid = spawnSync(process.execPath, [script, '--current', current, '--output', output, '--maintenance', 'off'], { encoding: 'utf8' })
    assert.equal(valid.status, 0, valid.stderr)
    const written = JSON.parse(fs.readFileSync(output, 'utf8'))
    assert.deepEqual(written.badVersions, ['0.2.10'])
    assert.deepEqual(written.rollout, { version: '0.2.11', percent: 20 })
    assert.equal(written.extra, 1)

    // 线上 404：工作流删掉 current.json，从空白开始。
    fs.rmSync(current)
    const missing = spawnSync(process.execPath, [script, '--current', current, '--output', output, '--maintenance', 'off'], { encoding: 'utf8' })
    assert.equal(missing.status, 0, missing.stderr)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('the workflow keeps free text out of the shell and publishes only the status file', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'service-status.yml'), 'utf8')
  const workflow = YAML.parse(source)
  const job = workflow.jobs.publish
  assert.equal(job.environment, 'release')
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  for (const step of Object.values(workflow.jobs).flatMap((entry) => entry.steps)) {
    assert.doesNotMatch(step.run ?? '', /\$\{\{\s*(inputs|github\.event)\./, `${step.name} must read inputs through env`)
  }
  const uploads = job.steps.filter((step) => /aws s3/.test(step.run ?? ''))
  assert.equal(uploads.length, 1)
  assert.match(uploads[0].run, /\$OBJECT_PREFIX\/service-status\.json/)
  assert.match(uploads[0].run, /--cache-control 'no-cache'/)
  assert.doesNotMatch(uploads[0].run, /latest(?:-[a-z0-9-]+)?\.yml/)
})

test('withdrawn versions are added, removed one by one, or cleared, never silently replaced', () => {
  assert.deepEqual(applyBadVersions(['0.2.8'], '0.2.10, v0.2.11'), ['0.2.8', '0.2.10', '0.2.11'])
  assert.deepEqual(applyBadVersions(['0.2.8', '0.2.10'], '-0.2.8'), ['0.2.10'])
  assert.deepEqual(applyBadVersions(['0.2.8'], 'none'), [])
  assert.deepEqual(applyBadVersions(['0.2.8'], ''), ['0.2.8'])
  assert.throws(() => applyBadVersions([], 'latest'), /0\.2\.10 这样/)
  const next = applyStatusChanges({ badVersions: ['0.2.8'] }, { 'bad-versions': 'none' }, now)
  assert.equal(next.badVersions, undefined)
})

test('a staged rollout names a version and a share of machines', () => {
  assert.deepEqual(applyRollout(undefined, '0.2.11 20'), { version: '0.2.11', percent: 20 })
  assert.deepEqual(applyRollout(undefined, 'v0.2.11 100%'), { version: '0.2.11', percent: 100 })
  assert.equal(applyRollout({ version: '0.2.11', percent: 20 }, 'none'), undefined)
  assert.throws(() => applyRollout(undefined, '0.2.11'), /版本号 空格 百分比/)
  assert.throws(() => applyRollout(undefined, '0.2.11 150'), /最多 100/)
  const next = applyStatusChanges({}, { rollout: '0.2.11 20' }, now)
  assert.deepEqual(describeStatus(next).slice(1), ['撤回的版本：无', '分批放量：0.2.11 先给 20% 的电脑', '最低版本：无', '换线路时：只改工具配置里的地址', '型号表：无（客户端用程序自带的）', '分组对照：无（客户端按写死的名字认）'])
})

test('a zero rollout reads as manual checks only', () => {
  assert.deepEqual(applyRollout(undefined, '0.2.18 0'), { version: '0.2.18', percent: 0 })
  const next = applyStatusChanges({}, { rollout: '0.2.18 0' }, now)
  assert.equal(describeStatus(next)[2], '分批放量：0.2.18 先不自动推，只给自己点「检查更新」的人')
})

test('a minimum version never goes above what the feed is publishing', () => {
  assert.equal(applyMinimumVersion(undefined, 'v0.2.12', ['0.2.12', '0.2.13']), '0.2.12')
  assert.equal(applyMinimumVersion('0.2.12', '', []), '0.2.12')
  assert.equal(applyMinimumVersion('0.2.12', 'none', []), undefined)
  assert.throws(() => applyMinimumVersion(undefined, '0.2.13', ['0.2.12', '0.2.13']), /比线上正在发的 0\.2\.12、0\.2\.13 还高/)
  assert.throws(() => applyMinimumVersion(undefined, '0.2.12', []), /读不到线上的更新清单/)
  assert.throws(() => applyMinimumVersion(undefined, '0.2.12-beta', ['0.2.12']), /0\.2\.10 这样/)
  const next = applyStatusChanges({ badVersions: ['0.2.10'] }, { 'minimum-version': '0.2.11', 'published-versions': '0.2.11 0.2.11' }, now)
  assert.equal(next.minimumVersion, '0.2.11')
  assert.deepEqual(next.badVersions, ['0.2.10'])
  assert.equal(describeStatus(next)[3], '最低版本：0.2.11（更低的必须先更新，只有 0.2.11 及以后的客户端认）')
  assert.equal(applyStatusChanges(next, { 'minimum-version': 'none' }, now).minimumVersion, undefined)
})

test('the workflow checks the live manifests before it sets a minimum version', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'service-status.yml'), 'utf8'))
  assert.ok(workflow.on.workflow_dispatch.inputs.minimum_version)
  const steps = workflow.jobs.publish.steps
  const build = steps.find((step) => /service-status\.cjs/.test(step.run ?? ''))
  assert.match(build.run, /--minimum-version "\$MINIMUM_VERSION"/)
  assert.match(build.run, /--published-versions "\$PUBLISHED_VERSIONS"/)
  assert.equal(build.env.MINIMUM_VERSION, '${{ inputs.minimum_version }}')
  const manifests = steps.findIndex((step) => /latest-mac\.yml/.test(step.run ?? ''))
  assert.ok(manifests >= 0 && manifests < steps.indexOf(build))
  // 每个平台都要读，Linux 两个架构各一份：漏读 Linux 的话，最低版本可能被设得比线上
  // Linux 正在发的还高，Linux 客户就被挡在门外、又找不到能装的新版本。没发过的平台
  // 404 跳过。
  const { UPDATE_MANIFEST_NAMES } = require('./update-release-utils.cjs')
  assert.ok(steps[manifests].run.includes(`for manifest in ${UPDATE_MANIFEST_NAMES.join(' ')}; do`))
  assert.match(steps[manifests].run, /404\) echo "线上没有 \$manifest，跳过这个平台"/)
})

test('the tool route rewrite switch writes merge, drops the field for targeted and keeps it otherwise', () => {
  const merged = applyStatusChanges({ badVersions: ['0.2.10'] }, { 'tool-route-rewrite': 'merge' }, now)
  assert.equal(merged.toolRouteRewrite, 'merge')
  assert.deepEqual(merged.badVersions, ['0.2.10'])
  assert.equal(describeStatus(merged)[4], '换线路时：整份重写工具配置（老办法，只有 0.2.18 及以后的客户端认）')
  assert.equal(applyStatusChanges(merged, { 'tool-route-rewrite': 'keep' }, now).toolRouteRewrite, 'merge')
  assert.equal(applyStatusChanges(merged, {}, now).toolRouteRewrite, 'merge')
  assert.equal('toolRouteRewrite' in applyStatusChanges(merged, { 'tool-route-rewrite': 'targeted' }, now), false)
  assert.throws(() => applyStatusChanges({}, { 'tool-route-rewrite': 'full' }, now), StatusInputError)
})

test('the workflow offers the tool route rewrite switch and passes only its keyword to the script', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'service-status.yml'), 'utf8'))
  const input = workflow.on.workflow_dispatch.inputs.tool_route_rewrite
  assert.equal(input.default, 'keep: 不改')
  assert.deepEqual(input.options.map((option) => option.split(':')[0]), ['keep', 'targeted', 'merge'])
  const build = workflow.jobs.publish.steps.find((step) => step.name === 'Build the new status file')
  assert.equal(build.env.TOOL_ROUTE_REWRITE, '${{ inputs.tool_route_rewrite }}')
  assert.match(build.run, /--tool-route-rewrite "\$\{TOOL_ROUTE_REWRITE%%:\*\}"/)
})

test('the account group map sets only the roles it names and keeps the rest of the live file', () => {
  const current = { badVersions: ['0.2.10'], accountGroups: { claude: ['Claude-MAX订阅'], grok: ['Grok-中转/订阅'] } }
  const next = applyStatusChanges(current, { 'account-groups': 'codex=GPT 主力|GPT-中转/订阅； image = 画图专线 | 图片模型-中转/订阅' }, now)
  assert.deepEqual(next.accountGroups, {
    claude: ['Claude-MAX订阅'],
    codex: ['GPT 主力', 'GPT-中转/订阅'],
    grok: ['Grok-中转/订阅'],
    image: ['画图专线', '图片模型-中转/订阅'],
  })
  assert.deepEqual(next.badVersions, ['0.2.10'])
  assert.equal(describeStatus(next).at(-1), '分组对照：Claude Code 用「Claude-MAX订阅」；Codex 用「GPT 主力」，没有再用「GPT-中转/订阅」；Grok 用「Grok-中转/订阅」；画图 用「画图专线」，没有再用「图片模型-中转/订阅」（只有 0.2.19 及以后的客户端认）')
  assert.deepEqual(applyStatusChanges(next, {}, now).accountGroups, next.accountGroups)
})

test('the account group map drops one role or the whole map on none', () => {
  const current = { accountGroups: { claude: ['Claude 主力'], codex: ['GPT 主力'] } }
  assert.deepEqual(applyAccountGroups(current.accountGroups, 'claude=none'), { codex: ['GPT 主力'] })
  assert.equal(applyAccountGroups({ codex: ['GPT 主力'] }, 'codex=none'), undefined)
  const cleared = applyStatusChanges(current, { 'account-groups': 'none' }, now)
  assert.equal('accountGroups' in cleared, false)
  assert.equal(describeStatus(cleared).at(-1), '分组对照：无（客户端按写死的名字认）')
})

test('the account group map refuses anything the client would quietly skip', () => {
  for (const input of ['gemini=Gemini-中转/订阅', 'video=视频模型-中转/订阅', 'codex', 'codex=GPT 主力||GPT-中转/订阅', `codex=${'x'.repeat(129)}`, 'codex=坏\u0007名字', `codex=${Array.from({ length: 9 }, (_, index) => `GPT ${index}`).join('|')}`]) {
    assert.throws(() => applyAccountGroups({}, input), StatusInputError, input)
  }
})

test('the workflow offers the account group map and hands it to the script through the environment', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'service-status.yml'), 'utf8'))
  const inputs = workflow.on.workflow_dispatch.inputs
  assert.equal(inputs.account_groups.type, 'string')
  assert.equal(inputs.account_groups.required, false)
  // GitHub 手动运行最多 10 个输入，再加之前先合并旧的。
  assert.ok(Object.keys(inputs).length <= 10)
  const build = workflow.jobs.publish.steps.find((step) => step.name === 'Build the new status file')
  assert.equal(build.env.ACCOUNT_GROUPS, '${{ inputs.account_groups }}')
  assert.match(build.run, /--account-groups "\$ACCOUNT_GROUPS"/)
})

test('the model table sets only the fields it names and keeps the rest of the live file', () => {
  const current = { badVersions: ['0.2.10'], cliModels: { claude: { previous: ['claude-opus-5'] }, codex: { default: 'gpt-6-astra', retired: ['gpt-5.5'] } } }
  const next = applyStatusChanges(current, { 'cli-models': 'codex.default=gpt-7； codex.previous = gpt-6-astra ; grok.retired=grok-4.6|grok-4.5' }, now)
  assert.deepEqual(next.cliModels, {
    claude: { previous: ['claude-opus-5'] },
    codex: { default: 'gpt-7', retired: ['gpt-5.5'], previous: ['gpt-6-astra'] },
    grok: { retired: ['grok-4.6', 'grok-4.5'] },
  })
  assert.deepEqual(next.badVersions, ['0.2.10'])
  assert.equal(describeStatus(next).at(-2), '型号表：Claude Code 上一代 claude-opus-5；Codex 默认 gpt-7，上一代 gpt-6-astra，已下架 gpt-5.5；Grok 已下架 grok-4.6、grok-4.5（没写的照程序自带的，只有 0.2.20 及以后的客户端认）')
  assert.deepEqual(applyStatusChanges(next, {}, now).cliModels, next.cliModels)
})

test('the model table drops a field, a tool or the whole table on none', () => {
  const current = { claude: { default: 'claude-opus-5-5', previous: ['claude-opus-5'] }, codex: { default: 'gpt-7' } }
  assert.deepEqual(applyCliModels(current, 'claude.previous=none'), { claude: { default: 'claude-opus-5-5' }, codex: { default: 'gpt-7' } })
  assert.deepEqual(applyCliModels(current, 'claude=none'), { codex: { default: 'gpt-7' } })
  assert.equal(applyCliModels({ codex: { default: 'gpt-7' } }, 'codex.default=none'), undefined)
  const cleared = applyStatusChanges({ cliModels: current }, { 'cli-models': 'none' }, now)
  assert.equal('cliModels' in cleared, false)
  assert.equal(describeStatus(cleared).at(-2), '型号表：无（客户端用程序自带的）')
})

test('the model table refuses anything the client would quietly skip or contradict', () => {
  for (const input of [
    'gemini.default=gemini-4', 'image.default=gpt-image-3', 'codex', 'codex=gpt-7', 'codex.latest=gpt-7',
    'codex.default=gpt-7|gpt-8', 'codex.default=gpt 7', 'codex.previous=gpt-6-astra||gpt-6-sol', 'codex.retired=gpt-5.5"',
    `codex.default=${'x'.repeat(129)}`, `codex.previous=${Array.from({ length: 9 }, (_, index) => `gpt-${index}`).join('|')}`,
    'codex.default=gpt-7; codex.retired=gpt-7', 'codex.default=gpt-7; codex.previous=gpt-7', 'codex.previous=gpt-6; codex.retired=gpt-6',
  ]) {
    assert.throws(() => applyCliModels({}, input), StatusInputError, input)
  }
  // 和线上已有的那几样合起来才矛盾，也要当场报出来。
  assert.throws(() => applyCliModels({ codex: { default: 'gpt-7' } }, 'codex.retired=gpt-7'), /同时写在下架名单里/)
})

test('the workflow offers the model table and hands it to the script through the environment', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'service-status.yml'), 'utf8'))
  const inputs = workflow.on.workflow_dispatch.inputs
  assert.equal(inputs.cli_models.type, 'string')
  assert.equal(inputs.cli_models.required, false)
  assert.ok(Object.keys(inputs).length <= 10)
  const build = workflow.jobs.publish.steps.find((step) => step.name === 'Build the new status file')
  assert.equal(build.env.CLI_MODELS, '${{ inputs.cli_models }}')
  assert.match(build.run, /--cli-models "\$CLI_MODELS"/)
})

test('release dates from the manifests keep the newest per version and skip what they cannot read', () => {
  const dates = parsePublishedDates(' 0.2.19=2026-10-16T18:00:00.000Z v0.2.19=2026-10-16T18:40:00.000Z 0.2.18=2026-10-10T00:00:00Z =2026-10-16T00:00:00Z 0.2.20= 0.2=2026-10-16T00:00:00Z 0.2.21=yesterday')
  assert.deepEqual([...dates], [['0.2.19', Date.parse('2026-10-16T18:40:00.000Z')], ['0.2.18', Date.parse('2026-10-10T00:00:00Z')]])
  assert.equal(parsePublishedDates(undefined).size, 0)
})

// #1114：0.2.19 发出去 12 分钟，一次运行就清掉「先给两成」、又把最低版本抬到 0.2.19。
const releasedAt = '2026-10-16T18:40:00.000Z'
function minutesAfterRelease(minutes) {
  return new Date(Date.parse(releasedAt) + minutes * 60 * 1000)
}

test('raising the minimum to a package that is not a day old warns but still publishes', () => {
  const current = { minimumVersion: '0.2.11' }
  const changes = { 'minimum-version': '0.2.19', 'published-versions': '0.2.19 0.2.19', 'published-dates': `0.2.19=${releasedAt} 0.2.19=2026-10-16T18:20:00.000Z` }
  const next = applyStatusChanges(current, changes, minutesAfterRelease(29))
  assert.equal(next.minimumVersion, '0.2.19')
  const [warning, ...rest] = describeStatusWarnings(current, next, changes, minutesAfterRelease(29))
  assert.deepEqual(rest, [])
  assert.match(warning, /^最低版本 0\.2\.19 的包出来还不到 1 小时（按更新清单里的出包时间算）/)
  assert.match(warning, /服务端已经先改了、旧版本不能用了/)
  assert.match(describeStatusWarnings(current, next, changes, minutesAfterRelease(23 * 60 + 59))[0], /出来才 23 小时/)
  assert.deepEqual(describeStatusWarnings(current, next, changes, minutesAfterRelease(24 * 60)), [])
})

test('the fresh minimum warning stays quiet when nothing about the minimum changes or its age is unknown', () => {
  const changes = { 'minimum-version': '0.2.19', 'published-versions': '0.2.19', 'published-dates': `0.2.19=${releasedAt}` }
  const now = minutesAfterRelease(12)
  // 原样重填一遍：客户那边什么都不变。
  const same = { minimumVersion: '0.2.19' }
  assert.deepEqual(describeStatusWarnings(same, applyStatusChanges(same, changes, now), changes, now), [])
  // 取消最低版本、这次没碰最低版本，都不提醒。
  assert.deepEqual(describeStatusWarnings(same, applyStatusChanges(same, { 'minimum-version': 'none' }, now), {}, now), [])
  assert.deepEqual(describeStatusWarnings(same, applyStatusChanges(same, { maintenance: 'off' }, now), {}, now), [])
  // 清单里没有出包时间，或者最低版本比线上正在发的旧：看不出它出来多久，不猜。
  const older = { 'minimum-version': '0.2.18', 'published-versions': '0.2.19', 'published-dates': `0.2.19=${releasedAt}` }
  assert.deepEqual(describeStatusWarnings({}, applyStatusChanges({}, older, now), older, now), [])
  const undated = { ...changes, 'published-dates': '0.2.19=' }
  assert.deepEqual(describeStatusWarnings({}, applyStatusChanges({}, undated, now), undated, now), [])
})

test('clearing a staged rollout in the same run that sets a minimum warns and names the rollout it removed', () => {
  const now = minutesAfterRelease(24 * 60 * 3)
  const changes = { rollout: 'none', 'minimum-version': '0.2.19', 'published-versions': '0.2.19', 'published-dates': `0.2.19=${releasedAt}` }
  for (const [rollout, label] of [[{ version: '0.2.19', percent: 20 }, '0.2.19 先给 20% 的电脑'], [{ version: '0.2.19', percent: 0 }, '0.2.19 先不自动推，只给自己点「检查更新」的人']]) {
    const current = { rollout }
    const next = applyStatusChanges(current, changes, now)
    assert.equal(next.rollout, undefined)
    assert.deepEqual(describeStatusWarnings(current, next, changes, now), [`这一次把分批放量（原来是「${label}」）清掉、全部放开，同时又把最低版本设成 0.2.19：新版本一次就到所有人手上，分批观察这一步等于跳过。不是非这样不可的，先 Reject，分两次跑：先放开观察，再设最低版本。`])
  }
  // 已经全放开的、线上本来就没有放量的、只清放量不设最低版本的，都不提醒。
  for (const [current, input] of [[{ rollout: { version: '0.2.19', percent: 100 } }, changes], [{}, changes], [{ rollout: { version: '0.2.19', percent: 20 } }, { rollout: 'none' }]]) {
    assert.deepEqual(describeStatusWarnings(current, applyStatusChanges(current, input, now), input, now), [], JSON.stringify([current, input]))
  }
})

test('the 0.2.19 run raises both warnings', () => {
  const current = { rollout: { version: '0.2.19', percent: 20 }, minimumVersion: '0.2.11' }
  const changes = { rollout: 'none', 'minimum-version': '0.2.19', 'published-versions': '0.2.19 0.2.19 0.2.19', 'published-dates': `0.2.19=${releasedAt} 0.2.19=${releasedAt}` }
  const now = minutesAfterRelease(12)
  const warnings = describeStatusWarnings(current, applyStatusChanges(current, changes, now), changes, now)
  assert.equal(warnings.length, 2)
  assert.match(warnings[0], /^最低版本 0\.2\.19 的包出来还不到 1 小时/)
  assert.match(warnings[1], /^这一次把分批放量（原来是「0\.2\.19 先给 20% 的电脑」）清掉/)
})

test('the script prints the warnings as workflow annotations and writes the approval summary', () => {
  assert.equal(escapeWorkflowCommand('先给 20% 的电脑\r\n下一行'), '先给 20%25 的电脑%0D%0A下一行')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-status-'))
  try {
    const current = path.join(directory, 'current.json')
    const output = path.join(directory, 'service-status.json')
    const summary = path.join(directory, 'summary.md')
    const script = path.join(__dirname, 'service-status.cjs')
    fs.writeFileSync(current, JSON.stringify({ rollout: { version: '0.2.19', percent: 20 } }))
    const released = new Date(Date.now() - 2 * 60 * 60 * 1000 - 60 * 1000).toISOString()
    const run = spawnSync(process.execPath, [script, '--current', current, '--output', output, '--rollout', 'none', '--minimum-version', '0.2.19', '--published-versions', ' 0.2.19', '--published-dates', ` 0.2.19=${released}`, '--summary', summary], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).minimumVersion, '0.2.19')
    const annotations = run.stdout.split('\n').filter((line) => line.startsWith('::warning::'))
    assert.equal(annotations.length, 2)
    assert.match(annotations[0], /^::warning::最低版本 0\.2\.19 的包出来才 2 小时/)
    assert.match(annotations[1], /「0\.2\.19 先给 20%25 的电脑」/)
    const markdown = fs.readFileSync(summary, 'utf8')
    assert.match(markdown, /^### 批准以后，线上的状态文件会是这样\n\n- 维护：关闭\n/)
    assert.match(markdown, /\n- 最低版本：0\.2\.19（/)
    assert.match(markdown, /\n#### ⚠️ 批之前看一眼\n\n- 最低版本 0\.2\.19 的包出来才 2 小时/)
    assert.match(markdown, /「0\.2\.19 先给 20% 的电脑」/)

    // 没什么要提醒的：只有摘要，没有警告。
    fs.rmSync(summary)
    const quiet = spawnSync(process.execPath, [script, '--current', current, '--output', output, '--maintenance', 'off', '--summary', summary], { encoding: 'utf8' })
    assert.equal(quiet.status, 0, quiet.stderr)
    assert.doesNotMatch(quiet.stdout, /::warning::/)
    assert.doesNotMatch(fs.readFileSync(summary, 'utf8'), /批之前看一眼/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a preview job shows the approver what will be published before the approval gate, without any credentials', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'service-status.yml'), 'utf8'))
  const { preview, publish } = workflow.jobs
  // 批准挂在 publish 上、等预览跑完才开始等；预览自己不挂环境、不碰 secret、不写线上，权限照全局只读。
  assert.equal(publish.needs, 'preview')
  assert.equal(publish.environment, 'release')
  assert.equal(preview.environment, undefined)
  assert.equal(preview.permissions, undefined)
  assert.equal(preview.concurrency, undefined)
  assert.doesNotMatch(JSON.stringify(preview), /secrets\.|aws |s3:\/\/|AWS_|R2_/)
  for (const step of preview.steps) {
    assert.doesNotMatch(step.run ?? '', /\$\{\{\s*(inputs|github\.event)\./, `${step.name} must read inputs through env`)
  }
  // 读线上的几步与 publish 一字不差，预览算的才是批了以后 publish 会算的。
  for (const name of ['Resolve the address clients read the status file from', 'Fetch the status file that is live now', 'Read the versions the feed is publishing now']) {
    const ours = preview.steps.find((step) => step.name === name)
    assert.ok(ours, name)
    assert.deepEqual(ours, publish.steps.find((step) => step.name === name), name)
  }
  const build = publish.steps.find((step) => step.name === 'Build the new status file')
  const show = preview.steps.find((step) => step.name === 'Show the approver what this run would publish')
  assert.deepEqual(show.env, build.env)
  const argumentsOf = (run) => run.match(/--[a-z-]+ "[^"]*"/g)
  assert.deepEqual(argumentsOf(show.run), [...argumentsOf(build.run), '--summary "$GITHUB_STEP_SUMMARY"'])
  assert.equal(build.env.PUBLISHED_DATES, '${{ steps.published.outputs.dates }}')
  assert.match(build.run, /--published-dates "\$PUBLISHED_DATES"/)
  const manifests = publish.steps.find((step) => step.id === 'published')
  assert.match(manifests.run, /released=\$\(sed -n 's\/\^releaseDate:/)
  assert.match(manifests.run, /echo "dates=\$dates" >> "\$GITHUB_OUTPUT"/)
})
