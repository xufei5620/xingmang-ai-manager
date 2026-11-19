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
// at a nominal second, in hash order, the same way. Each runner computes the
// same deal from the same file list, so the shards are still a partition
// whose union is exactly the unsharded run, as --shard's slices were.
//
// The seconds are each file's own time on windows-latest, which vitest prints
// after the file's name in the shard's log, and they only need to be roughly
// right. List any file that takes more than about ten seconds; re-measure when
// one shard drifts minutes past its siblings. An entry whose file is gone
// fails scripts/ci-workflow-config.test.cjs rather than quietly weighing
// nothing.
//
// Re-measured on 2026-11-19, each entry the median of three main runs
// (44568715302, 44572005275 and 44588543395). Since the 10-19 table
// config-files had grown from 169 seconds to 278, and codex-remote-service,
// never listed, took 60 to 108 on its own; weighing a nominal second, it kept
// landing on the shard that already held config-files. On main f6e671b that
// shard ran 12.9 minutes against 7.7 to 8.9 for the others, and 13.5 on
// #1946. Dealt from the table below, the same runs' times come to about 9.5
// minutes a shard: the whole vitest suite is now some 38 runner-minutes,
// where the 10-19 cut planned four quarters near 6.
//
// The canvas-v2/ entries are windows-latest numbers now too. They came in with
// the xingmang-canvas kernel (#1393) timed in the Linux cloud container, which
// had them at roughly two thirds of what the Windows runners take.
export const measuredSeconds = {
  'electron/config-files.test.ts': 278,
  'electron/external-client-service.test.ts': 189,
  'electron/system-service.test.ts': 170,
  'electron/claude-desktop-config.test.ts': 100,
  'electron/tool-config-ownership.test.ts': 80,
  'electron/system-service-tool-route.test.ts': 76,
  'electron/codex-remote-service.test.ts': 76,
  'electron/xingmang-ai-skill.test.ts': 55,
  'electron/codex-provider-isolation.test.ts': 24,
  'electron/backups.test.ts': 24,
  'electron/config-save-service.test.ts': 18,
  'electron/canvas-project-store.test.ts': 15,
  'electron/diagnostics.test.ts': 13,
  'electron/codex-plugin-catalog.test.ts': 13,
  'electron/system-service.config-write-queue.test.ts': 12,
  'electron/acceleration-development-backend.test.ts': 10,
  'canvas-v2/src/image-tools/annotation-app.test.ts': 50,
  'canvas-v2/src/video-tools/video-app-workflow.test.ts': 39,
  'canvas-v2/src/editor/frame-selection-app.test.ts': 26,
  'canvas-v2/src/editor/asset-placement-app.test.ts': 26,
  'canvas-v2/src/editor/output-image-app.test.ts': 20,
  'canvas-v2/src/editor/group-selection-app.test.ts': 13,
  'canvas-v2/src/image-tools/mask-asset-app.test.ts': 11,
  'canvas-v2/src/editor/run-result-collection-app.test.ts': 10,
}

// Per-file setup (transform and import) plus a typical file's tests came to
// 0.78s on f4b0d2a, and to 0.70 to 0.83 on the three runs above.
export const unmeasuredSeconds = 1

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
