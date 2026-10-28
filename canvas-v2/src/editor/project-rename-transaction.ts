export interface ProjectRenameTransaction<Snapshot, Receipt> {
  pendingSaves: Promise<unknown>
  current(): boolean
  capture(): Snapshot
  save(snapshot: Snapshot): Promise<unknown>
  rename(): Promise<Receipt>
  confirm(receipt: Receipt, snapshot: Snapshot): void
}

/** Preserve graph edits before advancing the project's mutation version. */
export async function runProjectRenameTransaction<Snapshot, Receipt>(options: ProjectRenameTransaction<Snapshot, Receipt>): Promise<void> {
  function assertCurrent(submitted = false) {
    if (!options.current()) throw new Error(submitted ? '名称请求已提交，但项目或账号已切换，请重新打开项目核对' : '项目或账号已切换，原改名操作已停止')
  }
  await options.pendingSaves
  assertCurrent()
  const snapshot = options.capture()
  await options.save(snapshot)
  assertCurrent()
  const receipt = await options.rename()
  assertCurrent(true)
  options.confirm(receipt, snapshot)
}
