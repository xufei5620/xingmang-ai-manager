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
export const measuredSeconds = {
  'electron/external-client-service.test.ts': 170,
  'electron/config-files.test.ts': 169,
  'electron/system-service.test.ts': 128,
  'electron/claude-desktop-config.test.ts': 106,
  'electron/tool-config-ownership.test.ts': 105,
  'electron/system-service-tool-route.test.ts': 59,
  'electron/xingmang-ai-skill.test.ts': 38,
  'electron/backups.test.ts': 30,
  'electron/codex-provider-isolation.test.ts': 19,
  'electron/system-service.config-write-queue.test.ts': 14,
  'electron/codex-plugin-catalog.test.ts': 13,
  'electron/acceleration-development-backend.test.ts': 13,
}

// Per-file setup (transform and import) plus a typical file's tests came to
// 0.78s on the same run.
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
