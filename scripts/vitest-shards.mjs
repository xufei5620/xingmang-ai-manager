import { createHash } from 'node:crypto'

// `vitest --shard=i/n` sorts the test files by a hash of their path and cuts
// that list into n equal counts. Equal counts were never equal time on the
// Windows runners: a dozen electron/ suites that write real files under
// Defender take 13 to 170 seconds each, while the other ~630 files average
// under one. On main f4b0d2a the hash put four of the five slowest
// (external-client-service, config-files, system-service and
// claude-desktop-config, 573s between them) into the first of three shards,
// which ran 12.7 minutes against its 15 while the other two took 6.0 and 4.1;
// #1287's first shard then ran out the 15 with every test passing. Cutting the
// same list in four would not have helped: the hash keeps those files close
// together, so --shard=2/4 would have held 670s of them on its own.
//
// So the vitest config deals the files instead (MeasuredShardSequencer in
// vitest.config.ts). The suites measured below go out first, slowest first,
// each to the shard holding the least time so far; every other file follows
// at unmeasuredSeconds, in hash order, the same way. Each runner computes the
// same deal from the same file list, so the shards are still a partition
// whose union is exactly the unsharded run, as --shard's slices were.
//
// The seconds are how long each file holds its shard on windows-latest: the
// gap between its line in the shard's log and the line before it (the first
// file's gap starts at vitest's RUN line), so they add up to the Duration
// vitest prints at the end. The time vitest prints after a file's name leaves
// out loading the file: electron/system-service.in-place-update.test.ts prints
// 0.0s yet holds its shard 9 seconds, electron/new-api-client.test.ts 0.5s
// against 8. They only need to be roughly right. List any file that takes more
// than about five seconds; re-measure when one shard drifts minutes past its
// siblings. An entry whose file is gone fails scripts/ci-workflow-config.test.cjs
// rather than quietly weighing nothing.
//
// Re-measured on the evening of 2026-11-20, each entry the median of five main
// runs newer than the morning's table (44707089493, 44721036143, 44726568338,
// 44727305107 and 44736733273). In three of the four dealt from that table the
// second shard ran 12.2 to 12.6 minutes while the other three took 6.6 to
// 11.1: external-client-service, which it had at 194 seconds, held that shard
// 268 to 303. On #2000 the runner then slowed down for a few minutes in the
// middle of that file, its tests six to fifteen times their usual time, and
// the shard ran out its 15 minutes, the second time in two days (#1946, #2006).
// One file cannot be dealt to two shards, so its four describe blocks are now
// four files: external-client-service.test.ts and its .route-follow,
// .key-follow and .account-follow siblings, at 46, 87, 81 and 58 seconds
// below. Dealt from this table, the same medians come to 9.2 to 9.9 minutes a
// shard, and each of the five runs' own times to 8.3 to 11.6.
//
// What the table cannot even out is the runner. The suites that write the
// most files take half as long again on a slow windows-latest machine as on a
// fast one, every test of them alike: in the runs above the old
// external-client-service file took 168 and 196 seconds in two and 268 to 303
// in the other three, and config-files 150 to 251. A shard that draws a slow
// machine runs a minute or two past its siblings whatever the deal; re-measure
// for a shard that is long run after run, not for one long run. A file that
// holds its shard well past three minutes is worth splitting by describe, as
// external-client-service was, so that a slow stretch lands on part of it.
export const measuredSeconds = {
  'electron/config-files.test.ts': 200,
  'electron/system-service.test.ts': 147,
  'electron/tool-config-ownership.test.ts': 114,
  'electron/claude-desktop-config.test.ts': 102,
  'electron/system-service-tool-route.test.ts': 91,
  'electron/external-client-service.route-follow.test.ts': 87,
  'electron/external-client-service.key-follow.test.ts': 81,
  'electron/codex-remote-service.test.ts': 69,
  'electron/external-client-service.account-follow.test.ts': 58,
  'electron/xingmang-ai-skill.test.ts': 50,
  'electron/external-client-service.test.ts': 46,
  'electron/backups.test.ts': 35,
  'electron/config-save-service.test.ts': 23,
  'electron/codex-provider-isolation.test.ts': 19,
  'electron/canvas-project-store.test.ts': 15,
  'electron/diagnostics.test.ts': 15,
  'electron/acceleration-development-backend.test.ts': 13,
  'electron/ai-asset-metadata-store.test.ts': 11,
  'electron/codex-plugin-catalog.test.ts': 10,
  'electron/system-service.config-write-queue.test.ts': 10,
  'electron/app-settings.test.ts': 9,
  'electron/ipc.test.ts': 9,
  'electron/system-service.in-place-update.test.ts': 9,
  'electron/codex-config-migration.test.ts': 8,
  'electron/codex-extensions.test.ts': 8,
  'electron/new-api-client.test.ts': 8,
  'electron/claude-desktop-model-repair.test.ts': 7,
  'electron/cli-process-probe.test.ts': 7,
  'electron/external-tool-config.test.ts': 7,
  'electron/uninstall-leftovers.test.ts': 7,
  'electron/acceleration-mihomo-runtime.test.ts': 6,
  'electron/acceleration-preference-store.test.ts': 6,
  'electron/ai-chat-history-store.test.ts': 6,
  'electron/codex-desktop-service.test.ts': 6,
  'electron/codex-sessions.test.ts': 6,
  'electron/official-credential-service.test.ts': 6,
  'electron/runtime-log.test.ts': 6,
  'electron/system-service.locale.test.ts': 5,
  'canvas-v2/src/video-tools/video-app-workflow.test.ts': 43,
  'canvas-v2/src/image-tools/annotation-app.test.ts': 39,
  'canvas-v2/src/editor/asset-placement-app.test.ts': 27,
  'canvas-v2/src/editor/output-image-app.test.ts': 26,
  'canvas-v2/src/editor/frame-selection-app.test.ts': 24,
  'canvas-v2/src/editor/group-selection-app.test.ts': 13,
  'canvas-v2/src/image-tools/mask-asset-app.test.ts': 11,
  'canvas-v2/src/editor/run-result-collection-app.test.ts': 10,
  'canvas-v2/src/library/asset-library-app.test.ts': 9,
  'canvas-v2/src/storyboard/storyboard-app-application.test.ts': 9,
  'canvas-v2/src/editor/frame-sequence-app.test.ts': 8,
  'canvas-v2/src/editor/quick-node-placement-app.test.ts': 8,
  'canvas-v2/src/editor/workshop-setup-app.test.ts': 8,
  'canvas-v2/src/editor/agent-image-context-app.test.ts': 6,
  'canvas-v2/src/editor/text-session-app.test.ts': 6,
  'canvas-v2/src/library/layer-filter-presentation-pixels.test.ts': 6,
  'canvas-v2/src/runtime/node-source-routing.test.ts': 6,
  'canvas-v2/src/store/viewer-settings-routing-app.test.ts': 6,
}

// Every other file, measured the same way, held its shard 0.60 seconds on
// average in those runs (half of them under 0.29).
export const unmeasuredSeconds = 0.6

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

/** 按实测用时把测试文件发给 `count` 份：返回与 `paths` 一一对应的份号（从 1 数）。 */
export function dealTestFiles(paths, count, seconds = measuredSeconds) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`shard count must be a positive integer; got ${count}`)
  const loads = new Array(count).fill(0)
  const shards = new Array(paths.length)
  const order = paths
    .map((file, position) => ({
      file,
      position,
      weight: seconds[file] ?? unmeasuredSeconds,
      hash: createHash('sha1').update(file).digest('hex'),
    }))
    .sort((left, right) => right.weight - left.weight || compareText(left.hash, right.hash) || compareText(left.file, right.file))
  for (const entry of order) {
    let lightest = 0
    for (let index = 1; index < count; index += 1) {
      if (loads[index] < loads[lightest]) lightest = index
    }
    loads[lightest] += entry.weight
    shards[entry.position] = lightest + 1
  }
  return shards
}
