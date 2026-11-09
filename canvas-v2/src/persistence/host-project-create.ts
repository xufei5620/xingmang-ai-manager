// 项目中心「新建项目」按宿主建：宿主有默认文件夹（桌面的「文档 › 星芒画布」）就直接建在那里，不弹选文件夹的框；
// 客户点「换个位置创建…」，或者宿主没有默认文件夹，照旧走 createProject，由宿主让客户选文件夹。
import type { CanvasHostBridge } from '../host'

export function createBlankProjectForHost(
  host: Pick<CanvasHostBridge, 'createProject' | 'createProjectInDefaultFolder'>,
  name: string,
  place: 'default' | 'elsewhere',
): ReturnType<CanvasHostBridge['createProject']> {
  if (place === 'default' && host.createProjectInDefaultFolder) return host.createProjectInDefaultFolder(name)
  return host.createProject(name)
}
