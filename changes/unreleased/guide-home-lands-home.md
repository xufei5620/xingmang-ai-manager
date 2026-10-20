## 开发

- `features/auth/StartGuide.tsx` 的 `onComplete` 多带一个 `landing`（`'home' | 'chat'`）：只有「去聊天」那颗按钮给 `'chat'`，
  「进入首页」「打开 X」「去充值」都给 `'home'`。`App.tsx` 以前按选的开始方式定去向（`id === 'chat' ? 'chat' : 'home'`），
  所以选了聊天以后「进入首页」也进聊天页。记进本机的引导偏好照旧写开始方式。
