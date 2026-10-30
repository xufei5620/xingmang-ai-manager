/** The Mach-O header fields assertMacosAccelerationBinary reads all sit in these bytes. */
export const macosAccelerationBinaryHeaderBytes = 32

/** Validate the pinned native executable before it reaches spawn. Fat binaries
 * are deliberately excluded: private cores are selected per architecture.
 * `content` may be just the leading bytes of a file read in chunks; `byteLength`
 * is then the whole file's size, which bounds the load-command table. */
export function assertMacosAccelerationBinary(content: Uint8Array, architecture: string, byteLength = content.byteLength): void {
  if (architecture !== 'arm64' && architecture !== 'x64') throw new Error('加速内核架构不受支持。')
  if (content.byteLength < macosAccelerationBinaryHeaderBytes || byteLength < content.byteLength) throw new Error('需要 macOS Mach-O 加速内核。')
  const header = new DataView(content.buffer, content.byteOffset, content.byteLength)
  if (header.getUint32(0, true) !== 0xfeedfacf) throw new Error('需要 macOS Mach-O 加速内核。')
  if (header.getUint32(4, true) !== (architecture === 'arm64' ? 0x0100000c : 0x01000007)) {
    throw new Error('加速内核与目标 Mac 架构不一致。')
  }
  if (header.getUint32(12, true) !== 2) throw new Error('加速内核不是可执行程序。')
  // Reject truncated load-command tables without parsing any untrusted paths.
  const commandBytes = header.getUint32(20, true)
  if (commandBytes > byteLength - macosAccelerationBinaryHeaderBytes || header.getUint32(16, true) > commandBytes / 8) {
    throw new Error('加速内核 Mach-O 结构不完整。')
  }
}
