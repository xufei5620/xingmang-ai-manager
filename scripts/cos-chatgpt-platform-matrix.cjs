const { SOURCES, parsePlatforms } = require('./sync-chatgpt-official-cos.cjs')

function buildOfficialPackageMatrix(value = 'all') {
  if (typeof value !== 'string' || !['all', 'windows', 'macos', 'linux'].includes(value) && !Object.hasOwn(SOURCES, value)) throw new Error('不支持的官方同步平台选择')
  return { include: parsePlatforms(value).map(platform => ({ platform })) }
}

if (require.main === module) {
  try { console.log(`matrix=${JSON.stringify(buildOfficialPackageMatrix(process.env.PLATFORM_REQUEST || 'all'))}`) } catch {
    console.error('官方同步平台选择无效')
    process.exitCode = 1
  }
}

module.exports = { buildOfficialPackageMatrix }
