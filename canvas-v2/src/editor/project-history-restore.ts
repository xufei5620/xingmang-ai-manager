export interface ProjectHistoryRestoreTransaction<Snapshot, Receipt> {
  pendingSaves: Promise<unknown>
  current(): boolean
  capture(): Snapshot
  save(snapshot: Snapshot): Promise<unknown>
  restore(): Promise<Receipt>
  confirm(receipt: Receipt): Promise<void>
}

/** The existing save queue owns writes; this only orders the restore boundary. */
export async function runProjectHistoryRestore<Snapshot, Receipt>(options: ProjectHistoryRestoreTransaction<Snapshot, Receipt>): Promise<void> {
  function assertCurrent() {
    if (!options.current()) throw new Error('工程或账户已切换，原版本操作不会替换当前画布；请重新打开原工程核对')
  }
  await options.pendingSaves
  assertCurrent()
  await options.save(options.capture())
  assertCurrent()
  const receipt = await options.restore()
  assertCurrent()
  await options.confirm(receipt)
}

export function isDefiniteProjectHistoryRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('status' in error)) return false
  return typeof error.status === 'number' && [400, 401, 403, 404, 409, 413, 422].includes(error.status)
}
