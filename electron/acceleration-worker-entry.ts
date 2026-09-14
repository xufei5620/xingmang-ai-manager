export const accelerationWorkerArgument = '--xingmang-acceleration-worker'

export function accelerationEntryMode(
  argv: readonly string[],
  hasParent: boolean,
  platform: string,
): 'desktop' | 'worker' | 'invalid-worker' {
  if (!argv.includes(accelerationWorkerArgument)) return 'desktop'
  return hasParent && platform === 'win32' ? 'worker' : 'invalid-worker'
}
