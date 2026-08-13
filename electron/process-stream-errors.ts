import type { Writable } from 'node:stream'

const guardedStreams = new WeakSet<Writable>()

function handleProcessStreamError(error: NodeJS.ErrnoException): void {
  // A detached development console can close while Electron keeps running.
  // Electron's IPC error reporter then writes to that stale pipe; EPIPE is
  // about the diagnostic destination, not the application operation itself.
  if (error.code === 'EPIPE') return
  throw error
}

export function guardProcessStream(stream: Writable | null | undefined): void {
  if (!stream || guardedStreams.has(stream)) return
  stream.on('error', handleProcessStreamError)
  guardedStreams.add(stream)
}

export function guardProcessOutputStreams(
  stdout: Writable | null | undefined = process.stdout,
  stderr: Writable | null | undefined = process.stderr,
): void {
  guardProcessStream(stdout)
  guardProcessStream(stderr)
}
