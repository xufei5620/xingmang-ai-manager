export const statuses = {
  tool: { missing: ['未安装', 'neutral'], installing: ['安装中', 'accent'], configuring: ['正在配 Key', 'accent'], updating: ['更新中', 'accent'], ready: ['已配好', 'ok'], official: ['官方账号', 'ok'], unconfigured: ['还没配 Key', 'warn'], update: ['可更新', 'warn'], keyRevoked: ['Key 失效', 'bad'], zeroBalance: ['余额为零', 'bad'], unknownSource: ['已有第三方配置', 'neutral'], detectionFailed: ['检测失败', 'bad'] },
  environment: { ok: ['已找到', 'ok'], missing: ['未安装', 'warn'], optional: ['可选 · 未装', 'neutral'] },
  key: { active: ['有效', 'ok'], disabled: ['已停用', 'neutral'], expired: ['已过期', 'warn'], exhausted: ['额度用完', 'warn'], revoked: ['已撤销', 'neutral'] },
  order: { pending: ['等待支付', 'warn'], paid: ['已到账', 'ok'], failed: ['支付失败', 'bad'], timeout: ['已超时', 'neutral'], unknown: ['待确认', 'neutral'] },
  task: { queued: ['排队中', 'neutral'], running: ['处理中', 'accent'], done: ['已完成', 'ok'], failed: ['失败', 'bad'] },
  balance: { ok: ['', 'ok'], warn: ['', 'warn'], bad: ['', 'bad'], zero: ['余额为零', 'bad'] },
  subscription: { active: ['生效中', 'ok'], exhausted: ['额度已用完', 'warn'], expired: ['已到期', 'neutral'] },
  update: { idle: ['尚未检查', 'neutral'], checking: ['正在检查', 'accent'], latest: ['已是最新版本', 'ok'], available: ['发现新版本', 'warn'], downloading: ['正在下载', 'accent'], downloaded: ['已下载', 'ok'], failed: ['更新没有装上', 'bad'] },
  extension: { enabled: ['已启用', 'ok'], disabled: ['已停用', 'neutral'], update: ['可更新', 'warn'], authExpired: ['授权过期', 'bad'] },
  announcement: { promo: ['优惠', 'accent'], warn: ['维护', 'warn'], info: ['公告', 'neutral'] },
} as const;
