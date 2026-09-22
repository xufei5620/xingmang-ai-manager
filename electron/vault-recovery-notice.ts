/**
 * 本机登录记录解密不了时账号存储会被重建（realm-account-vault-file.ts 的
 * recoverAtomic）。用户在界面上看到的症状是「记住的账号没了」，而恢复本身只在
 * runtime.jsonl 里留一条 vault.recovered，客服之外没人看得到，用户只能自己猜。
 *
 * 这里把「记日志」和「告诉界面」绑在一起，并把后者收敛成一次：同一次启动里
 * 恢复若发生第二次，用户刚关掉的提示不该再冒出来。事件不带备份文件名，也不带
 * 任何账号内容（I3 / I13），界面只需要知道「发生过」。
 */
export interface VaultRecoveryNotifierOptions {
  /** 记进运行日志，带上备份文件名供客服排查。 */
  log(backupFileName: string): void
  /** 通知界面。恢复已经提交，通知失败不能反悔，所以日志先写。 */
  emit(): void
}

export function createVaultRecoveryNotifier(options: VaultRecoveryNotifierOptions): (backupFileName: string) => void {
  let notified = false
  return function onRecovered(backupFileName: string): void {
    options.log(backupFileName)
    if (notified) return
    notified = true
    options.emit()
  }
}
