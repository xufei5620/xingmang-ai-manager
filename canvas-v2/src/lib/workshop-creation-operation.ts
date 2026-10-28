// 工坊保存核对回执的形状，画布内核的宿主接口要用；解析它要读网页个人工坊的条目格式，留在 workshop-creation-contract（#3）。
import type { WorkshopCreationIdentity } from './workshop-creation-identity'
import type { CanvasWorkshopItem } from './workshop-contract'

export type WorkshopCreationOperation = { state: 'missing'; identity: WorkshopCreationIdentity } | { state: 'completed'; identity: WorkshopCreationIdentity; item: CanvasWorkshopItem } | { state: 'cancelled'; identity: WorkshopCreationIdentity; cancelledAt: string }
