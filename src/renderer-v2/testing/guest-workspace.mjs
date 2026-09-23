// 没登录时本机工具里有 Key 也不再直接进首页，一律先到欢迎页。不登录进首页只剩
// 「先看看使用步骤」走完这一条路，要在未登录首页上验证的用例都从这里进。
export async function enterWorkspaceWithoutAccount(page, route = 'codexDesktop') {
  await page.getByTestId('welcome-steps').click()
  await page.getByTestId(`guide-route-${route}`).check()
  const guide = page.getByTestId('start-guide')
  for (let turn = 0; turn < 4; turn++) {
    const step = await guide.getAttribute('data-guide-step')
    if (step === 'ready') break
    await page.getByTestId('guide-next').click()
    await page.waitForFunction((previous) => document.querySelector('[data-testid="start-guide"]')?.getAttribute('data-guide-step') !== previous, step)
  }
  await page.getByTestId('guide-home').click()
  const tour = page.getByTestId('shell-guide-tip')
  await tour.getByRole('button', { name: '跳过', exact: true }).click()
  await tour.waitFor({ state: 'detached' })
}
