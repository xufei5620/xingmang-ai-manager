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
// out loading the file: src/pages/SettingsPage.test.ts prints 0.0s yet holds
// its shard 8 seconds, electron/new-api-client.test.ts 0.5s against 9. They
// only need to be roughly right. List any file that takes more than about
// five seconds; re-measure when one shard drifts minutes past its siblings.
// An entry whose file is gone fails scripts/ci-workflow-config.test.cjs rather
// than quietly weighing nothing.
//
// Re-measured on 2026-11-20, each entry the median of five main runs
// (44619770642, 44626464746, 44629987862, 44639983709 and 44651364111). The
// 11-19 table had config-files at 278 seconds and system-service at 170,
// which these runs took 222 and 134 for, and four files it dealt to one shard
// (claude-desktop-config, tool-config-ownership, codex-remote-service and
// backups) at 280 between them, which took 390. So that shard got about two
// minutes more than its siblings: weighed by these runs' medians the four
// came to 9.3, 9.8, 8.8 and 11.6 minutes, and that one ran 11.7 to 12.7 in
// four of the five. Dealt from the table below, the same medians come to 9.8
// to 10.0 a shard.
//
// What the table cannot even out is the runner. The suites that write the
// most files take half as long again on a slow windows-latest machine as on a
// fast one, every test of them alike: external-client-service ran 182 to 194
// seconds in three of the runs above and 286 and 287 in the other two, and
// config-files 179 to 298. A shard that draws a slow machine runs a minute or
// two past its siblings whatever the deal; re-measure for a shard that is
// long run after run, not for one long run.
export const measuredSeconds = {
  'electron/config-files.test.ts': 222,
  'electron/external-client-service.test.ts': 194,
  'electron/claude-desktop-config.test.ts': 150,
  'electron/system-service.test.ts': 134,
  'electron/tool-config-ownership.test.ts': 113,
  'electron/codex-remote-service.test.ts': 93,
  'electron/system-service-tool-route.test.ts': 83,
  'electron/xingmang-ai-skill.test.ts': 56,
  'electron/backups.test.ts': 34,
  'electron/config-save-service.test.ts': 23,
  'electron/codex-provider-isolation.test.ts': 22,
  'electron/diagnostics.test.ts': 16,
  'electron/canvas-project-store.test.ts': 15,
  'electron/acceleration-development-backend.test.ts': 13,
  'electron/system-service.config-write-queue.test.ts': 13,
  'electron/ai-asset-metadata-store.test.ts': 10,
  'electron/codex-plugin-catalog.test.ts': 9,
  'electron/ipc.test.ts': 9,
  'electron/new-api-client.test.ts': 9,
  'electron/runtime-log.test.ts': 9,
  'electron/system-service.download-stall.test.ts': 9,
  'electron/app-settings.test.ts': 9,
  'electron/codex-extensions.test.ts': 8,
  'electron/ai-chat-history-store.test.ts': 8,
  'electron/official-credential-service.test.ts': 8,
  'electron/claude-desktop-model-repair.test.ts': 8,
  'electron/codex-config-migration.test.ts': 8,
  'electron/external-tool-config.test.ts': 7,
  'electron/uninstall-cleanup.test.ts': 7,
  'electron/uninstall-leftovers.test.ts': 7,
  'electron/acceleration-mihomo-runtime.test.ts': 6,
  'electron/platform/windows-system-proxy.test.ts': 6,
  'electron/codex-desktop-service.test.ts': 6,
  'electron/acceleration-preference-store.test.ts': 6,
  'electron/provider-extensions.test.ts': 5,
  'electron/codex-sessions.test.ts': 5,
  'electron/system-service.locale.test.ts': 5,
  'electron/config-files-route-follow.test.ts': 5,
  'src/pages/SettingsPage.test.ts': 8,
  'canvas-v2/src/video-tools/video-app-workflow.test.ts': 46,
  'canvas-v2/src/image-tools/annotation-app.test.ts': 42,
  'canvas-v2/src/editor/asset-placement-app.test.ts': 29,
  'canvas-v2/src/editor/frame-selection-app.test.ts': 28,
  'canvas-v2/src/editor/output-image-app.test.ts': 21,
  'canvas-v2/src/editor/group-selection-app.test.ts': 16,
  'canvas-v2/src/image-tools/mask-asset-app.test.ts': 12,
  'canvas-v2/src/editor/run-result-collection-app.test.ts': 11,
  'canvas-v2/src/storyboard/storyboard-app-application.test.ts': 11,
  'canvas-v2/src/library/asset-library-app.test.ts': 9,
  'canvas-v2/src/editor/workshop-setup-app.test.ts': 8,
  'canvas-v2/src/editor/quick-node-placement-app.test.ts': 8,
  'canvas-v2/src/editor/text-session-app.test.ts': 7,
  'canvas-v2/src/editor/frame-sequence-app.test.ts': 7,
  'canvas-v2/src/editor/agent-image-context-app.test.ts': 7,
  'canvas-v2/src/library/layer-filter-presentation-pixels.test.ts': 6,
  'canvas-v2/src/store/viewer-settings-routing-app.test.ts': 6,
  'canvas-v2/src/image-tools/layer-whole-filter-ui.test.ts': 5,
}

// Every other file, measured the same way, held its shard 0.63 seconds on
// average in those runs (half of them under 0.32).
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
