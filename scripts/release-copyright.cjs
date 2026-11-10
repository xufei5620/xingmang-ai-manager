// 安装包上的版权行按出包那一年写（D103 / PK-13）。Windows 安装程序和主程序文件属性里的
// 「版权」、Mac「关于星芒AI管理工具」里那一行都读 electron-builder 的 copyright；原来写死
// 2026，跨年以后出的包还挂着旧年份。
//
// 年份按北京时间算：星芒是国内公司，发版跑在 UTC 的 CI 上，北京时间 1 月 1 日 0 点到 8 点
// 之间出的包，按 UTC 还算上一年。中国不用夏令时，固定东八区就够，也不依赖 Node 有没有带
// 完整的时区数据。
const RELEASE_COPYRIGHT_HOLDER = '绍兴星芒文化传媒有限责任公司'
const BEIJING_OFFSET_MILLISECONDS = 8 * 60 * 60 * 1000

function resolveReleaseCopyrightYear(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('出包时间无效，算不出版权年份')
  }
  return new Date(now.getTime() + BEIJING_OFFSET_MILLISECONDS).getUTCFullYear()
}

function buildReleaseCopyright(now) {
  return `Copyright © ${resolveReleaseCopyrightYear(now)} ${RELEASE_COPYRIGHT_HOLDER}`
}

module.exports = {
  RELEASE_COPYRIGHT_HOLDER,
  buildReleaseCopyright,
  resolveReleaseCopyrightYear,
}
