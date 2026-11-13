// Mac 安装包（DMG）窗口的版面：打包配置按这里摆图标，scripts/generate-dmg-background.mjs
// 按同一组数画背景，出包校验按这里认「应用程序」那个替身。三处读同一份，背景上的底板、
// 箭头跟 Finder 真正摆出来的图标才对得上。
//
// 坐标是 Finder 窗口内容区里图标**中心**的位置（electron-builder 的 dmg.contents 就这么算），
// 单位是 1 倍图的像素。窗口大小由背景图的 1 倍图决定，所以 width / height 必须跟
// build/dmg-background.png 一样大。
const width = 540
const height = 380

// electron-builder 默认 80。窗口留得出地方，大一点小白更容易对准了拖。
const iconSize = 96

const application = { x: 150, y: 222 }
const applications = { x: 390, y: 222 }

// 替身默认叫 Applications（取目标路径的最后一段），中文系统上也照样显示英文。背景上那行字说
// 「拖到右边的「应用程序」文件夹」，所以替身直接叫这个名字，客户对得上。
const applicationsLinkName = '应用程序'
const applicationsLinkTarget = '/Applications'

// 放在 build/ 里，electron-builder 按资源名找到它；同目录有 @2x 那张时，它会用 tiffutil
// 把两张合成一份 Retina 背景。
const backgroundName = 'dmg-background.png'
const retinaBackgroundName = 'dmg-background@2x.png'

// 用了自定义背景图后，Finder 一律按浅色模式画图标下面的名字（黑字），不跟系统深色模式走。
// 黑字压在品牌深蓝上看不清，所以两个图标和名字都放在这块浅色底板上。
const panel = { x: 32, y: 120, width: 476, height: 220, radius: 22 }

function buildDmgContents() {
  return [
    // 不写 path：electron-builder 用这次打出来的 .app，名字也照它原来的。
    { x: application.x, y: application.y, type: 'file' },
    { x: applications.x, y: applications.y, type: 'link', path: applicationsLinkTarget, name: applicationsLinkName },
  ]
}

module.exports = {
  width,
  height,
  iconSize,
  application,
  applications,
  applicationsLinkName,
  applicationsLinkTarget,
  backgroundName,
  retinaBackgroundName,
  panel,
  buildDmgContents,
}
