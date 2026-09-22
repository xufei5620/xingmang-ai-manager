## 用户

- 输密码时开着大写锁定，密码框下面会直接提示「大写锁定已开启」，不用再靠「密码错误」反复猜。
  登录、注册、修改密码的密码框都有；关掉大写锁定或离开密码框，提示自己消失。

## 开发

- 第六批候选 9：`src/renderer-v2/ui/fields.tsx` 的 `Input` 在 `password` 时按 `keydown` /
  `keyup` 的 `event.getModifierState('CapsLock')` 显示一行提示（`.xm-field-caps`，
  `data-testid` 为 `<字段 testId>-caps`），失焦即清空，不轮询也不新增 IPC；提示 id 会挂进
  输入框的 `aria-describedby`。文案放在 `ui/shared.tsx` 的 copy 表里。
  覆盖：`features/auth/browser-check.mjs` 两条（登录两种账号来源、注册两个密码框），
  `ui/components.test.tsx` 一条静态断言默认不出现。
