export interface ProjectExportScope {
  projectId: string | null
  projectEpoch: number
}

export interface ProjectExportToken extends ProjectExportScope {
  revision: number
}

/** Cancelling an export releases the UI immediately, while its older result
 * remains permanently invalid even when the same project is reopened. */
export function createProjectExportGuard() {
  let active = true
  let revision = 0
  let pending: ProjectExportToken | null = null
  return {
    activate() { active = true },
    begin(scope: ProjectExportScope): ProjectExportToken | null {
      if (!active || pending) return null
      pending = { ...scope, revision: ++revision }
      return pending
    },
    current(token: ProjectExportToken, scope: ProjectExportScope): boolean {
      return active && pending === token && token.revision === revision
        && token.projectId === scope.projectId && token.projectEpoch === scope.projectEpoch
    },
    cancel() { revision += 1; pending = null },
    finish(token: ProjectExportToken) { if (pending === token) pending = null },
    busy() { return pending !== null },
    dispose() { active = false; revision += 1; pending = null },
  }
}
