/**
 * 引导预览由 main.ts 在 `XINGMANG_ONBOARDING_PREVIEW` 且非打包时追加到渲染层
 * URL 上。渲染层这一侧过去只看 query，等于打包产物里留着一条不受产品控制的 UI
 * 分支；`dev` 传 `import.meta.env.DEV`，正式产物里这条分支直接不存在（R-B8）。
 */
export function onboardingPreviewEnabled(search: string, dev: boolean): boolean {
  return dev && new URLSearchParams(search).get('onboardingPreview') === '1'
}
