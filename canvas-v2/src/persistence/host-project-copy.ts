// 另存副本按宿主建（#4）：v2 时代的桌面 createProject 只收名字，带过去的内容被丢掉，建出来是空工程。
// 这种宿主先建空工程，马上把内容存进去；存不进去就照实说：新工程已经建了但是空的，当前编辑还在原工程的本地草稿里。
import type { CanvasHostBridge } from '../host'
import type { CanvasCapabilityProfile } from '../host-capabilities'

type CreatedProject = NonNullable<Awaited<ReturnType<CanvasHostBridge['createProject']>>>

/** The new project exists but holds none of the content; nothing was lost, and retrying would make a second project. */
export class ProjectCopyContentError extends Error {
  constructor(readonly project: CreatedProject['project'], cause: unknown) {
    super(`新工程已经建好，但内容没能存进去，现在是空的：${cause instanceof Error ? cause.message : String(cause)}。当前编辑仍保留在原工程的本地草稿里，可以删掉这个空工程后再试`)
    this.name = 'ProjectCopyContentError'
  }
}

/**
 * Creates a project holding this content. A host that keeps the content given
 * to createProject gets it there; any other host gets a blank project and the
 * content saved into it straight after.
 */
export async function createProjectCopyForHost(
  host: Pick<CanvasHostBridge, 'createProject' | 'saveProject'>,
  input: { name: string; content: string; sourceProjectId: string },
  capabilities: CanvasCapabilityProfile,
): Promise<CreatedProject | null> {
  if (capabilities.createProjectWithContent) return host.createProject(input.name, input.content, { sourceProjectId: input.sourceProjectId })
  const created = await host.createProject(input.name)
  if (!created) return null
  let project: CreatedProject['project']
  try {
    project = await host.saveProject(created.project.id, input.content)
  } catch (error) {
    throw new ProjectCopyContentError(created.project, error)
  }
  return { ...created, project, content: input.content }
}
