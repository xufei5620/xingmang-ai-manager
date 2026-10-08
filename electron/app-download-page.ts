/**
 * 星芒自己的安装包下载页。自动更新走不通（比如「必须更新」那层提示里下载一直失败）
 * 时，给用户一条手动下载的路。主进程外链白名单与渲染层都读这一条（I12 全等匹配），
 * 这个文件不许引入任何运行时依赖：渲染层也会打包它。
 */
export const appReleaseDownloadUrl = 'https://docs-new.solov.cc/guide/manager#download-installers'
