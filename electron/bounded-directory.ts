import fs from 'node:fs'

export class DirectoryEntryLimitError extends Error {
  readonly maximum: number

  constructor(label: string, maximum: number) {
    super(`${label}条目超过安全上限 ${maximum}`)
    this.name = 'DirectoryEntryLimitError'
    this.maximum = maximum
  }
}

function validateMaximum(maximum: number): void {
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new Error('目录条目上限无效')
  }
}

export function readDirectoryEntriesSync(
  directoryPath: string,
  maximum: number,
  label: string,
): fs.Dirent[] {
  validateMaximum(maximum)
  const directory = fs.opendirSync(directoryPath)
  const entries: fs.Dirent[] = []
  try {
    while (true) {
      const entry = directory.readSync()
      if (!entry) break
      if (entries.length >= maximum) throw new DirectoryEntryLimitError(label, maximum)
      entries.push(entry)
    }
  } finally {
    directory.closeSync()
  }
  return entries
}

export async function readDirectoryEntries(
  directoryPath: string,
  maximum: number,
  label: string,
): Promise<fs.Dirent[]> {
  validateMaximum(maximum)
  const directory = await fs.promises.opendir(directoryPath)
  const entries: fs.Dirent[] = []
  try {
    while (true) {
      const entry = await directory.read()
      if (!entry) break
      if (entries.length >= maximum) throw new DirectoryEntryLimitError(label, maximum)
      entries.push(entry)
    }
  } finally {
    await directory.close()
  }
  return entries
}
