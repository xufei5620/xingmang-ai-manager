function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }

/** Inspect raw persisted coordinates before an old-reader projection can erase
 * the viewport. Image editor zooms and unrelated nested data are not carriers.
 */
export function workflowHasExtendedViewport(value: unknown): boolean {
  let raw = value
  if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch { return false } }
  if (!record(raw)) return false
  if (raw.format === 'xingmang-canvas-project' && record(raw.workflow)) raw = raw.workflow
  if (!record(raw) || !record(raw.viewport)) return false
  const viewport = raw.viewport
  return [viewport.x, viewport.y].some((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate) && Math.abs(coordinate) > 10_000_000)
    || typeof viewport.zoom === 'number' && Number.isFinite(viewport.zoom) && viewport.zoom > 0 && viewport.zoom < .01
}

export function assertViewportRangeClientVersion(version: unknown, ...workflows: unknown[]): void {
  if (version !== undefined && version !== 1 || version !== 1 && workflows.some(workflowHasExtendedViewport)) throw new Error('当前页面版本不支持此画布视口范围，请刷新页面后重试；原工程和视口未覆盖')
}
