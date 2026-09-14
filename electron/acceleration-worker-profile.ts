import path from 'node:path'
import { createHash } from 'node:crypto'
import { readBoundedFile } from './bounded-file'
import { assertNoReparseComponents } from './safe-local-data'
import { MAX_ACCELERATION_CLASH_BYTES, parseClashAccelerationProfile } from './acceleration-clash-config'
import type { AccelerationDevelopmentConfig } from './acceleration-development-host'

export async function readAccelerationWorkerProfile(config: Pick<AccelerationDevelopmentConfig, 'profilePath' | 'profileSha256'>) {
  assertNoReparseComponents(path.dirname(config.profilePath), '私有加速节点目录')
  const bytes = await readBoundedFile(config.profilePath, MAX_ACCELERATION_CLASH_BYTES, '私有加速节点')
  if (config.profileSha256 && createHash('sha256').update(bytes).digest('hex') !== config.profileSha256.toLowerCase()) {
    throw new Error('加速节点完整性校验失败，请重新安装软件。')
  }
  return parseClashAccelerationProfile(bytes.toString('utf8'))
}
