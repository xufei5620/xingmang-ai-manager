// 画布内核只认协作客户端的形状和它抛的错误，发请求的实现留在 project-collaboration-client（#3）。
import type { ProjectCollaborationFeed, ProjectCollaborationFeedInput, ProjectCollaborationInspection, ProjectCollaborationJoinInput, ProjectCollaborationJoinResult, ProjectCollaborationMutationInput, ProjectCollaborationMutationResult, ProjectCollaborationPresenceInput, ProjectCollaborationPresenceResult, ProjectCollaborationReadOptions, ProjectCollaborationSnapshot } from './project-collaboration-contract'

export class ProjectCollaborationRequestError extends Error {
  constructor(message: string, readonly status?: number, readonly outcomeKnown = false, readonly code?: string) { super(message); this.name = 'ProjectCollaborationRequestError' }
}

export interface ProjectCollaborationClient {
  snapshot(projectId: string, input: ProjectCollaborationReadOptions, signal?: AbortSignal): Promise<ProjectCollaborationSnapshot>
  join(projectId: string, input: ProjectCollaborationJoinInput, signal?: AbortSignal): Promise<ProjectCollaborationJoinResult>
  feed(projectId: string, input: ProjectCollaborationFeedInput, signal?: AbortSignal): Promise<ProjectCollaborationFeed>
  mutate(projectId: string, input: ProjectCollaborationMutationInput, signal?: AbortSignal): Promise<ProjectCollaborationMutationResult>
  inspect(projectId: string, originalOperationId: string, input: ProjectCollaborationReadOptions, signal?: AbortSignal): Promise<ProjectCollaborationInspection>
  presence(projectId: string, input: ProjectCollaborationPresenceInput, signal?: AbortSignal): Promise<ProjectCollaborationPresenceResult>
}
