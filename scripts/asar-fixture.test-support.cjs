const fs = require('node:fs/promises')
const { createPackage, getRawHeader } = require('@electron/asar')

// @electron/asar 3.x resolves createPackage() as soon as it calls end() on the
// archive's write stream, not when the stream finishes (lib/disk.js
// writeFileListToStream returns `out.end()`). The header is flushed before that
// promise settles, but file bodies can still be queued, so reading the archive
// straight away occasionally sees a truncated file: extractFile then returns a
// zero-filled buffer and the reader reports invalid JSON. That only shows up on
// a busy runner. Wait for the archive to reach the length its own header
// declares instead; the stream writes sequentially, so that length means every
// body is on disk.
function declaredArchiveLength(archive) {
  const { header, headerSize } = getRawHeader(archive)
  let end = 0
  const pending = [header]
  while (pending.length > 0) {
    const entry = pending.pop()
    if (entry.files) {
      pending.push(...Object.values(entry.files))
    } else if (!entry.unpacked && !entry.link && typeof entry.offset === 'string') {
      end = Math.max(end, Number(entry.offset) + entry.size)
    }
  }
  return 8 + headerSize + end
}

async function createSettledPackage(source, archive) {
  await createPackage(source, archive)
  const expected = declaredArchiveLength(archive)
  while ((await fs.stat(archive)).size < expected) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  return archive
}

module.exports = { createSettledPackage, declaredArchiveLength }
