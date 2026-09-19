## 用户

- 更换本机头像时，界面正在切换账号的一瞬间点保存，不会再偶尔弹出“账号已变化”的提示。

## 开发

- R-B9：`src/renderer-v2/types.ts` 把 `window.xingmang` 声明为可选，`features/auth/api.ts` 的
  `getAuthApi()` 改走 `bridge()`，取不到桥时抛中文错误；`main.tsx` 随之改成先取值再判空。
- R-B10：`LocalAvatar.tsx` 的 `keyRef` 与 `activeKey` 从渲染期赋值挪进 `useEffect`，
  `save()` 的「账号已变化」判定只看已提交的渲染；新增一条被丢弃渲染的浏览器回归用例。
