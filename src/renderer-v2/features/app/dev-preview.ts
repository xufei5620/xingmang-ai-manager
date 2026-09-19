/**
 * 引导预览由 main.ts 在 `!app.isPackaged && XINGMANG_ONBOARDING_PREVIEW` 时追加到
 * 渲染层 URL 上。渲染层这一侧过去只看 query，等于让一条 UI 分支只由 URL 决定；
 * `development` 传主进程自己给出的判断（`UpdateSnapshot.development`，即
 * `!isPackaged || localBuild`），打包产物里即使 query 被注入也进不去（R-B8）。
 *
 * 这里刻意不用 `import.meta.env.DEV`：`npm run compile` 产出的未打包运行
 * （`e2e/onboarding-smoke.mjs` 就是这么跑的）同样是开发运行环境，而那份产物的
 * `DEV` 已经是 false。判「是不是打包版」的权威只有主进程。
 */
export function onboardingPreviewEnabled(search: string, development: boolean): boolean {
  return development && new URLSearchParams(search).get('onboardingPreview') === '1'
}
