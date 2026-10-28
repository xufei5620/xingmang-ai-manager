import { defaultStoryboardTask, storyboardTaskRoles, storyboardTaskUsesAnalysis, parseNodeStoryboardTask, type StoryboardTask } from './storyboard/storyboard-task'
import type { CanvasAssetOriginResult } from './lib/asset-origin-contract'
import { useProjectCollaboration } from './editor/use-project-collaboration'
import type { CanvasProjectCollaboration, CanvasCollaborationState } from './editor/project-collaboration-controller'
import { hasProjectCollaborationJournal } from './persistence/project-collaboration-journal'
// 工坊、Agent 和 MCP、协作这几块云端界面搬去了网页外壳（app/canvas-slots/），样式表还留在内核、照原来的位置引入：
// 网页里样式的先后决定层叠，这样网页生成的样式表跟搬之前一个字节不差。桌面不渲染这些界面，只是多带了用不上的样式（#3）。
import './components/project-collaboration.css'
import { buildStoryboardWorkflow } from './storyboard/storyboard-workflow'
import { collectWorkflowColorLutSources } from './lib/workflow-color-lut-resources'
import { assertStoryboardNodeEditable, buildStoryboardNodeEdit, buildStoryboardPromptEdit } from './storyboard/storyboard-edit-application'
import { StoryboardTaskDialog } from './components/StoryboardTaskDialog'
import { storyboardTaskFromRoute, type StoryboardTaskDialogDraft, type StoryboardTaskReferenceDraft } from './components/storyboard-task-ui'
import type { VideoProtocol } from './lib/video-request-protocol'
import { parseNodeTileInput, parseTileInput, resolveTileInputSlots, type TileInputSelection } from './image-tools/tile-input'
import { defaultCommerceTask, parseNodeCommerceTask, type CommerceTask } from './commerce/commerce-task'
import { parseNodeImageReferenceOrder } from './commerce/image-reference-order'
import { buildCommerceWorkflow } from './commerce/commerce-workflow'
import { assertCommerceNodeEditable, buildCommerceCandidateComparison, buildCommerceNodeEdit } from './commerce/commerce-edit-application'
import { CommerceTaskDialog } from './components/CommerceTaskDialog'
import { commerceTaskKindFromRoute, commerceTaskRoles, type CommerceTaskDialogDraft, type CommerceTaskReferenceDraft } from './components/commerce-task-ui'
import { defaultInteriorTask, parseNodeInteriorTask, type InteriorTask } from './interior/interior-task'
import { buildInteriorWorkflow } from './interior/interior-workflow'
import { assertInteriorNodeEditable, buildInteriorNodeEdit } from './interior/interior-edit-application'
import { InteriorTaskDialog } from './components/InteriorTaskDialog'
import { interiorTaskFromRoute, type InteriorTaskDialogDraft, type InteriorTaskSourceDraft } from './components/interior-task-ui'
import { defaultExteriorTask, exteriorTaskRoles, exteriorTaskUsesAnalysis, parseNodeExteriorTask, type ExteriorTask } from './exterior/exterior-task'
import { buildExteriorWorkflow } from './exterior/exterior-workflow'
import { assertExteriorNodeEditable, buildExteriorNodeEdit } from './exterior/exterior-edit-application'
import { ExteriorTaskDialog } from './components/ExteriorTaskDialog'
import { exteriorTaskFromRoute, type ExteriorTaskDialogDraft, type ExteriorTaskReferenceDraft } from './components/exterior-task-ui'
import { textImageInputModelSupported, validateTextImageInputConfiguration } from './runtime/text-image-input'
import { tileEditorInputScope } from './image-tools/tile-preview-state'
import { buildAssetBatchNodes } from './editor/asset-batch-nodes'
import { validateAssetBatchIds, assertBatchAssetAvailable } from './lib/asset-batch-checks'
import { assetBatchDragMime } from './components/asset-batch-selection'
import { runCanvasAssetMutationBatch, type CanvasAssetMutationAction, type CanvasAssetMutationResult } from './components/asset-mutation-batch'
import type { AssetCategoryDirectory, AssetCategoryInput, AssetCategoryResult, AssetCategoryUploadTarget } from './lib/asset-category-contract'
import { assertAssetCategoryPageFilter } from './lib/asset-category-contract'
import { AssetCategoryManagerDialog } from './components/AssetCategoryManagerDialog'
import { AssetCategoryMoveDialog, type AssetCategoryMoveAsset } from './components/AssetCategoryMoveDialog'
import { useAssetCategoryRecovery } from './lib/asset-category-recovery-hook'
import { useAssetMutationRecovery } from './lib/asset-mutation-recovery-hook'
import { AssetMutationRecoveryPanel } from './components/asset-mutation-recovery-panel'
import type { AssetMutationInput, AssetMutationResult } from './lib/asset-mutation-contract'
import { AssetCategoryRecoveryNotice } from './components/AssetCategoryRecoveryNotice'
import type { CanvasMcpClient } from './lib/canvas-mcp-contract'
import { isCanvasAgentSkillMethod } from './lib/canvas-agent-skill-contract'
import { parseVideoGenerateAudio } from './runtime/video-audio'
import { assertEditableVideoNode, buildVideoParameterPatch, inspectVideoNodeParameters, type VideoParameterPatch } from './video-tools/video-node-parameters'
import { assertCanvasVideoInputCardinality, inspectCanvasVideoInputs } from './video-tools/video-inputs'
import { parseVideoReferenceOrder, videoReferenceIdentityKey, type VideoReferenceOrder } from './video-tools/video-reference-order'
import { buildCanvasUpstreamReferences } from './components/upstream-references'
import { CanvasTextEditor } from './text-tools/CanvasTextEditor'
import { VideoFrameEditor } from './video-tools/VideoFrameEditor'
import { assertFrameSequenceSource, buildFrameSequenceGraph, captureFrameSequenceSource, type FrameSequenceSnapshot } from './video-tools/frame-sequence'
import type { FrameEditorMetadata } from './video-tools/frame-editor-state'
import { assertFrameSelection, captureFrameSelection, type FrameSelectionSnapshot } from './editor/frame-selection-session'
import { parseTextWebSearch, validateTextWebSearchConfiguration } from './runtime/text-web-search'
import { assertTextDraft, assertTextSessionNode, downloadCanvasText, type CanvasTextSession } from './editor/text-session'
import { buildOutputTextNode, inspectNodeTextOutput, textOutputPresetInput, type TextOutputSelection } from './editor/output-text-nodes'
import { ImageMaskEditor } from './image-tools/ImageMaskEditor'
import { ImageAnnotationEditor } from './image-tools/ImageAnnotationEditor'
import { assertAnnotationTarget, downloadAnnotationPng, replaceAnnotatedImage } from './image-tools/annotation-workflow'
import type { ImageLayerRecipe } from './image-tools/recipe'
import type { CanvasImageAssetSummary, CanvasVideoAssetSummary } from './host'
import { parseNodeImageEditMask, resolveImageMaskSource, type ImageMaskSource } from './image-tools/image-mask-workflow'
import { parseImageEditMask, imageEditMaskModelSupported, type ImageEditMask } from './image-tools/image-edit-mask'
import { assertMaskAssetPng, assertMaskAssetSource, buildLinkedMaskAssetNode, buildMaskAssetNode, parseMaskAssetUpload, replaceMaskAssetNode, type ImageMaskAssetPng, type MaskAssetSaveMode } from './image-tools/mask-asset-export'
import { parseImageCandidateCount } from './runtime/image-candidate-count'
import { parseVideoCandidateCount, type VideoCandidateCount } from './runtime/video-candidate-count'
import { imageTransformRecipeForNode, isImageTransformNodeKind } from './image-tools/recipe'
import { parseImageCollageInputOrder } from './image-tools/collage-input-order'
import { analyzeBatchImageRelatedSources, batchImageRelatedConfig, batchImageRelatedCenter, buildBatchImageRelatedCommand, type BatchImageRelatedSource, type BatchImageRelatedTarget } from './editor/batch-image-related'
import { BatchImageRelatedDialog } from './components/BatchImageRelatedDialog'
import { buildLayerPsdGraph } from './image-tools/layer-psd-apply'
import { assertLayerEditorScope, layerEditorScopeToken } from './image-tools/layer-editor-scope'
import { collectGalleryCandidateAssetIds, currentNodeCandidates } from './runtime/current-batch-candidates'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { parsePromptReferences, type PromptReference } from './library/prompt-references'
import { applyCanvasPromptDraft } from './editor/prompt-draft'
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  Controls,
  MiniMap,
  ReactFlow,
  SelectionMode,
  ViewportPortal,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type FinalConnectionState,
  type NodeChange,
  type OnConnectStartParams,
  type Viewport,
  type XYPosition,
} from '@xyflow/react'
import { createPortal, flushSync } from 'react-dom'
import '@xyflow/react/dist/style.css'
import {
  createEmptyWorkflow,
  parseWorkflowFile,
  serializeWorkflow as serializeKernelWorkflow,
  type NodeKind,
  type WorkflowEdge,
  type WorkflowFile,
  type WorkflowCandidateRef,
  type AssetRef,
  type WorkflowNode,
  type WorkflowNodeData,
} from './model'
import { runWorkflow, type NodeInputs } from './engine/engine'
import { createHostExecutors } from './engine/executors'
import { hostBridge } from './host'
import { promptPresetSaveFailure } from './library/prompt-preset-recovery'
import { buildOutputImageNodes, nodeOutputImageIds, type OutputImageSelection } from './editor/output-image-nodes'
import { createOutputImagePlacementCoordinator, type OutputImagePlacementToken } from './runtime/output-image-placement'
import { verifyOutputImageReadable } from './library/output-image-readiness'
import { canvasAriaLabelConfig } from './aria-labels'
import { canvasEdgeClassName, canvasEdgeIsFlowing, canvasEdgeTouchesSelection } from './edges/workflow-edge-model'
import { CanvasEdgeHandlersProvider, defaultEdgeOptions, edgeTypes } from './edges/WorkflowEdge'
import { CanvasContextMenu, type CanvasContextMenuState } from './components/CanvasContextMenu'
import { CanvasShortcutHelp } from './components/CanvasShortcutHelp'
import { canvasContextNodeIds } from './editor/context-menu-scope'
import { BrowserDraftRecovery } from './persistence/BrowserDraftRecovery'
import { CanvasProjectImportDialog } from './components/ProjectImportDialog'
import ProjectImportRecoveryDialog from './components/project-import-recovery-dialog'
import { buildProjectImportPresentation, createProjectImportGuard, projectImportAccountChanged, projectImportFailureMessage, type ProjectImportPreview, type ProjectImportProgress } from './lib/project-import-model'
import { CanvasProjectExportDialog } from './components/ProjectExportDialog'
import { buildProjectExportPresentation, projectExportAccountChanged, projectExportFailureMessage } from './lib/project-export-model'
import { createProjectExportGuard, type ProjectExportToken } from './lib/project-export-guard'
import type { ProjectExportPreview, ProjectExportProgress, ProjectExportResult } from './lib/project-export-contract'
import { NodeSearchPalette } from './components/NodeSearchPalette'
import { canvasViewportZoomLabel, fitCanvasViewport, measureCanvasSafeViewport } from './editor/canvas-viewport'
import { maximumCanvasViewportZoom, minimumCanvasViewportZoom } from './persistence/canvas-viewport-limits'
import type { CanvasContextAction } from './editor/context-menu'
import type { CanvasAlignMode, CanvasDistributeAxis } from './editor/align'
import { layoutCanvasSelection, type CanvasSelectionLayout } from './editor/selection-layout'
import { bridgeEdgesForRemoval } from './editor/bridge-edges'
import { type SnapBox, type SnapGuide } from './editor/snap-guides'
import { snapDragPositionChanges } from './editor/drag-snap'
import { findEdgeDropTarget } from './editor/edge-drop'
import { edgesCrossedByStroke, strokePath, type Point } from './editor/cut-gesture'

function snapBoxOfCanvasNode(node: { id: string; position: { x: number; y: number }; measured?: { width?: number; height?: number }; width?: number | null; height?: number | null; type?: string }): SnapBox {
  const fallback = builtinNodeRegistry.resolve(node.type ?? 'unknown')?.dimensions
  return {
    id: node.id,
    x: node.position.x,
    y: node.position.y,
    width: node.measured?.width ?? node.width ?? fallback?.width ?? 240,
    height: node.measured?.height ?? node.height ?? fallback?.height ?? 180,
  }
}

function portGeometryOfCanvasNode(node: CanvasNode, height: number): PortGeometryNode {
  const kind = node.type ?? 'unknown'
  return {
    height,
    centredOutput: usesMediaBoundLayout(kind, node.data?.result?.assetId),
    ports: builtinNodeRegistry.resolve(kind)?.ports ?? [],
  }
}
import { usesMediaBoundLayout } from './nodes/media-bound'
import { portOffsetY, type PortGeometryNode } from './nodes/port-geometry'
import { canvasMinimapNodeColor } from './nodes/minimap-node-color'
import {
  compatibleInsertionHandle,
  connectionForInsertedNode,
  handleKind,
  isValidWorkflowConnection,
  type PendingCanvasConnection,
} from './ports'
import {
  availableImageModelPresets,
  availableVideoModelPresets,
} from './models'
import { CanvasModelAvailabilityProvider, CanvasNodeViewProvider, CanvasUpstreamReferencesProvider, ModelSuggestions, nodeTypes, registerNodeChangeHandlers, type CanvasNode } from './nodes/WorkflowNodes'
import { canvasNodeLodForZoom, type CanvasNodeLod } from './nodes/node-lod'
import type { CanvasAssetPage, CanvasAssetQuery, CanvasAssetSummary, CanvasGeneratedAsset, CanvasGeneratedVideoAsset, CanvasGroupSummary, CanvasProjectPage, CanvasPromptPreset, CanvasRunCandidate, CanvasRunGraph, CanvasRunRecord, CanvasRunScope, CanvasStoredProjectSummary, CanvasWorkshopItem } from './host'
import { emptyCanvasAssetPage } from './host'
import { defaultCanvasProjectQuery, loadCanvasProjectPage, type CanvasProjectListQuery } from './project-pagination'
import { AssetTray } from './components/AssetTray'
import './components/workshop-media-asset-picker.css'
import type { OfficialAssetAccess } from './components/official-asset-browser-model'
import { MediaLightbox } from './components/MediaPreview'
import { arrangeCanvasNodes, type CanvasArrangeMode } from './editor/arrange-nodes'
import { organizeCanvasGroupContents } from './editor/organize-groups'
import { createViewportRestoration } from './editor/viewport-restoration'
import { relatedNodeOptions } from './editor/related-nodes'
import { buildWorkshopSelectionForSourceReview, instantiateWorkshopGraph } from './editor/workshop-graph'
import { buildWorkshopSetup, type WorkshopSetup, type WorkshopSetupScope, type WorkshopSetupAssetState, type WorkshopSetupItem } from './editor/workshop-setup'
import './components/workshop-setup.css'
import './components/workshop-model-mapping.css'
import { buildWorkshopModelMapping, planWorkshopModelMapping, type WorkshopModelMappingChoice, type WorkshopModelMappingIssue } from './editor/workshop-model-mapping'
import { workshopModelMappingGraphSignature, workshopModelMappingNodes, workshopModelMappingSourceSignature } from './editor/workshop-model-mapping-snapshot'
import { CanvasNodeRenameDialog } from './components/CanvasNodeRenameDialog'
import { noCanvasSlots, type CanvasKernelSlots } from './slots'
import { bindWorkshopEditProject, clearWorkshopEditTarget, readWorkshopEditTarget } from './components/workshop-save-model'
import { builtinPromptWorkflowItem, promptPresetWorkflowItem } from './components/canvas-workshop-library'
import { canvasKeyboardEventBlocked, canvasModalSelector, resolveCanvasShortcut } from './editor/shortcuts'
import { duplicateCanvasNodesForAltDrag } from './editor/alt-drag'
import { builtinCanvasTemplates } from './templates/builtin-templates'
import { instantiateTemplate, placeTemplateInstance } from './templates/instantiate-template'
import { clearSavedTemplateProjectSubmission, createTemplateProjectSubmission, readSavedTemplateProjectSubmission, templateProjectOperationId, writeSavedTemplateProjectSubmission, type SavedTemplateProjectSubmission } from './templates/template-project-creation'
import { TemplateProjectRecovery } from './components/TemplateProjectRecovery'
import { builtinNodeRegistry } from './domain/builtin-node-definitions'
import { assertRouterStrategyWorkflowConfiguration } from './lib/router-strategy-contract'
import { parseNodeRouterStrategy } from './runtime/router-strategy'
import { canvasNodeDisplayGeometry } from './domain/node-display-geometry'
import { operationDefaultsForTemplateNode } from './domain/workflow-node-config'
import { NodeLibrary } from './components/NodeLibrary'
import { ResourceTree } from './components/ResourceTree'
import { CanvasProjectName } from './components/CanvasProjectName'
import './components/canvas-agent-approval.css'
import './components/canvas-agent-media-models.css'
import './components/canvas-agent-execution-results.css'
import './components/canvas-agent-skills.css'
import './components/canvas-mcp.css'
import './theme/canvas-agent.css'
import { canvasAgentProposalTargetNodeIds } from './lib/canvas-agent-execution-scope'
import type { CanvasAgentExecution, CanvasAgentExecutionOrigin } from './lib/canvas-agent-execution-contract'
import { buildAgentExecutionResumePreflight } from './runtime/agent-execution-preflight'
import { canvasRunInputForHost, withoutHostDisabledDefaults } from './runtime/host-run-compatibility'
import { promptPresetInputForHost, promptPresetUpdateForHost } from './library/host-prompt-presets'
import { createProjectCopyForHost } from './persistence/host-project-copy'
import { canvasCapabilities, canvasNodeKindAvailable } from './host-capabilities'
import { canvasHostEntryPoints, withoutUnavailableNodeEntries } from './host-entry-points'
import { workflowExportedNotice, workflowSavedNotice } from './editor/workflow-file-notices'
import { useCanvasAgentMediaCatalog } from './components/use-canvas-agent-media-catalog'
import { agentPlanFocusViewport, buildCanvasAgentContextNode } from './components/canvas-agent-context'
import type { CanvasAgentContextRequest } from './components/canvas-agent-panel-state'
import { canvasAgentNodeImageUnavailableReason, resolveCanvasAgentImageReferences, resolveCanvasAgentNodeImageAssetId } from './lib/canvas-agent-image-context'
import type { CanvasAgentClient, CanvasAgentImageReference, CanvasAgentTurn } from './lib/canvas-agent-contract'
import { canvasAgentGraphSnapshot } from './lib/canvas-agent-patch'
import { applyCanvasAgentTurn } from './editor/agent-application'
import { createCanvasAgentEditorApproval } from './editor/agent-editor-approval'
import { canvasAgentApprovedContinuationOperationId, canvasAgentApprovedExecutionOperationId, type CanvasAgentApprovalReference } from './lib/canvas-agent-approval-contract'
import { isTemplateImageAsset } from './components/template-asset-picker-model'
import { isWorkshopLibraryAsset } from './components/workshop-media-picker-model'
import { runProjectRenameTransaction } from './editor/project-rename-transaction'
import { ProjectHistoryDialog } from './components/ProjectHistoryDialog'
import { isDefiniteProjectHistoryRejection, runProjectHistoryRestore } from './editor/project-history-restore'
import { assertProjectHistoryRecoveryStored, clearProjectHistoryRecovery, projectHistoryRecoveryEvent, projectHistoryRecoveryKey, readProjectHistoryRecovery, withProjectHistoryRecoveryLock, writeProjectHistoryRecovery, type ProjectHistoryRecoveryRecord } from './editor/project-history-recovery'
import type { CanvasProjectRevisionDetail, CanvasProjectRestoreInput, CanvasProjectRestoreResult } from './lib/project-history-contract'
import { buildResourceTree, buildResourceExportWorkflow, resourceGroupSelectionIds, resourceNodeTitle } from './components/resource-tree-model'
import { CanvasInspector, type CanvasInspectorNode, type CanvasInspectorTab } from './components/CanvasInspector'
import { projectCanvasInspectorNodes } from './components/canvas-inspector-model'
import { RunPreflight } from './components/RunPreflight'
import { DramaParseConfirm } from './components/DramaParseConfirm'
import type { DramaParseTables } from './library/drama-model'
import type { DramaConfirmSelection } from './library/drama-layout'
import { SelectionToolbar } from './components/SelectionToolbar'
import { inspectSelectedNodeRun } from './components/node-run-actions'
import {
  buildCanvasClipboardPayload,
  canvasClipboardMime,
  canvasClipboardWorkflow,
  parseCanvasClipboard,
  serializeCanvasClipboard,
  pasteCanvasClipboard,
  type CanvasClipboardPayload,
} from './editor/clipboard'
import { buildCanvasClipboardTransfer, canvasClipboardCopiedHere, canvasClipboardEventAllowed, canvasClipboardOwnerId, runCanvasClipboardPaste, writeCanvasClipboardEvent } from './editor/clipboard-transport'
import { maximumProjectContentBytes, maximumProjectEdges, maximumProjectNodes, utf8ByteLength } from './lib/canvas-limits'
import { groupCanvasNodes, ungroupCanvasNode, validateParentGraph } from './editor/grouping'
import { RunInspector } from './components/RunInspector'
import { RunResultCollectionDialog } from './components/RunResultCollectionDialog'
import type { CanvasRunSummaryQuery } from './lib/run-summary-contract'
import { ProjectCenter } from './components/ProjectCenter'
import { createBlankProjectCreation, readSavedBlankProjectDraft, writeSavedBlankProjectDraft, type BlankProjectCreationState } from './lib/blank-project-creation-model'
import { CanvasCloseDialog } from './components/CanvasCloseDialog'
import { createCanvasCloseGuard, type CanvasCloseChoice, type CanvasClosePhase } from './persistence/canvas-close'
import type { CanvasCommand } from './store/canvas-command'
import { parseXingCanvasProject } from './persistence/project-package'
import {
  autoFixedDownstreamNodeIds,
  dirtyCanvasNodeIds,
  downstreamNodeIds,
  markNodeAndDescendantsDirty,
  projectRunRecordToNodes,
  selectNodeCandidate,
} from './runtime/run-projection'
import { BookmarkPlus, Building2, ChevronDown, Magnet, Unplug, Crosshair, FolderOpen, Focus, History, Image as ImageIcon, LayoutGrid, ListChecks, Map as MapIcon, MessageSquareText, MoreHorizontal, PanelRight, Play, Plus, Redo2, Search, SlidersHorizontal, Sparkles, Undo2, Video, X } from 'lucide-react'
import { canvasNodeDocumentRecord, useCanvasDocument } from './store/use-canvas-document'
import type { InsertionViewportToken } from './store/insertion-viewport-history'
import type { CanvasDocumentState, CanvasMediaGroups } from './store/canvas-state'
import type { EditorNodeRecord } from './domain/node-definition'
import { applyCatalogClipDurationToNodes, assetInputNodeKind, mediaAssetNodeDimensions, pendingMediaNodeDimensions, requestedClipDurationSeconds, unresolvedMediaPlacementDimensions } from './library/media-assets'
import { buildCanvasMediaAssetBinding } from './library/bind-media-asset'
import { completeCanvasMediaImport } from './library/media-import-completion'
import { groupsForCapability, mediaGroupsEqual, preferredModelForNodeType, withPreferredMediaDefaults, type MediaCapabilityKind } from './library/media-groups'
import { awaitingCanvasFixedVideoSources, canvasNodeMediaKind, canvasNodeSourceSignature, emptyCanvasNodeSourceCatalog, fixedCanvasNodeSourceNames, prepareCanvasNodeSources, resolveCanvasNodeModelAvailability, type CanvasNodeSourceCatalog } from './library/node-model-availability'
import { canvasMediaCatalogSignature, isCanvasMediaPreparationCurrent, isCanvasMediaPreparationScopeError, mediaKeyCreatedNotice, prepareCanvasMediaSources, type CanvasMediaPreparationErrors, type CanvasMediaPreparationProgress, type CanvasMediaPreparationScope, type CanvasPreparedMediaConfiguration, type MediaPreparationKind } from './library/media-preparation'
import { canvasMediaPurposePreparationSignature, canvasPendingMediaKinds, mergeCanvasMediaPreparationDefaults, pendingCanvasMediaRunKinds, unavailableCanvasMediaRunGroups } from './library/media-progress-scope'
import { maximumOutputTextLength } from './persistence/workflow-schema'
import { canvasGroupDisplayName, createCanvasGroupCatalog, groupDropdownKeyOpens } from './library/group-catalog'
import { compileAssetSheetPrompt } from './library/drama-compile'
import { dramaPreflightBlockReasons, collectDramaShotAlerts, compileConnectedShotPrompt, markDownstreamShotsStale, resolveDramaShotGate } from './library/drama-graph'
import { buildDramaNodesFromTables } from './library/drama-layout'
import { parseDramaTablesJson } from './library/drama-parse'
import { dramaAssetKindForType, isDramaAssetNodeType, readDramaAsset, readDramaBible, readDramaShot, dramaAssetSettings, dramaShotSettings } from './library/drama-settings'
import { promptPresetMime } from './library/prompt-presets'
import { cachedNodeIdsForPreflight } from './runtime/pinned-reuse'
import { QuickInsert, type QuickInsertCommand } from './components/QuickInsert'
import { TemplateCatalog } from './components/TemplateCatalog'
import { clipPromptEditorValue } from './components/prompt-mentions'
import { PromptCatalogProvider, useWorkspacePromptCatalog } from './components/PromptCatalogContext'
import { maximumPromptPresetLength, type PromptPresetInput, type PromptPresetUpdateInput, type PromptPresetOrderInput } from './library/prompt-preset-contract'
import { findAvailableCanvasPosition } from './editor/node-placement'
import { createCreatedNodeFocusCoordinator, createdNodeFocusZoom, createdNodeNeedsFocus } from './editor/node-focus'
import { useCanvasNarrowLayout } from './editor/narrow-canvas-layout'
import { applyCanvasAppearance, initialCanvasAppearance, subscribeCanvasTheme, type CanvasTheme } from './theme/canvas-theme'
import {
  buildCanvasRunPreflight,
  canvasMediaConfigurationErrors,
  sameCanvasRunGraphSnapshot,
  selectCanvasRunNodeIds,
  type CanvasRunPreflight,
} from './runtime/run-preflight'
import { canvasRunStatusLabel, mergeCanvasRunEvent } from './runtime/run-events'
import { matchingCanvasRunNodeIds, matchingRunRecordNodes } from './runtime/run-input-matching'
import { sameCanvasMediaAsset } from './library/media-result'
import {
  canvasStartupUiPreferences,
  defaultCanvasUiPreferences,
  readCanvasUiPreferences,
  writeCanvasUiPreferences,
  type CanvasRightPanel,
  type CanvasUiPreferences,
} from './persistence/canvas-ui-preferences'
import { canvasAutosaveErrorMessage, canvasAutosaveGraphSignature, canvasAutosaveSignature } from './persistence/canvas-autosave'
import { canvasWorkflowSnapshotNeedsSave, inspectCanvasWorkflowSnapshot, type CanvasWorkflowSnapshot } from './persistence/workflow-snapshot'
import { assertCanvasBrowserDraftStored, buildCanvasBrowserDraftWriterRotation, clearCanvasBrowserDraft, confirmRemoveCanvasBrowserDraft, createCanvasBrowserDraft, isSameCanvasBrowserDraftIdentity, listCanvasBrowserDrafts, selectCanvasBrowserDraft, writeCanvasBrowserDraft, type CanvasBrowserDraft, type CanvasBrowserDraftSelection } from './persistence/browser-draft'
import { buildCanvasDraftConfirmation, canvasDraftConfirmationCurrent, confirmCanvasDraftActionRemoval, createCanvasDraftActionGuard, isSameCanvasDraftActionScope, reserveCanvasDraftRevision, resolveCanvasDraftProtectionAfterWriteFailure, type CanvasDraftActionScope, type CanvasDraftConfirmation } from './persistence/browser-draft-actions'

// 画布装配层:@xyflow/react 的 Node/Edge 与领域模型互相映射,引擎与
// 持久化只见领域模型。M0 执行走 mock 执行器(不出网);M1 把 executors
// 换成 relay 真实现(engine/relay.ts),本文件的编排逻辑不变。

let nodeSequence = 0

function nextNodeId(): string {
  nodeSequence += 1
  return `n${Date.now().toString(36)}-${nodeSequence}`
}

function connectionEventPoint(event: MouseEvent | TouchEvent): { x: number; y: number } | null {
  const point = 'changedTouches' in event ? event.changedTouches[0] : event
  return point ? { x: point.clientX, y: point.clientY } : null
}

function canvasModalOpen(): boolean {
  return [...document.querySelectorAll<HTMLElement>(canvasModalSelector)].some((element) => !element.closest('[hidden], [inert], [aria-hidden="true"]') && element.getClientRects().length > 0)
}

export function toCanvasNode(node: WorkflowNode): CanvasNode {
  const displayKind = node.disabled && node.unknownKind ? 'unknown' : node.kind
  // Content nodes grow with their fields, validation and output. A fixed
  // wrapper height hides that geometry from React Flow's resize observer.
  const { width, height } = canvasNodeDisplayGeometry(node)
  return {
    id: node.id,
    type: displayKind,
    definitionVersion: node.definitionVersion ?? 1,
    ...(node.disabled ? { disabled: true } : {}),
    ...(node.unknownKind ? { unknownKind: node.unknownKind } : {}),
    position: node.position,
    data: { ...node.data, __canvasDisabled: node.disabled === true, __canvasLocked: node.locked === true },
    ...(node.parentId ? { parentId: node.parentId, extent: 'parent' as const } : {}),
    ...(width ? { width, style: { width } } : {}),
    ...(height ? { height, style: { ...(width ? { width } : {}), height } } : {}),
    ...(node.locked ? { draggable: false, selectable: true } : {}),
  }
}

/** What the editor saves, exports or compares is shaped for what the host's project store keeps (#4). */
function serializeWorkflow(workflow: WorkflowFile): string {
  return serializeKernelWorkflow(workflow, canvasCapabilities().project)
}

export function toWorkflowNode(node: CanvasNode): WorkflowNode {
  return {
    id: node.id,
    kind: node.type as NodeKind,
    definitionVersion: node.definitionVersion,
    ...(node.disabled ? { disabled: true } : {}),
    ...(node.unknownKind ? { unknownKind: node.unknownKind } : {}),
    ...(node.parentId ? { parentId: node.parentId } : {}),
    ...(node.width ? { width: node.width } : {}),
    ...(node.height ? { height: node.height } : {}),
    ...(node.draggable === false ? { locked: true } : {}),
    position: node.position,
    data: {
      prompt: node.data.prompt,
      ...(node.data.promptReferences?.length ? { promptReferences: node.data.promptReferences } : {}),
      ...(['text-generate', 'output'].includes(node.type ?? '') && typeof node.data.outputText === 'string' ? { outputText: node.data.outputText.slice(0, maximumOutputTextLength) } : {}),
      ...(node.data.dirty === true ? { dirty: true } : {}),
      model: node.data.model,
      ...(node.data.group !== undefined ? { group: node.data.group } : {}),
      quality: node.data.quality,
      size: node.data.size,
      imageResolution: node.data.imageResolution,
      imageCandidateCount: parseImageCandidateCount(node.data.imageCandidateCount, node.type ?? ''),
        videoCandidateCount: parseVideoCandidateCount(node.data.videoCandidateCount, node.type ?? ''),
      ...(node.data.textWebSearch !== undefined ? { textWebSearch: parseTextWebSearch(node.data.textWebSearch, node.type ?? '') } : {}),
      seconds: node.data.seconds,
      status: node.data.status,
      result: node.data.result,
      errorMessage: node.data.errorMessage,
      costQuota: node.data.costQuota,
      settings: node.data.settings,
      candidateAssetIds: node.data.candidateAssetIds,
      latestAttemptDurationMs: node.data.latestAttemptDurationMs,
    },
  }
}

export function toCanvasRunGraph(
  nodes: readonly CanvasNode[],
  edges: readonly Edge[],
  groups: { image: string; video: string; videoProtocol?: VideoProtocol; text?: string; imageModel?: string; videoModel?: string; textModel?: string },
  sourceCatalog: CanvasNodeSourceCatalog = {},
): CanvasRunGraph {
  const runnableNodes = nodes.filter(isCanvasGraphNode)
  if (runnableNodes.some((node) => node.type === 'router' || Object.hasOwn(node.data.settings ?? {}, 'routerStrategy'))) assertRouterStrategyWorkflowConfiguration({ nodes: runnableNodes.map(toWorkflowNode) })
  const runnableIds = new Set(runnableNodes.map((node) => node.id))
  const nodesWithIncoming = new Set(edges.filter((edge) => runnableIds.has(edge.source)).map((edge) => edge.target))
  return {
    nodes: runnableNodes.map((node) => ({
      id: node.id,
      kind: node.type ?? 'text',
      definitionVersion: node.definitionVersion,
      ...(node.disabled ? { disabled: true } : {}),
      data: {
        prompt: node.data.prompt,
        ...(Object.hasOwn(node.data.settings ?? {}, 'routerStrategy') ? { routerStrategy: parseNodeRouterStrategy(node.type ?? '', node.data.settings?.routerStrategy) } : {}),
        model: node.data.model || (node.data.group !== undefined ? '' : ['text-generate', 'drama-parse'].includes(node.type ?? '') ? groups.textModel ?? '' : ['image', 'image-generate', 'image-edit'].includes(node.type ?? '') ? groups.imageModel ?? '' : ['video', 'video-generate'].includes(node.type ?? '') ? groups.videoModel ?? '' : ''),
        ...(['image', 'image-generate', 'image-edit'].includes(node.type ?? '') ? { group: node.data.group ?? groups.image } : {}),
        ...(['video', 'video-generate'].includes(node.type ?? '') ? { group: node.data.group ?? groups.video, ...((node.data.group !== undefined ? sourceCatalog[node.data.group]?.videoProtocol : groups.videoProtocol) ? { videoProtocol: node.data.group !== undefined ? sourceCatalog[node.data.group]?.videoProtocol : groups.videoProtocol } : {}) } : {}),
        ...(['text-generate', 'drama-parse'].includes(node.type ?? '') && (node.data.group !== undefined || groups.text) ? { group: node.data.group ?? groups.text } : {}),
        quality: node.data.quality,
        size: node.data.size,
        imageResolution: node.data.imageResolution,
        imageCandidateCount: parseImageCandidateCount(node.data.imageCandidateCount, node.type ?? ''),
        videoCandidateCount: parseVideoCandidateCount(node.data.videoCandidateCount, node.type ?? ''),
        ...(node.data.textWebSearch !== undefined ? { textWebSearch: parseTextWebSearch(node.data.textWebSearch, node.type ?? '') } : {}),
        ...(node.data.settings?.imageEditMask !== undefined ? { imageEditMask: parseNodeImageEditMask(node.type ?? '', node.data.settings.imageEditMask) } : {}),
        ...(node.data.settings?.commerceTask !== undefined ? { commerceTask: parseNodeCommerceTask(node.type ?? '', node.data.settings.commerceTask) } : {}),
        ...(node.data.settings?.interiorTask !== undefined ? { interiorTask: parseNodeInteriorTask(node.type ?? '', node.data.settings.interiorTask) } : {}),
        ...(node.data.settings?.exteriorTask !== undefined ? { exteriorTask: parseNodeExteriorTask(node.type ?? '', node.data.settings.exteriorTask) } : {}),
        ...(node.data.settings?.storyboardTask !== undefined ? { storyboardTask: parseNodeStoryboardTask(node.type ?? '', node.data.settings.storyboardTask) } : {}),
        ...(node.data.settings?.imageReferenceOrder !== undefined ? { imageReferenceOrder: parseNodeImageReferenceOrder(node.type ?? '', node.data.settings.imageReferenceOrder) } : {}),
        seconds: node.data.seconds,
        ...(node.data.settings?.generateAudio !== undefined ? { generateAudio: parseVideoGenerateAudio(node.data.settings.generateAudio, node.type ?? '') } : {}),
        ...(['video', 'video-generate'].includes(node.type ?? '') ? { videoReferenceOrder: node.data.settings?.videoReferenceOrder === undefined ? { version: 1 as const, slots: [] } : parseVideoReferenceOrder(node.data.settings.videoReferenceOrder) } : {}),
        // A changed upstream makes the gallery's old preview stale. Sending
        // it as a choice would override the newly selected upstream output.
        // Explicit gallery choices clear dirty; isolated bindings remain input.
        adoptedAssetId: node.type === 'gallery' && node.data.dirty === true && nodesWithIncoming.has(node.id)
          ? undefined
          : node.data.result?.assetId,
        videoMode: typeof node.data.settings?.videoMode === 'string'
          ? node.data.settings.videoMode as CanvasRunGraph['nodes'][number]['data']['videoMode']
          : undefined,
        videoResolution: typeof node.data.settings?.videoResolution === 'string'
          ? node.data.settings.videoResolution as CanvasRunGraph['nodes'][number]['data']['videoResolution']
          : undefined,
        videoAspectRatio: typeof node.data.settings?.videoAspectRatio === 'string'
          ? node.data.settings.videoAspectRatio as CanvasRunGraph['nodes'][number]['data']['videoAspectRatio']
          : undefined,
        promptOptimization: typeof node.data.settings?.promptOptimization === 'boolean'
          ? node.data.settings.promptOptimization
          : undefined,
        ...(isImageTransformNodeKind(node.type ?? '') ? { imageTransform: imageTransformRecipeForNode(node.type ?? '', node.data.settings)!, imageOutputIndex: Math.max(0, node.data.candidates?.find((candidate) => candidate.asset.assetId === node.data.result?.assetId)?.outputIndex ?? node.data.candidateAssetIds?.indexOf(node.data.result?.assetId ?? '') ?? 0) } : {}),
        ...(node.type === 'image-collage' && node.data.settings?.imageCollageInputOrder !== undefined ? { imageCollageInputOrder: parseImageCollageInputOrder(node.data.settings.imageCollageInputOrder) } : {}),
        ...(node.data.settings?.tileInput !== undefined ? { tileInput: parseNodeTileInput(node.type ?? '', node.data.settings.tileInput) } : {}),
        ...(node.type === 'frame-extract' ? { frameTimestampSeconds: typeof node.data.settings?.timestampSeconds === 'number' ? node.data.settings.timestampSeconds : 0 } : {}),
      },
    })),
    edges: edges
      .filter((edge) => runnableIds.has(edge.source) && runnableIds.has(edge.target))
      .map(toWorkflowEdge),
  }
}

export { canvasMediaConfigurationErrors, selectCanvasRunNodeIds }

/** Editing a task must also detect changes to its analysis and image ancestors. */
export function exteriorTaskEditSignature(nodes: readonly WorkflowNode[], edges: readonly WorkflowEdge[], nodeId: string, references: readonly unknown[]): string {
  const ids = new Set<string>(), pending = [nodeId]
  while (pending.length) {
    const id = pending.pop()!
    if (ids.has(id)) continue
    ids.add(id)
    const node = nodes.find((entry) => entry.id === id)
    if (node?.parentId) pending.push(node.parentId)
    for (const edge of edges) if (edge.target === id) pending.push(edge.source)
  }
  return JSON.stringify([
    nodes.filter((node) => ids.has(node.id)).sort((a, b) => a.id.localeCompare(b.id)),
    edges.filter((edge) => ids.has(edge.target)).sort((a, b) => a.id.localeCompare(b.id)),
    references,
  ])
}

export function exteriorTaskSourceSignature(groups: readonly CanvasGroupSummary[], group?: string): string {
  return JSON.stringify([group ?? '', groups.find((entry) => entry.name === group) ?? null])
}

export function exteriorTaskInitialSourceCurrent(initial: string, current: string, group?: string): boolean {
  return initial === current || initial === exteriorTaskSourceSignature([], group) || initial === exteriorTaskSourceSignature([])
}

export function storyboardTaskEditSignature(...args: Parameters<typeof exteriorTaskEditSignature>): string { return exteriorTaskEditSignature(...args) }
export function storyboardTaskSourceSignature(...args: Parameters<typeof exteriorTaskSourceSignature>): string { return exteriorTaskSourceSignature(...args) }
export function storyboardTaskInitialSourceCurrent(...args: Parameters<typeof exteriorTaskInitialSourceCurrent>): boolean { return exteriorTaskInitialSourceCurrent(...args) }

export function isCanvasGraphNode(node: CanvasNode): boolean {
  const definition = builtinNodeRegistry.resolve(node.type ?? 'unknown')
  return Boolean(definition?.executable) && node.type !== 'unknown' && !node.unknownKind
}

export function isCanvasRunnableTarget(node: CanvasNode): boolean {
  return isCanvasGraphNode(node) && !node.disabled
}

const rerunTextSourceKinds = new Set(['text', 'prompt'])
const rerunImageSourceKinds = new Set(['image', 'image-input', 'image-generate', 'image-edit', 'gallery', 'image-crop', 'image-collage', 'image-grid-split', 'image-tile', 'image-layer', 'image-compare', 'image-panorama'])
const rerunVideoSourceKinds = new Set(['video', 'video-input', 'video-generate', 'gallery'])
const rerunAudioSourceKinds = new Set(['audio-input', 'gallery'])

export function workflowNodeData(type: string, config: Record<string, unknown> = {}, freshNode = false): WorkflowNodeData {
  const defaults = builtinNodeRegistry.require(type).defaultData
  const values = { ...structuredClone(defaults), ...structuredClone(config) }
  // Registry defaults apply to an explicit new node, never an old template.
  if (type === 'router' && !freshNode && !Object.hasOwn(config, 'routerStrategy')) delete values.routerStrategy
  if ('durationSeconds' in config && !('seconds' in config)) delete values.seconds
  const prompt = typeof values.prompt === 'string' ? values.prompt : ''
  const promptReferences = parsePromptReferences(prompt, values.promptReferences)
  const model = typeof values.model === 'string' ? values.model : ''
  if (values.group !== undefined && typeof values.group !== 'string') throw new Error('节点固定来源格式不正确，请重新配置此节点')
  const quality = typeof values.quality === 'string' ? values.quality : undefined
  const size = typeof values.size === 'string' ? values.size : undefined
  const imageResolution = values.imageResolution === '1K' || values.imageResolution === '2K' || values.imageResolution === '4K'
    ? values.imageResolution
    : undefined
  const imageCandidateCount = parseImageCandidateCount(values.imageCandidateCount, type)
  const videoCandidateCount = parseVideoCandidateCount(values.videoCandidateCount, type)
  const textWebSearch = parseTextWebSearch(values.textWebSearch, type)
  const seconds = typeof values.seconds === 'string' && /^(?:[1-9]|1[0-5])$/.test(values.seconds) ? values.seconds : undefined
  const assetId = typeof values.assetId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(values.assetId)
    ? values.assetId
    : undefined
  const assetKind = type === 'video-input' ? 'video' : type === 'audio-input' ? 'audio' : 'image'
  const result = assetId && (type === 'image-input' || type === 'video-input' || type === 'audio-input')
    ? { kind: assetKind, assetId, localUrl: `xingmang-asset://${assetKind}/${assetId}` } as const
    : undefined
  const settings = Object.fromEntries(Object.entries(values).filter(([key]) => !['prompt', 'promptReferences', 'outputText', 'model', 'group', 'quality', 'size', 'imageResolution', 'imageCandidateCount', 'videoCandidateCount', 'textWebSearch', 'seconds', 'status', 'result', 'assetId'].includes(key)))
  return {
    prompt,
    ...(promptReferences.length ? { promptReferences } : {}),
    ...(['text-generate', 'output'].includes(type) && typeof values.outputText === 'string' ? { outputText: values.outputText.slice(0, maximumOutputTextLength) } : {}),
    model,
    ...(typeof values.group === 'string' ? { group: values.group } : {}),
    status: result ? 'succeeded' : 'idle',
    ...(quality ? { quality } : {}),
    ...(size ? { size } : {}),
    ...(imageResolution ? { imageResolution } : {}),
    ...(imageCandidateCount !== undefined ? { imageCandidateCount } : {}),
    ...(videoCandidateCount !== undefined ? { videoCandidateCount } : {}),
    ...(textWebSearch !== undefined ? { textWebSearch } : {}),
    ...(seconds ? { seconds } : {}),
    ...(result ? { result } : {}),
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  }
}

function imageOperationDefaults(
  type: string,
  imageModels: readonly string[] = [],
  videoModels: readonly string[] = [],
  preferred: Record<string, unknown> = {},
): Record<string, unknown> {
  return operationDefaultsForTemplateNode(type, imageModels, videoModels, preferred).config
}

export function editorNodeToCanvasNode(node: EditorNodeRecord): CanvasNode {
  const raw = node.data
  if (raw.group !== undefined && typeof raw.group !== 'string') throw new Error('节点固定来源格式不正确，请重新配置此节点')
  const imageCandidateCount = parseImageCandidateCount(raw.imageCandidateCount, node.type)
  const videoCandidateCount = parseVideoCandidateCount(raw.videoCandidateCount, node.type)
  const textWebSearch = parseTextWebSearch(raw.textWebSearch, node.type)
  const result = raw.result as AssetRef | undefined
  const prompt = typeof raw.prompt === 'string' ? clipPromptEditorValue(raw.prompt).value : ''
  const promptReferences = parsePromptReferences(prompt, raw.promptReferences)
  const data: WorkflowNodeData = {
    // Keep loaded projects within the editor's 10,000-character limit. Older
    // projects may contain repeated upstream text from the previous
    // run-commit behavior; the upstream service remains the final authority.
    prompt,
    ...(promptReferences.length ? { promptReferences } : {}),
    ...(['text-generate', 'output'].includes(node.type) && typeof raw.outputText === 'string' ? { outputText: raw.outputText.slice(0, maximumOutputTextLength) } : {}),
    ...(raw.dirty === true ? { dirty: true } : {}),
    model: typeof raw.model === 'string' ? raw.model : '',
    ...(typeof raw.group === 'string' ? { group: raw.group } : {}),
    status: result?.assetId || (['text-generate', 'output'].includes(node.type) && raw.outputText) ? 'succeeded' : 'idle',
    ...(typeof raw.quality === 'string' ? { quality: raw.quality } : {}),
    ...(typeof raw.size === 'string' ? { size: raw.size } : {}),
    ...(raw.imageResolution === '1K' || raw.imageResolution === '2K' || raw.imageResolution === '4K'
      ? { imageResolution: raw.imageResolution }
      : {}),
    ...(imageCandidateCount !== undefined ? { imageCandidateCount } : {}),
    ...(videoCandidateCount !== undefined ? { videoCandidateCount } : {}),
    ...(textWebSearch !== undefined ? { textWebSearch } : {}),
    ...(typeof raw.seconds === 'string' ? { seconds: raw.seconds } : {}),
    ...(result ? { result } : {}),
    ...(raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)
      ? { settings: raw.settings as Record<string, unknown> }
      : {}),
    ...(Array.isArray(raw.candidateAssetIds)
      ? { candidateAssetIds: raw.candidateAssetIds.filter((entry): entry is string => typeof entry === 'string') }
      : {}),
  }
  return toCanvasNode({
    id: node.id,
    kind: node.type as NodeKind,
    definitionVersion: node.definitionVersion,
    position: node.position,
    data,
    ...(node.parentId ? { parentId: node.parentId } : {}),
    ...(node.width ? { width: node.width } : {}),
    ...(node.height ? { height: node.height } : {}),
    ...(node.locked ? { locked: true } : {}),
    ...(node.disabled ? { disabled: true } : {}),
    ...(node.unknownKind ? { unknownKind: node.unknownKind } : {}),
  })
}

function workflowDocument(workflow: WorkflowFile): CanvasDocumentState {
  return {
    name: workflow.name,
    mediaGroups: { ...(workflow.mediaGroups ?? {}) },
    nodes: workflow.nodes.map((node) => ({
      id: node.id,
      type: node.kind,
      definitionVersion: node.definitionVersion ?? 1,
      position: { ...node.position },
      data: structuredClone(node.data) as unknown as Record<string, unknown>,
      ...(node.parentId ? { parentId: node.parentId } : {}),
      ...(node.width ? { width: node.width } : {}),
      ...(node.height ? { height: node.height } : {}),
      ...(node.locked ? { locked: true } : {}),
      ...(node.disabled ? { disabled: true } : {}),
      ...(node.unknownKind ? { unknownKind: node.unknownKind } : {}),
    })),
    edges: workflow.edges.map((edge) => ({ ...edge })),
    viewport: workflow.viewport ?? { x: 0, y: 0, zoom: 1 },
    revision: 0,
  }
}

function mediaAssetRef(asset: CanvasAssetSummary): AssetRef {
  return {
    kind: asset.mediaType,
    assetId: asset.assetId,
    localUrl: asset.localUrl,
    mimeType: asset.mimeType,
    ...('width' in asset && asset.width ? { width: asset.width } : {}),
    ...('height' in asset && asset.height ? { height: asset.height } : {}),
    ...('durationSeconds' in asset && asset.durationSeconds ? { durationSeconds: asset.durationSeconds } : {}),
    ...('taskId' in asset && asset.taskId ? { taskId: asset.taskId } : {}),
  }
}

function generatedAssetRef(asset: CanvasGeneratedAsset): AssetRef {
  return mediaAssetRef({
    ...asset,
    createdAt: '',
    mediaType: 'image',
    thumbnailUrl: asset.localUrl,
    displayName: asset.fileName,
  })
}

function generatedVideoAssetRef(asset: CanvasGeneratedVideoAsset): AssetRef {
  return {
    kind: 'video',
    assetId: asset.assetId,
    localUrl: asset.localUrl,
    mimeType: asset.mimeType,
    taskId: asset.taskId,
    ...(asset.width ? { width: asset.width } : {}),
    ...(asset.height ? { height: asset.height } : {}),
    ...(asset.durationSeconds ? { durationSeconds: asset.durationSeconds } : {}),
  }
}

function generatedImageSummary(asset: CanvasGeneratedAsset): CanvasAssetSummary {
  return {
    ...asset,
    createdAt: new Date().toISOString(),
    mediaType: 'image',
    thumbnailUrl: asset.localUrl,
    displayName: asset.fileName,
  }
}

function importedAssetSummary(asset: CanvasGeneratedAsset | CanvasAssetSummary): CanvasAssetSummary {
  return 'mediaType' in asset ? asset : generatedImageSummary(asset)
}

function toWorkflowEdge(edge: Edge): WorkflowEdge {
  return {
    id: edge.id,
    source: edge.source,
    sourceHandle: edge.sourceHandle ?? '',
    target: edge.target,
    targetHandle: edge.targetHandle ?? '',
  }
}

function MediaConfiguration({
  open,
  groups,
  imageGroup,
  videoGroup,
  textGroup,
  imageModel,
  videoModel,
  textModel,
  imageModels,
  videoModels,
  textModels,
  preparing,
  pendingKinds,
  refreshingGroups,
  groupsError,
  preparationErrors,
  groupsLoaded,
  onRefreshGroups,
  onToggle,
  onClose,
  onSelectGroup,
  onSelectModel,
  manageSourcesUrl,
}: {
  open: boolean
  groups: readonly CanvasGroupSummary[]
  imageGroup: string | null
  videoGroup: string | null
  textGroup: string | null
  imageModel: string | null
  videoModel: string | null
  textModel: string | null
  imageModels: readonly string[]
  videoModels: readonly string[]
  textModels: readonly string[]
  preparing: MediaPreparationKind | null
  pendingKinds: readonly MediaCapabilityKind[]
  refreshingGroups: boolean
  groupsError: string | null
  preparationErrors: CanvasMediaPreparationErrors
  groupsLoaded: boolean
  onRefreshGroups(force?: boolean): void
  onToggle(): void
  onClose(): void
  onSelectGroup(kind: MediaCapabilityKind, group: string): void
  onSelectModel(kind: MediaCapabilityKind, model: string): void
  manageSourcesUrl?: string
}) {
  const imagePresets = availableImageModelPresets(imageModels, true)
  const videoPresets = availableVideoModelPresets(videoModels, true, canvasCapabilities())
  const textPresets = [...textModels]
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])
  useEffect(() => {
    if (!open) return
    const focusFrame = window.requestAnimationFrame(() => panelRef.current
      ?.querySelector<HTMLElement>('select:not(:disabled), button:not(:disabled)')
      ?.focus())
    const closeAndRestore = () => {
      onCloseRef.current()
      triggerRef.current?.focus()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (canvasKeyboardEventBlocked(event, { modalOpen: canvasModalOpen() })) return
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeAndRestore()
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) onCloseRef.current()
    }
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [open])

  const closeAndRestoreFocus = () => {
    onClose()
    triggerRef.current?.focus()
  }
  return (
    <div ref={rootRef} className="canvas-media-config">
      <button
        ref={triggerRef}
        type="button"
        className="canvas-config-command"
        aria-label="生成配置"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="canvas-media-config-panel"
        title="分别设置生图、视频与文字生成分组及默认模型"
        onClick={onToggle}
      >
        <SlidersHorizontal size={14} aria-hidden="true" />
        <span>生成配置</span>
      </button>
      {open && (
        <section ref={panelRef} id="canvas-media-config-panel" className="canvas-media-config-panel" role="dialog" aria-label="画布生成配置">
          <header>
            <span><strong>生成配置</strong><small>按能力选择分组和默认模型</small></span>
            <button type="button" className="canvas-icon-command" aria-label="关闭生成配置" title="关闭" onClick={closeAndRestoreFocus}><X size={14} /></button>
          </header>
          <div aria-live="polite">
            {refreshingGroups && <small role="status">正在刷新分组…</small>}
            {groupsError && <small role="alert">分组刷新失败，已保留原列表。{groupsError}</small>}
            {groupsError && <button type="button" onClick={() => onRefreshGroups(true)} disabled={refreshingGroups}>重试刷新分组</button>}
            {preparing && pendingKinds.length > 0 && <small role="status">正在后台核对来源；已就绪的用途可以使用，画布可继续编辑和保存。</small>}
            {Object.keys(preparationErrors).length > 0 && <button type="button" onClick={() => onRefreshGroups(true)} disabled={refreshingGroups}>重新核对模型</button>}
          </div>
          <MediaCapabilityField
            kind="image"
            title="生图分组"
            icon={<ImageIcon size={15} aria-hidden="true" />}
            group={imageGroup}
            model={imageModel}
            groups={groups}
            groupsLoaded={groupsLoaded}
            onRefreshGroups={onRefreshGroups}
            models={imagePresets.map((preset) => ({ id: preset.id, label: preset.label }))}
            preparing={pendingKinds.includes('image')}
            busy={pendingKinds.includes('image')}
            emptyHint="该分组当前没有可用图像模型"
            error={preparationErrors.image}
            autoFocus
            onSelectGroup={onSelectGroup}
            onSelectModel={onSelectModel}
          />
          <MediaCapabilityField
            kind="video"
            title="视频分组"
            icon={<Video size={15} aria-hidden="true" />}
            group={videoGroup}
            model={videoModel}
            groups={groups}
            groupsLoaded={groupsLoaded}
            onRefreshGroups={onRefreshGroups}
            models={videoPresets.map((preset) => ({ id: preset.id, label: preset.label }))}
            preparing={pendingKinds.includes('video')}
            busy={pendingKinds.includes('video')}
            emptyHint="该分组当前没有可用视频模型"
            error={preparationErrors.video}
            onSelectGroup={onSelectGroup}
            onSelectModel={onSelectModel}
          />
          <MediaCapabilityField
            kind="text"
            title="文字分组"
            icon={<MessageSquareText size={15} aria-hidden="true" />}
            group={textGroup}
            model={textModel}
            groups={groups}
            groupsLoaded={groupsLoaded}
            onRefreshGroups={onRefreshGroups}
            models={textPresets.map((id) => ({ id, label: id }))}
            preparing={pendingKinds.includes('text')}
            busy={pendingKinds.includes('text')}
            emptyHint="该分组当前没有可用聊天模型"
            error={preparationErrors.text}
            onSelectGroup={onSelectGroup}
            onSelectModel={onSelectModel}
          />
          {manageSourcesUrl && <div className="canvas-web-model-help">
            <p>还没有模型，或需要更换 API Key？</p>
            <a href={manageSourcesUrl} target="_blank" rel="noopener noreferrer">管理模型与 API Key ↗</a>
            <span>配置页会在新标签打开，当前画布保持打开。</span>
            <button type="button" disabled={refreshingGroups} onClick={() => onRefreshGroups(true)}>刷新来源与模型</button>
          </div>}
        </section>
      )}
    </div>
  )
}

/**
 * An account switch is a renderer lifecycle boundary. Keeping this boundary
 * above the large workspace component guarantees that every account-owned
 * ref and React state (groups, projects, assets, runs, drafts and in-flight
 * projections) is discarded together, including future state added to the
 * workspace without a second reset hook.
 */
export function App({ initialTheme = 'dark', draftOwnerId, creationOwnerId, draftActionsEnabled = true, storageMode = 'local', slots = noCanvasSlots }: { initialTheme?: CanvasTheme; draftOwnerId?: number; creationOwnerId?: string; draftActionsEnabled?: boolean; storageMode?: 'local' | 'cloud'; slots?: CanvasKernelSlots }) {
  const [accountEpoch, setAccountEpoch] = useState(0)
  const [siteId, setSiteId] = useState<'solov' | 'solov-api'>(() => new URLSearchParams(window.location.search).get('siteId') === 'solov-api' ? 'solov-api' : 'solov')
  const [accountChangeNotice, setAccountChangeNotice] = useState<string | null>(null)

  useEffect(() => {
    document.documentElement.dataset.canvasReady = 'true'
    return () => { delete document.documentElement.dataset.canvasReady }
  }, [])

  useEffect(() => {
    const host = window.xingmangCanvasHost
    if (typeof host?.onAccountChange !== 'function') return
    return host.onAccountChange(({ userId, siteId: nextSiteId }) => {
      if (nextSiteId === 'solov' || nextSiteId === 'solov-api') setSiteId(nextSiteId)
      setAccountChangeNotice(userId === null
        ? '星芒账号已退出，画布状态已清空。'
        : '星芒账号已切换，画布已重新加载；未保存编辑未保留。')
      setAccountEpoch((value) => value + 1)
    })
  }, [])

  return <CanvasWorkspace key={`${siteId}:${accountEpoch}`} initialTheme={initialTheme} siteId={siteId} accountChangeNotice={accountChangeNotice} draftOwnerId={draftOwnerId} creationOwnerId={creationOwnerId} draftActionsEnabled={draftActionsEnabled} storageMode={storageMode} slots={canvasCapabilities().features.cloud ? slots : noCanvasSlots} />
}

function MediaCapabilityField({
  kind,
  title,
  icon,
  group,
  model,
  groups,
  groupsLoaded,
  onRefreshGroups,
  models,
  preparing,
  busy,
  emptyHint,
  error,
  autoFocus,
  onSelectGroup,
  onSelectModel,
}: {
  kind: MediaCapabilityKind
  title: string
  icon: JSX.Element
  group: string | null
  model: string | null
  groups: readonly CanvasGroupSummary[]
  groupsLoaded: boolean
  onRefreshGroups(force?: boolean): void
  models: readonly { id: string; label: string }[]
  preparing: boolean
  busy: boolean
  emptyHint: string
  error?: string
  autoFocus?: boolean
  onSelectGroup(kind: MediaCapabilityKind, group: string): void
  onSelectModel(kind: MediaCapabilityKind, model: string): void
}) {
  const groupLabel = `${title}分组选择`
  const modelLabel = `${title.replace('分组', '')}默认模型`
  const selectedModel = model || ''
  const unavailableModel = Boolean(model && !models.some((entry) => entry.id === model))
  const compatibleGroups = groupsForCapability(groups, kind)
  const declaredPurpose = Boolean(groups.find((entry) => entry.name === group)?.purposes)
  const unavailable = Boolean(group && groupsLoaded && !compatibleGroups.some((entry) => entry.name === group))
  return (
    <div className="canvas-media-config-field">
      <span className="canvas-media-config-label">{icon}<span><strong>{title}</strong><small>{preparing ? '正在核对模型来源…' : `${models.length} 个可用模型`}</small></span></span>
      <label className="canvas-media-config-control">
        <span>分组</span>
        <select autoFocus={autoFocus} aria-label={groupLabel} aria-invalid={unavailable} value={group ?? ''}
          onPointerDown={() => onRefreshGroups()} onFocus={() => onRefreshGroups()}
          onKeyDown={(event) => { if (groupDropdownKeyOpens(event.key)) onRefreshGroups() }}
          onChange={(event) => onSelectGroup(kind, event.target.value)}>
          {!group && <option value="" disabled>请选择分组</option>}
          {unavailable && <option value={group!} disabled>来源不可用 · {group}</option>}
          {compatibleGroups.map((entry) => <option key={entry.name} value={entry.name}>{canvasGroupDisplayName(entry.name, groups)}{entry.purposes ? '' : ` · ${entry.ratio}x`}</option>)}
        </select>
      </label>
      <label className="canvas-media-config-control">
        <span>默认模型</span>
        <select aria-label={modelLabel} aria-invalid={!preparing && (unavailableModel || Boolean(error))} value={selectedModel} disabled={busy || unavailable || models.length === 0} onChange={(event) => onSelectModel(kind, event.target.value)}>
          {!model && <option value="" disabled>{models.length === 0 ? '暂无可用模型' : '请选择默认模型'}</option>}
          {unavailableModel && <option value={model!} disabled>{model} · {preparing ? '核对中' : '当前不可用'}</option>}
          {models.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
      </label>
      {unavailable && <small role="alert">当前分组已不可用，请重新选择后再生成。</small>}
      {error && <small role="alert">{error}；原配置保留，此用途暂不能生成。</small>}
      {!preparing && !error && unavailableModel && <small role="alert">原默认模型已不在来源列表中，已保留原选择；请明确选择可用模型后再生成。</small>}
      {declaredPurpose && <small>用途由你配置；模型列表可读取，不代表生成接口兼容性已验证{kind === 'video' ? '。视频模式、清晰度和音频选项会按所选来源协议与模型核对；请在账号设置中确认来源使用的接口' : ''}。</small>}
      <small className={preparing || models.length ? 'canvas-media-config-models' : 'canvas-media-config-models is-empty'}>
        {preparing ? '正在读取此用途的模型列表，原配置保留；等待时可更换来源' : models.length ? `后续${kind === 'image' ? '图像' : kind === 'video' ? '视频' : '文字'}节点优先使用所选默认模型` : emptyHint}
      </small>
    </div>
  )
}

interface PreparedMediaConfiguration extends CanvasPreparedMediaConfiguration {
  scope: CanvasMediaPreparationScope
  kind: MediaPreparationKind
}

interface RunResultCollectionSession {
  scope: { accountId: string; projectId: string }
  runtimeScope: string
  initialRunId?: string
}

function CanvasWorkspace({
  initialTheme = 'dark',
  accountChangeNotice,
  siteId,
  draftOwnerId,
  creationOwnerId,
  draftActionsEnabled = true,
  storageMode = 'local',
  slots,
}: {
  initialTheme?: CanvasTheme
  accountChangeNotice?: string | null
  siteId: 'solov' | 'solov-api'
  draftOwnerId?: number
  creationOwnerId?: string
  draftActionsEnabled?: boolean
  storageMode?: 'local' | 'cloud'
  slots: CanvasKernelSlots
}) {
  // 云端界面由网页外壳经插槽传入（#3）；桌面和嵌入宿主不传，这些界面和打开它们的入口都不渲染。
  const { CanvasAgentPanel, ProjectCollaborationPanel, CanvasWorkshopLibraryDialog, SaveCanvasWorkshopDialog, WorkshopAssetPickerDialog, WorkshopModelMappingDialog, WorkshopSetupPanel, WorkshopContentRecoveryNotice, WorkshopCreationRecoveryNotice, VideoTaskRecovery } = slots
  // 宿主少了的方法、没开的能力，对应的入口不给（#4，见 host-entry-points.ts）。
  const hostEntryPoints = canvasHostEntryPoints(hostBridge(), canvasCapabilities())
  const [projectAccessState, setProjectAccessState] = useState(() => window.xingmangCanvasHost?.getProjectAccess?.() ?? null)
  const [activeProject, setActiveProject] = useState<CanvasStoredProjectSummary | null>(null)
  const projectEpochRef = useRef(0)
  const collaborationRef = useRef<CanvasProjectCollaboration | null>(null)
  const collaborationScopeKey = JSON.stringify([creationOwnerId, activeProject?.id, projectEpochRef.current, projectAccessState?.access?.accessVersion, Boolean(projectAccessState?.denied), draftActionsEnabled])
  const [collaborationUi, setCollaborationUi] = useState<{ key: string; state: CanvasCollaborationState } | null>(null)
  const collaborationStored = useMemo(() => {
    if (storageMode !== 'cloud' || !creationOwnerId || !activeProject) return false
    try { return hasProjectCollaborationJournal(window.localStorage, creationOwnerId, activeProject.id) } catch { return true }
  }, [storageMode, creationOwnerId, activeProject?.id, projectAccessState?.access?.accessVersion])
  const collaborationShared = Boolean(projectAccessState?.access?.teamId && projectAccessState.access.accessVersion >= 1)
  const collaborationRequired = storageMode === 'cloud' && Boolean(activeProject) && (collaborationShared || collaborationStored)
  const collaborationState = collaborationUi?.key === collaborationScopeKey ? collaborationUi.state : null
  const collaborationBlocked = collaborationRequired && (!collaborationState || !['live', 'available'].includes(collaborationState.phase) && !(collaborationState.phase === 'busy' && collaborationState.buffering))
  const projectPermissionCanEdit = draftActionsEnabled && !projectAccessState?.denied && projectAccessState?.access?.canEdit !== false
  const projectCanEdit = projectPermissionCanEdit && !collaborationBlocked
  const projectCanRun = projectCanEdit && projectAccessState?.access?.canRun !== false && collaborationState?.phase !== 'busy'
  const projectCanRestore = projectCanEdit && projectAccessState?.access?.canRestore !== false && !collaborationRef.current?.needsOperationSave()
  const projectCanEditRef = useRef(projectCanEdit)
  projectCanEditRef.current = projectCanEdit
  const projectCanRunRef = useRef(projectCanRun)
  projectCanRunRef.current = projectCanRun
  useEffect(() => {
    const host = window.xingmangCanvasHost
    setProjectAccessState(host?.getProjectAccess?.() ?? null)
    return host?.onProjectAccessChange?.(setProjectAccessState)
  }, [])
  const agentEditorApproval = useRef(createCanvasAgentEditorApproval())
  const [agentAutomationRevision, setAgentAutomationRevision] = useState(0)
  const getAgentAutomationRevision = useCallback(() => agentEditorApproval.current.revision(), [])
  const documentController = useCanvasDocument(editorNodeToCanvasNode, {
    canEdit: () => projectCanEditRef.current && (collaborationRef.current?.canEdit() ?? true),
    onMutation: () => setAgentAutomationRevision(agentEditorApproval.current.changed()),
  })
  const {
    nodes,
    edges,
    viewport,
    mediaGroups,
    setNodes,
    setEdges,
    setViewport: setDocumentViewport,
    execute,
    undo: undoDocument,
    redo: redoDocument,
    isInsertionViewportCurrent,
    cancelInsertionViewportNavigation: cancelDocumentInsertionViewportNavigation,
    getGraphSnapshot,
    onNodesChange,
    onEdgesChange,
    canUndo: documentCanUndo,
    canRedo: documentCanRedo,
  } = documentController
  const canUndo = projectCanEdit && (collaborationRef.current?.needsOperationSave() ? collaborationState?.phase === 'live' && Boolean(collaborationState.snapshot?.history.undo) : documentCanUndo)
  const canRedo = projectCanEdit && (collaborationRef.current?.needsOperationSave() ? collaborationState?.phase === 'live' && Boolean(collaborationState.snapshot?.history.redo) : documentCanRedo)
  const mediaGroupsRef = useRef(mediaGroups)
  mediaGroupsRef.current = mediaGroups
  const [running, setRunning] = useState(false)
  const [startingRuns, setStartingRuns] = useState(0)
  const startingRunsRef = useRef(0)
  const projectTransitionRef = useRef(false)
  const [projectTransition, setProjectTransition] = useState(false)
  const [projectImportPreview, setProjectImportPreview] = useState<ProjectImportPreview | null>(null)
  const [projectImportBusy, setProjectImportBusy] = useState(false)
  const [projectImportError, setProjectImportError] = useState<string | null>(null)
  const [projectImportBlocked, setProjectImportBlocked] = useState(false)
  const [projectImportRecoveryEpoch, setProjectImportRecoveryEpoch] = useState<number | null>(null)
  const [projectImportProgress, setProjectImportProgress] = useState<ProjectImportProgress | undefined>()
  const projectImportGuard = useRef(createProjectImportGuard())
  const pendingProjectImportRef = useRef<{ preview: ProjectImportPreview; projectEpoch: number } | null>(null)
  const projectImportInterruptedRef = useRef(false)
  useEffect(() => {
    projectImportGuard.current.activate()
    if (projectImportInterruptedRef.current) {
      projectImportInterruptedRef.current = false
      setProjectImportPreview(null)
      setProjectImportBusy(false)
      setProjectImportError(null)
      setProjectImportBlocked(false)
      setProjectImportProgress(undefined)
      projectTransitionRef.current = false
      setProjectTransition(false)
      setBanner('导入界面已重新加载，请重新选择文件；已提交的素材与工程请到素材库或项目中心核对，不会自动回滚。')
    }
    return () => {
      projectImportInterruptedRef.current = projectImportGuard.current.busy() || pendingProjectImportRef.current !== null
      projectImportGuard.current.dispose()
      pendingProjectImportRef.current = null
    }
  }, [])
  const [theme, setTheme] = useState<CanvasTheme>(initialTheme)
  const appearanceRef = useRef({ ...initialCanvasAppearance(window.location.search), theme: initialTheme })
  const [closePhase, setClosePhase] = useState<CanvasClosePhase | null>(null)
  const closeBusyRef = useRef(false)
  const closeRequestRef = useRef<string | null>(null)
  const closeChoiceRef = useRef<((choice: CanvasCloseChoice) => void) | null>(null)
  const closeGuardRef = useRef<ReturnType<typeof createCanvasCloseGuard> | null>(null)
  const projectCenterDraftRef = useRef(false)
  const rememberProjectCenterDraft = useCallback((dirty: boolean) => { projectCenterDraftRef.current = dirty }, [])
  const autosaveTimerRef = useRef<number | null>(null)
  const [projects, setProjects] = useState<CanvasStoredProjectSummary[]>([])
  const blankCreationRef = useRef<ReturnType<typeof createBlankProjectCreation> | null>(null)
  const [blankCreation, setBlankCreation] = useState<BlankProjectCreationState>({ phase: 'idle', pending: null, confirmedProject: null, error: null, busy: false })
  const [blankCreationReady, setBlankCreationReady] = useState(storageMode !== 'cloud')
  const [blankProjectName, setBlankProjectName] = useState('')
  const [blankDraftError, setBlankDraftError] = useState<string | null>(null)
  const blankOpenRef = useRef<(projectId: string) => Promise<boolean>>(async () => false)
  const [projectPage, setProjectPage] = useState<CanvasProjectPage | null>(null)
  const [projectQuery, setProjectQuery] = useState<CanvasProjectListQuery>({ ...defaultCanvasProjectQuery })
  const projectQueryRef = useRef<CanvasProjectListQuery>({ ...defaultCanvasProjectQuery })
  const projectPaginationEnabled = typeof window.xingmangCanvasHost?.listProjectPage === 'function'
  const [projectLoading, setProjectLoading] = useState(Boolean(window.xingmangCanvasHost))
  const [projectError, setProjectError] = useState<string | null>(null)
  const initialRouteConsumedRef = useRef(false)
  const templateProjectSubmissionRef = useRef(createTemplateProjectSubmission())
  const templateCreatedProjectRef = useRef<{ projectId: string; templateId: string } | null>(null)
  const [savedTemplateRecovery, setSavedTemplateRecovery] = useState<SavedTemplateProjectSubmission | null>(null)
  const [templateRecoveryError, setTemplateRecoveryError] = useState<string | null>(null)
  const [templateRecoveryBusy, setTemplateRecoveryBusy] = useState(false)
  const templateRecoveryBusyRef = useRef(false)
  const projectRequestRevisionRef = useRef(0)
  const renameScopeRef = useRef(0)
  useEffect(() => () => { renameScopeRef.current += 1 }, [])
  const [agentOpen, setAgentOpen] = useState(false)
  const [agentContextRequest, setAgentContextRequest] = useState<CanvasAgentContextRequest | null>(null)
  const agentContextSequence = useRef(0)
  const agentMountedRef = useRef(true)
  useEffect(() => { agentMountedRef.current = true; return () => { agentMountedRef.current = false } }, [])
  const [historyScope, setHistoryScope] = useState<{ projectId: string; projectEpoch: number; dialogEpoch: number } | null>(null)
  const historyDialogEpochRef = useRef(0)
  const historyBusyRef = useRef(false)
  const [historyBusy, setHistoryBusy] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyPendingState, setHistoryPendingState] = useState<'unknown' | 'missing' | 'completed' | 'changed' | undefined>()
  const historyPendingRef = useRef<{ projectId: string; epoch: number; input: CanvasProjectRestoreInput; record?: ProjectHistoryRecoveryRecord } | null>(null)
  const historyMissingRef = useRef<typeof historyPendingRef.current>(null)
  const historyRecoveryErrorRef = useRef<string | null>(null)
  const historyRecoveryOwnerRef = useRef(creationOwnerId)
  historyRecoveryOwnerRef.current = creationOwnerId
  const [uiPreferences, setUiPreferences] = useState<CanvasUiPreferences>(() => ({ ...defaultCanvasUiPreferences }))
  const [autoSaveState, setAutoSaveState] = useState<'idle' | 'pending' | 'saving' | 'saved' | 'failed'>('idle')
  const autoSaveRevisionRef = useRef(0)
  const lastAutosaveSignatureRef = useRef<string | null>(null)
  const lastAutosaveGraphSignatureRef = useRef<string | null>(null)
  const projectHydrationRef = useRef(false)
  const projectSaveChainRef = useRef<Promise<void>>(Promise.resolve())
  const draftWriterIdRef = useRef<string>(crypto.randomUUID())
  const draftRevisionSequenceRef = useRef(0)
  const browserDraftRef = useRef<CanvasBrowserDraft | null>(null)
  const restoredDraftRef = useRef<CanvasBrowserDraft | null>(null)
  const draftBaseVersionRef = useRef(0)
  const lastConfirmedContentRef = useRef<string | null>(null)
  const activeProjectIdRef = useRef<string | null>(null)
  const browserUnsavedRef = useRef(false)
  const draftRecoveryPendingRef = useRef(false)
  const saveConflictRef = useRef(false)
  const [draftRecovery, setDraftRecovery] = useState<CanvasBrowserDraft[] | null>(null)
  const [selectedDraft, setSelectedDraft] = useState<CanvasBrowserDraftSelection | null>(null)
  const [draftDialogMode, setDraftDialogMode] = useState<'recovery' | 'manage'>('recovery')
  const [draftDialogScope, setDraftDialogScope] = useState<CanvasDraftActionScope | null>(null)
  const [draftConfirmation, setDraftConfirmation] = useState<CanvasDraftConfirmation | null>(null)
  const draftConfirmationRef = useRef<CanvasDraftConfirmation | null>(null)
  draftConfirmationRef.current = draftConfirmation
  const [draftDialogNotice, setDraftDialogNotice] = useState<string | null>(null)
  const [draftDialogError, setDraftDialogError] = useState<string | null>(null)
  const [draftListAvailable, setDraftListAvailable] = useState(true)
  const [draftLocalActionBusy, setDraftLocalActionBusy] = useState(false)
  const draftDialogEpochRef = useRef(0)
  const draftReturnFocusRef = useRef<HTMLElement | null>(null)
  const draftActionsEnabledRef = useRef(draftActionsEnabled)
  draftActionsEnabledRef.current = draftActionsEnabled
  const layerEditorOwnerRef = useRef({ ownerId: draftOwnerId ?? null, accountId: creationOwnerId ?? null })
  layerEditorOwnerRef.current = { ownerId: draftOwnerId ?? null, accountId: creationOwnerId ?? null }
  const layerEditorScope = layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabled })
  const [commerceSession, setCommerceSession] = useState<{ scope: string; task: CommerceTask; references: CommerceTaskReferenceDraft[]; nodeId?: string; signature?: string } | null>(null)
  const commerceSessionRef = useRef(commerceSession)
  commerceSessionRef.current = commerceSession
  const commerceOpenRevisionRef = useRef(0)
  const [interiorSession, setInteriorSession] = useState<{ scope: string; task: InteriorTask; source: InteriorTaskSourceDraft; group?: string; models: string[]; nodeId?: string; signature?: string } | null>(null)
  const interiorSessionRef = useRef(interiorSession)
  interiorSessionRef.current = interiorSession
  const interiorOpenRevisionRef = useRef(0)
  const [exteriorSession, setExteriorSession] = useState<{ scope: string; task: ExteriorTask; references: ExteriorTaskReferenceDraft[]; imageSource: string; textSource: string; analysis?: { model: string }; nodeId?: string; signature?: string } | null>(null)
  const exteriorSessionRef = useRef(exteriorSession)
  exteriorSessionRef.current = exteriorSession
  const exteriorOpenRevisionRef = useRef(0)
  const [storyboardSession, setStoryboardSession] = useState<{ scope: string; task: StoryboardTask; references: StoryboardTaskReferenceDraft[]; imageSource: string; textSource: string; analysis?: { model: string }; nodeId?: string; signature?: string } | null>(null)
  const storyboardSessionRef = useRef(storyboardSession)
  storyboardSessionRef.current = storyboardSession
  const storyboardOpenRevisionRef = useRef(0)
  const commerceCompareBusyRef = useRef(false)
  const [commerceDimensions, setCommerceDimensions] = useState<{ scope: string; values: Record<string, { width: number; height: number }> }>({ scope: '', values: {} })
  const draftLocalActionGuard = useRef(createCanvasDraftActionGuard())
  const draftLocalActionInterruptedRef = useRef(false)
  const [draftStorageError, setDraftStorageError] = useState<string | null>(null)
  const [saveConflict, setSaveConflict] = useState<string | null>(null)
  const [draftActionBusy, setDraftActionBusy] = useState(false)
  const [banner, setBanner] = useState<string | null>(accountChangeNotice ?? null)
  useEffect(() => {
    if (banner !== '产物已保存') return
    const timer = window.setTimeout(() => setBanner((current) => current === banner ? null : current), 4000)
    return () => window.clearTimeout(timer)
  }, [banner])
  function currentDraftActionScope(): CanvasDraftActionScope {
    return { ownerId: draftOwnerId ?? null, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, dialogEpoch: draftDialogEpochRef.current }
  }
  useEffect(() => {
    draftLocalActionGuard.current.activate()
    if (draftLocalActionInterruptedRef.current) {
      draftLocalActionInterruptedRef.current = false
      setDraftLocalActionBusy(false)
      setDraftConfirmation(null)
    }
    return () => {
      draftLocalActionInterruptedRef.current = draftLocalActionGuard.current.busy()
      draftLocalActionGuard.current.dispose()
    }
  }, [])
  const currentDraftProjectEpoch = projectEpochRef.current
  const agentScope = useMemo(() => {
    const projectId = activeProject?.id, epoch = currentDraftProjectEpoch
    if (!projectId || !creationOwnerId || !window.xingmangCanvasHost?.agent || !CanvasAgentPanel) return null
    return { key: `${creationOwnerId}:${projectId}:${epoch}`, ownerId: creationOwnerId, projectId,
      active: () => agentMountedRef.current && draftActionsEnabledRef.current && activeProjectIdRef.current === projectId && projectEpochRef.current === epoch }
  }, [activeProject?.id, creationOwnerId, currentDraftProjectEpoch, CanvasAgentPanel])
  const agentClient = useMemo<CanvasAgentClient>(() => {
    const bridge = window.xingmangCanvasHost
    return { active: () => Boolean(agentScope?.active() && bridge === window.xingmangCanvasHost),
      async request(method, input, signal) {
        if (!agentScope?.active() || !bridge?.agent || bridge !== window.xingmangCanvasHost || (!isCanvasAgentSkillMethod(method) && (!('projectId' in input) || input.projectId !== agentScope.projectId))) throw new Error('工程或账号已切换，请重新打开 Agent')
        const result = await bridge.agent(method, input, signal)
        if (!agentScope.active() || bridge !== window.xingmangCanvasHost) throw new Error('工程或账号已切换，请返回原会话核对')
        return result
      } }
  }, [agentScope])
  const mcpClient = useMemo<CanvasMcpClient>(() => {
    const bridge = window.xingmangCanvasHost
    return { active: () => Boolean(agentScope?.active() && bridge?.mcp && bridge === window.xingmangCanvasHost),
      async request(method, input, signal) {
        if (!agentScope?.active() || !bridge?.mcp || bridge !== window.xingmangCanvasHost) throw new Error('账号或工程已切换，请重新打开 MCP')
        const result = await bridge.mcp(method, input, signal)
        if (!agentScope.active() || bridge !== window.xingmangCanvasHost) throw new Error('账号或工程已切换，请返回原账号核对 MCP 原操作')
        return result
      } }
  }, [agentScope])
  useEffect(() => {
    const pendingScope = draftLocalActionGuard.current.scope()
    const scope = currentDraftActionScope()
    if (draftActionsEnabled && (!draftDialogScope || isSameCanvasDraftActionScope(draftDialogScope, scope)) && (!pendingScope || isSameCanvasDraftActionScope(pendingScope, scope))) return
    draftLocalActionGuard.current.invalidate()
    draftDialogEpochRef.current += 1
    draftRecoveryPendingRef.current = false
    setDraftRecovery(null)
    setDraftDialogScope(null)
    setSelectedDraft(null)
    setDraftConfirmation(null)
    setDraftLocalActionBusy(false)
  }, [draftActionsEnabled, draftOwnerId, activeProject?.id, currentDraftProjectEpoch, draftDialogScope])
  const [projectExportOpen, setProjectExportOpen] = useState(false)
  const [projectExportPreview, setProjectExportPreview] = useState<ProjectExportPreview | null>(null)
  const [projectExportPreparing, setProjectExportPreparing] = useState(false)
  const [projectExportBusy, setProjectExportBusy] = useState(false)
  const [projectExportError, setProjectExportError] = useState<string | null>(null)
  const [projectExportBlocked, setProjectExportBlocked] = useState(false)
  const [projectExportProgress, setProjectExportProgress] = useState<ProjectExportProgress | undefined>()
  const [projectExportAllowExternal, setProjectExportAllowExternal] = useState(false)
  const projectExportGuard = useRef(createProjectExportGuard())
  const pendingProjectExportRef = useRef<{
    token: ProjectExportToken
    cancel(previewId?: string): void
    exportPackage(previewId: string, options: { allowExternalReferences: boolean }, onProgress?: (progress: ProjectExportProgress) => void): Promise<ProjectExportResult>
    preview?: ProjectExportPreview
    exporting: boolean
  } | null>(null)
  useEffect(() => {
    projectExportGuard.current.activate()
    function pageHide() { cancelProjectExport() }
    window.addEventListener('pagehide', pageHide)
    return () => {
      const pending = pendingProjectExportRef.current
      pendingProjectExportRef.current = null
      projectExportGuard.current.dispose()
      pending?.cancel(pending.preview?.previewId)
      window.removeEventListener('pagehide', pageHide)
    }
  }, [])
  const currentProjectExportEpoch = projectEpochRef.current
  useEffect(() => {
    const pending = pendingProjectExportRef.current
    if (pending && (accountChangeNotice || !projectExportGuard.current.current(pending.token, { projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current }))) cancelProjectExport()
  }, [accountChangeNotice, activeProject?.id, currentProjectExportEpoch])
  const [groups, setGroups] = useState<CanvasGroupSummary[]>([])
  const [groupsLoaded, setGroupsLoaded] = useState(false)
  const [refreshingGroups, setRefreshingGroups] = useState(false)
  const [groupsError, setGroupsError] = useState<string | null>(null)
  const [imageModels, setImageModels] = useState<string[]>([])
  const [videoModels, setVideoModels] = useState<string[]>([])
  const [textModels, setTextModels] = useState<string[]>([])
  const [nodeSourceSnapshot, setNodeSourceSnapshot] = useState<{ key: string; catalog: CanvasNodeSourceCatalog }>({ key: '', catalog: {} })
  const [mediaConfigOpen, setMediaConfigOpen] = useState(false)
  const [preparingMedia, setPreparingMedia] = useState<MediaPreparationKind | null>(null)
  const [pendingMediaKinds, setPendingMediaKinds] = useState<MediaCapabilityKind[]>([])
  const pendingMediaKindsRef = useRef<MediaCapabilityKind[]>([])
  const settledMediaSignaturesRef = useRef<Partial<Record<MediaCapabilityKind, string>>>({})
  const [mediaPreparationBlocked, setMediaPreparationBlocked] = useState<string | null>(null)
  const mediaPreparationBlockedRef = useRef<string | null>(null)
  const [mediaPreparationErrors, setMediaPreparationErrors] = useState<CanvasMediaPreparationErrors>({})
  const [catalogReadRevision, setCatalogReadRevision] = useState(0)
  const [mediaRetryRevision, setMediaRetryRevision] = useState(0)
  const [assetTrayOpen, setAssetTrayOpen] = useState(false)
  const [assetsLoading, setAssetsLoading] = useState(false)
  const [assetPage, setAssetPage] = useState<CanvasAssetPage>(emptyCanvasAssetPage())
  const [assetCatalog, setAssetCatalog] = useState<CanvasAssetSummary[]>([])
  const imageAssetDimensions = useMemo(() => ({ ...(commerceDimensions.scope === layerEditorScope ? commerceDimensions.values : {}), ...Object.fromEntries(assetCatalog.flatMap((asset) => asset.mediaType === 'image' && !asset.deletedAt && Number.isSafeInteger(asset.width) && Number.isSafeInteger(asset.height) && asset.width! > 0 && asset.height! > 0 ? [[asset.assetId, { width: asset.width!, height: asset.height! }]] : [])) }), [assetCatalog, commerceDimensions, layerEditorScope])
  const { catalog: promptCatalog, snapshot: promptCatalogSnapshot } = useWorkspacePromptCatalog(() => hostBridge().listPromptPresets(), draftActionsEnabled)
  const userPromptPresets = promptCatalogSnapshot.items
  const [assetQuery, setAssetQuery] = useState<Required<Pick<CanvasAssetQuery, 'offset' | 'limit' | 'mediaType' | 'view' | 'source' | 'sort'>> & Pick<CanvasAssetQuery, 'search' | 'tag' | 'categoryId'>>({
    offset: 0, limit: 24, mediaType: 'all', search: '', view: 'all', source: 'all', sort: 'created-desc', tag: '',
  })
  const assetQueryRef = useRef<CanvasAssetQuery>(assetQuery)
  assetQueryRef.current = assetQuery
  const assetsRequestRevisionRef = useRef(0)
  const assetQueryGenerationRef = useRef(0)
  const assetMutationPendingRef = useRef<{ scope: string; token: object; controller?: AbortController } | null>(null)
  const assetCategoryOwnerScope = JSON.stringify([layerEditorOwnerRef.current.ownerId, layerEditorOwnerRef.current.accountId])
  const [assetCategoryState, setAssetCategoryState] = useState<{ scope: string; directory: AssetCategoryDirectory | null; loading: boolean; error: string }>({ scope: assetCategoryOwnerScope, directory: null, loading: false, error: '' })
  const assetCategoryStateRef = useRef(assetCategoryState)
  assetCategoryStateRef.current = assetCategoryState
  const assetCategoryReadRef = useRef<{ revision: number; controller: AbortController | null }>({ revision: 0, controller: null })
  const [assetCategorySelectionRevision, setAssetCategorySelectionRevision] = useState(0)
  const [assetCategoryDialog, setAssetCategoryDialog] = useState<{ scope: string; kind: 'manage' | 'move'; assets?: AssetCategoryMoveAsset[] } | null>(null)
  const assetCategorySupported = !!hostBridge().listAssetCategories && !!hostBridge().manageAssetCategories && !!hostBridge().inspectAssetCategoryOperation
  const assetCategoryRecovery = useAssetCategoryRecovery({
    ownerId: creationOwnerId ?? null, active: assetCategorySupported && draftActionsEnabled,
    apply: (input, signal) => submitAssetCategoryOperation(input, signal), inspect: (input, signal) => inspectAssetCategoryOperation(input, signal),
  })
  const assetMutationSupported = !!hostBridge().manageAssetMutations && !!hostBridge().inspectAssetMutationOperation
  // 桌面主进程还没有可恢复整理的那两个方法（#1393）。换内核前旧画布的收藏、改名、标签、回收都能用，yoyo 10-28 定「素材B」：
  // 桌面上缺这两个方法时照旧画布直接调原来的方法，整理不能撤销，回收站的「撤销」照旧。网页和嵌入宿主不退回去。
  const directAssetMutations = !assetMutationSupported && canvasCapabilities().host === 'desktop'
  const assetMutationRecovery = useAssetMutationRecovery({
    ownerId: creationOwnerId ?? null, active: assetMutationSupported && draftActionsEnabled,
    apply: async (input, signal) => {
      const method = hostBridge().manageAssetMutations
      if (!method || !draftActionsEnabledRef.current) throw new Error('当前宿主不支持可恢复素材整理，请更新应用后重试')
      return method(input, signal)
    },
    inspect: async (input, signal) => {
      const method = hostBridge().inspectAssetMutationOperation
      if (!method || !draftActionsEnabledRef.current) throw new Error('当前宿主不支持原素材操作核对，请更新应用后重试')
      return method(input, signal)
    },
  })
  useEffect(() => () => { assetMutationPendingRef.current?.controller?.abort(); assetMutationPendingRef.current = null }, [layerEditorScope])
  const [inspectorTab, setInspectorTab] = useState<CanvasInspectorTab>('node')
  const [nodeInspectorOpen, setNodeInspectorOpen] = useState(false)
  const [runPreflight, setRunPreflight] = useState<CanvasRunPreflight | null>(null)
  const [dramaParseConfirm, setDramaParseConfirm] = useState<{ nodeId: string; tables: DramaParseTables } | null>(null)
  const [pendingCanvasRun, setPendingCanvasRun] = useState<{ graph: CanvasRunGraph; scope: CanvasRunScope; outputPlacement?: { nodeId: string; editorScope: string }; agentExecution?: { origin: CanvasAgentExecutionOrigin; scopeKey: string; label: string } } | null>(null)
  const [agentExecutionRefreshKey, setAgentExecutionRefreshKey] = useState(0)
  const [outputPendingNodeIds, setOutputPendingNodeIds] = useState<ReadonlySet<string>>(() => new Set())
  const outputPlacementAdapterRef = useRef<Parameters<typeof createOutputImagePlacementCoordinator>[0] | null>(null)
  const outputPlacementCoordinator = useMemo(() => createOutputImagePlacementCoordinator({
    scope: () => outputPlacementAdapterRef.current?.scope() ?? null,
    graph: () => outputPlacementAdapterRef.current!.graph(),
    outputIds: (id, selection) => outputPlacementAdapterRef.current!.outputIds(id, selection),
    read: (id, signal) => outputPlacementAdapterRef.current!.read(id, signal),
    commit: (id, assets) => outputPlacementAdapterRef.current!.commit(id, assets),
    busy: setOutputPendingNodeIds,
    notice: (message) => outputPlacementAdapterRef.current?.notice(message),
  }), [])
  useEffect(() => { outputPlacementCoordinator.invalidate(); return () => outputPlacementCoordinator.invalidate() }, [layerEditorScope, outputPlacementCoordinator])
  const [runInspectorOpen, setRunInspectorOpen] = useState(false)
  const [resumingTaskIds, setResumingTaskIds] = useState<Set<string>>(() => new Set())
  const [runsLoading, setRunsLoading] = useState(false)
  const [runsError, setRunsError] = useState<string | null>(null)
  const runsRequestRevisionRef = useRef(0)
  const [runRecoveryRevision, setRunRecoveryRevision] = useState(0)
  const pendingRunProjectionIdsRef = useRef(new Set<string>())
  const [runRecords, setRunRecords] = useState<CanvasRunRecord[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [runResultCollectionSession, setRunResultCollectionSession] = useState<RunResultCollectionSession | null>(null)
  const runResultCollectionSessionRef = useRef<RunResultCollectionSession | null>(null)
  useEffect(() => {
    if (!projectCanRun || runResultCollectionSessionRef.current?.runtimeScope !== layerEditorScope) {
      runResultCollectionSessionRef.current = null
      setRunResultCollectionSession(null)
    }
  }, [layerEditorScope, projectCanRun])
  const [runScopeKind, setRunScopeKind] = useState<CanvasRunScope['kind']>('all')
  const [dirtyNodeIds, setDirtyNodeIds] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    const next = dirtyCanvasNodeIds(nodes)
    setDirtyNodeIds((current) => current.size === next.size && [...next].every((id) => current.has(id)) ? current : next)
  }, [nodes])
  const [previewAsset, setPreviewAsset] = useState<AssetRef | null>(null)
  const [moreActionsOpen, setMoreActionsOpen] = useState(false)
  const [runMenuOpen, setRunMenuOpen] = useState(false)
  const [minimapOpen, setMinimapOpen] = useState(uiPreferences.minimapOpen)
  const [focusMode, setFocusMode] = useState(uiPreferences.focusMode)
  const agentMediaCatalog = useCanvasAgentMediaCatalog({
    scopeKey: agentScope?.key ?? null, enabled: Boolean(agentOpen && !focusMode && projectCanRun && draftActionsEnabled), groups,
    active: () => Boolean(agentScope?.active()), prepare: (group) => hostBridge().prepareGroup(group),
  })
  const [nodeLod, setNodeLod] = useState<CanvasNodeLod>(() => canvasNodeLodForZoom(viewport.zoom))
  const [quickInsert, setQuickInsert] = useState<{
    anchor: { x: number; y: number }
    flowPosition: XYPosition
    connection?: PendingCanvasConnection
    edgeId?: string
    compatibleHandles?: Readonly<Record<string, string>>
    batchSourceIds?: string[]
    scope?: string
  } | null>(null)
  const [templateCatalog, setTemplateCatalog] = useState<{ initialTemplateId?: string } | null>(null)
  const [workshopCatalog, setWorkshopCatalog] = useState<{ initialItemId?: string; initialPromptId?: string; initialBuiltinPromptId?: string } | null>(null)
  const [workshopSelection, setWorkshopSelection] = useState<{ workflow: WorkflowFile; scopeKey: string; targetId?: string } | null>(null)
  const [workshopEditTarget, setWorkshopEditTarget] = useState<{ id: string; projectId: string | null } | null>(() => {
    const route = new URLSearchParams(window.location.search), projectId = route.get('project'), id = readWorkshopEditTarget(route, projectId)
    return id ? { id, projectId } : null
  })
  const [workshopSetupSession, setWorkshopSetupSession] = useState<{ scopeKey: string; scope: WorkshopSetupScope; insertedNodeIds?: readonly string[] } | null>(null)
  const workshopSetupSessionRef = useRef<typeof workshopSetupSession>(null)
  const [workshopSetupOpen, setWorkshopSetupOpen] = useState(false)
  const [workshopSetupAssets, setWorkshopSetupAssets] = useState<Record<string, WorkshopSetupAssetState>>({})
  const [workshopSetupBusy, setWorkshopSetupBusy] = useState(false), [workshopSetupError, setWorkshopSetupError] = useState<string | undefined>()
  const workshopSetupAssetCheckRef = useRef<AbortController | null>(null)
  const workshopSetupActionRevisionRef = useRef(0)
  const workshopSetupActionBusyRef = useRef(false)
  const [workshopAssetPicker, setWorkshopAssetPicker] = useState<{ scopeKey: string; nodeId: string; title: string; mediaType: CanvasAssetSummary['mediaType']; current(): boolean } | null>(null)
  const workshopAssetPickerRef = useRef(workshopAssetPicker)
  workshopAssetPickerRef.current = workshopAssetPicker
  const [workshopModelMappingSession, setWorkshopModelMappingSession] = useState<{ token: number; scopeKey: string; setupSession: NonNullable<typeof workshopSetupSession>; nodeIds: string[]; graphSignature: string; sourceSignature: string; groups: CanvasGroupSummary[] } | null>(null)
  const workshopModelMappingSessionRef = useRef(workshopModelMappingSession)
  workshopModelMappingSessionRef.current = workshopModelMappingSession
  const workshopModelMappingRevisionRef = useRef(0)
  const [workshopModelMappingCatalog, setWorkshopModelMappingCatalog] = useState<CanvasNodeSourceCatalog>({})
  const workshopModelMappingCatalogRef = useRef<CanvasNodeSourceCatalog>({})
  const [workshopModelMappingChoices, setWorkshopModelMappingChoices] = useState<WorkshopModelMappingChoice[]>([])
  const workshopModelMappingChoicesRef = useRef(workshopModelMappingChoices)
  workshopModelMappingChoicesRef.current = workshopModelMappingChoices
  const [workshopModelMappingReview, setWorkshopModelMappingReview] = useState<{ choicesSignature: string; issues: WorkshopModelMappingIssue[] } | null>(null)
  const workshopModelMappingReviewRef = useRef(workshopModelMappingReview)
  workshopModelMappingReviewRef.current = workshopModelMappingReview
  const [workshopModelMappingBusy, setWorkshopModelMappingBusy] = useState(false)
  const workshopModelMappingBusyRef = useRef(false)
  const [workshopModelMappingError, setWorkshopModelMappingError] = useState<string | undefined>()
  const currentWorkshopSetupScope = useCallback(() => layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current }), [])
  useEffect(() => { if (workshopSelection && workshopSelection.scopeKey !== layerEditorScope) setWorkshopSelection(null) }, [workshopSelection, layerEditorScope])
  const openWorkshopSetup = useCallback((requested?: WorkshopSetupScope) => {
    if (!agentMountedRef.current || !draftActionsEnabledRef.current || projectTransitionRef.current || draftRecoveryPendingRef.current) return
    const scopeKey = currentWorkshopSetupScope(), previous = workshopSetupSessionRef.current
    const current = previous?.scopeKey === scopeKey ? previous : null
    const scope = requested ?? current?.scope ?? { kind: 'all' }
    const session = { scopeKey, scope, ...(scope.kind === 'inserted' ? { insertedNodeIds: [...scope.nodeIds] } : current?.insertedNodeIds ? { insertedNodeIds: current.insertedNodeIds } : {}) }
    workshopSetupAssetCheckRef.current?.abort(); workshopSetupAssetCheckRef.current = null
    workshopSetupActionRevisionRef.current++; workshopSetupActionBusyRef.current = false
    workshopSetupSessionRef.current = session; setWorkshopSetupSession(session); setWorkshopSetupOpen(true); setWorkshopSetupBusy(false); setWorkshopSetupError(undefined)
    setWorkshopSetupAssets((previous) => current ? Object.fromEntries(Object.entries(previous).filter(([, asset]) => asset.state !== 'checking')) : {})
    setMoreActionsOpen(false); setRunMenuOpen(false); setQuickInsert(null); setMediaConfigOpen(false)
  }, [currentWorkshopSetupScope])
  const openCreatedWorkshopSetup = useCallback((projectId: string, request: { ownerId: number | null; accountId: string | null; projectEpoch: number }) => {
    const owner = layerEditorOwnerRef.current
    if (owner.ownerId !== request.ownerId || owner.accountId !== request.accountId || activeProjectIdRef.current !== projectId || projectEpochRef.current !== request.projectEpoch + 1) return
    openWorkshopSetup({ kind: 'inserted', nodeIds: getGraphSnapshot().nodes.map((node) => node.id) })
  }, [getGraphSnapshot, openWorkshopSetup])
  useEffect(() => {
    if (workshopSetupSessionRef.current?.scopeKey === layerEditorScope && draftActionsEnabled) return
    workshopSetupAssetCheckRef.current?.abort(); workshopSetupAssetCheckRef.current = null
    workshopSetupActionRevisionRef.current++; workshopSetupActionBusyRef.current = false
    setWorkshopAssetPicker(null); workshopAssetPickerRef.current = null
    workshopModelMappingRevisionRef.current++; workshopModelMappingSessionRef.current = null; setWorkshopModelMappingSession(null)
    workshopModelMappingCatalogRef.current = {}; setWorkshopModelMappingCatalog({}); workshopModelMappingBusyRef.current = false; setWorkshopModelMappingBusy(false)
    workshopSetupSessionRef.current = null; setWorkshopSetupSession(null); setWorkshopSetupOpen(false); setWorkshopSetupAssets({}); setWorkshopSetupBusy(false); setWorkshopSetupError(undefined)
  }, [layerEditorScope, draftActionsEnabled])
  useEffect(() => () => { workshopSetupAssetCheckRef.current?.abort(); workshopSetupSessionRef.current = null; workshopModelMappingSessionRef.current = null }, [])
  const [renamingNode, setRenamingNode] = useState<{ id: string; name: string } | null>(null)
  const [arrangeMenuOpen, setArrangeMenuOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState<CanvasContextMenuState | null>(null)
  const [batchImageRelated, setBatchImageRelated] = useState<{ sources: BatchImageRelatedSource[]; scope: string; preferredCenter?: XYPosition } | null>(null)
  const batchImageRelatedRef = useRef<typeof batchImageRelated>(null)
  const [batchImageRelatedError, setBatchImageRelatedError] = useState<string | undefined>()
  const [imageMaskSession, setImageMaskSession] = useState<{ nodeId: string; from: 'input' | 'output'; source: ImageMaskSource; scope: string; initial?: ImageEditMask } | null>(null)
  const imageMaskSessionRef = useRef<typeof imageMaskSession>(null)
  const imageMaskExportSavingRef = useRef(false)
  const imageMaskExportReceiptsRef = useRef(new Map<string, { status: 'unknown' } | { status: 'saved'; asset: CanvasImageAssetSummary }>())
  useEffect(() => { imageMaskSessionRef.current = null; setImageMaskSession(null); imageMaskExportReceiptsRef.current = new Map() }, [layerEditorScope])
  const [textSession, setTextSession] = useState<CanvasTextSession | null>(null)
  const [frameSession, setFrameSession] = useState<{ snapshot: FrameSelectionSnapshot; asset: CanvasVideoAssetSummary; scope: string } | null>(null)
  const frameSessionRef = useRef<typeof frameSession>(null)
  const frameLoadingRef = useRef<AbortController | null>(null)
  useEffect(() => {
    frameSessionRef.current = null; setFrameSession(null)
    frameLoadingRef.current?.abort(); frameLoadingRef.current = null
    return () => { frameLoadingRef.current?.abort(); frameSessionRef.current = null }
  }, [layerEditorScope])
  const [frameSequenceSession, setFrameSequenceSession] = useState<{ snapshot: FrameSequenceSnapshot; asset: CanvasVideoAssetSummary; scope: string } | null>(null)
  const frameSequenceSessionRef = useRef<typeof frameSequenceSession>(null)
  const frameSequenceLoadingRef = useRef<AbortController | null>(null)
  useEffect(() => {
    frameSequenceSessionRef.current = null; setFrameSequenceSession(null)
    frameSequenceLoadingRef.current?.abort(); frameSequenceLoadingRef.current = null
    return () => { frameSequenceLoadingRef.current?.abort(); frameSequenceSessionRef.current = null }
  }, [layerEditorScope, projectCanEdit])
  const textActionPendingRef = useRef(new Set<string>())
  const textActionUncertainRef = useRef(new Map<string, PromptPresetInput>())
  useEffect(() => { setTextSession(null); textActionPendingRef.current.clear(); textActionUncertainRef.current.clear() }, [layerEditorScope])
  const [annotationSession, setAnnotationSession] = useState<{ nodeId: string; asset: CanvasImageAssetSummary; scope: string } | null>(null)
  const annotationSessionRef = useRef<typeof annotationSession>(null)
  const annotationLoadingRef = useRef<AbortController | null>(null)
  const annotationSavingRef = useRef(false)
  useEffect(() => {
    annotationSessionRef.current = null; setAnnotationSession(null)
    annotationLoadingRef.current?.abort(); annotationLoadingRef.current = null
    return () => { annotationLoadingRef.current?.abort(); annotationSessionRef.current = null }
  }, [layerEditorScope])
  useEffect(() => { batchImageRelatedRef.current = null; setBatchImageRelated(null); setBatchImageRelatedError(undefined) }, [layerEditorScope])
  const [snapGuides, setSnapGuides] = useState<readonly SnapGuide[]>([])
  const [nodeSearchOpen, setNodeSearchOpen] = useState(false)
  const [edgeDropTargetId, setEdgeDropTargetId] = useState<string | null>(null)
  const [cutStroke, setCutStroke] = useState<readonly Point[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const resumingTaskIdsRef = useRef<Set<string>>(new Set())
  const activeRunsRef = useRef(new Map<string, { graphRevision: string; projectId?: string; scope?: CanvasRunScope }>())
  const runWaitingBannerRef = useRef<{ runId: string; graphRevision: string; message: string } | null>(null)
  const runInputGraphsRef = useRef(new Map<string, CanvasRunGraph>())

  const rememberActiveRun = useCallback((entry: { runId: string; graphRevision: string; projectId?: string; scope?: CanvasRunScope; graph?: CanvasRunGraph }) => {
    activeRunsRef.current.set(entry.runId, { graphRevision: entry.graphRevision, projectId: entry.projectId, scope: entry.scope })
    if (entry.graph) runInputGraphsRef.current.set(entry.runId, entry.graph)
    pendingRunProjectionIdsRef.current.add(entry.runId)
    setRunning(true)
  }, [])

  const forgetActiveRun = useCallback((runId: string) => {
    if (!activeRunsRef.current.delete(runId)) return
    setRunning(activeRunsRef.current.size > 0)
  }, [])
  const clipboardRef = useRef<{ revision: number; controller: AbortController | null; scope: string }>({ revision: 0, controller: null, scope: layerEditorScope })
  // Outlives project switches on purpose: the old desktop canvas pasted across
  // projects in one window, and an account switch remounts the whole workspace.
  const clipboardIdentityRef = useRef<{ workspaceId: string; copied: string | null }>({ workspaceId: crypto.randomUUID(), copied: null })
  // Render-time invalidation also covers account A → B → A before effects run.
  if (clipboardRef.current.scope !== layerEditorScope) {
    clipboardRef.current.controller?.abort(); clipboardRef.current.controller = null
    clipboardRef.current.scope = layerEditorScope; clipboardRef.current.revision++
  }
  useEffect(() => {
    function invalidateClipboard() { clipboardRef.current.revision++; clipboardRef.current.controller?.abort(); clipboardRef.current.controller = null }
    window.addEventListener('pagehide', invalidateClipboard)
    return () => { invalidateClipboard(); window.removeEventListener('pagehide', invalidateClipboard) }
  }, [])
  const reactFlow = useReactFlow<CanvasNode, Edge>()
  const currentReactFlowRef = useRef(reactFlow)
  currentReactFlowRef.current = reactFlow
  const viewportRestorationRef = useRef<ReturnType<typeof createViewportRestoration> | null>(null)
  if (!viewportRestorationRef.current) viewportRestorationRef.current = createViewportRestoration({
    schedule: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (handle) => window.cancelAnimationFrame(handle),
    scope: () => ({ projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current }),
    active: () => draftActionsEnabledRef.current,
    apply: async (nextViewport) => {
      const flow = currentReactFlowRef.current
      return await flow.setViewport(nextViewport, { duration: 0 }) ? flow.getViewport() : null
    },
    applied: (actualViewport) => {
      setDocumentViewport(actualViewport)
      setNodeLod((current) => canvasNodeLodForZoom(actualViewport.zoom, current))
    },
  })
  useEffect(() => () => viewportRestorationRef.current?.reset(), [])
  useEffect(() => {
    if (window.xingmangCanvasHost && !activeProject) viewportRestorationRef.current?.reset()
    if (!draftActionsEnabled) viewportRestorationRef.current?.cancel()
  }, [activeProject?.id, draftActionsEnabled])
  const viewportInitProjectEpoch = projectEpochRef.current
  const onCanvasViewportInit = useCallback(() => {
    if (projectEpochRef.current !== viewportInitProjectEpoch || activeProjectIdRef.current !== (activeProject?.id ?? null) || !draftActionsEnabledRef.current) return
    if (!window.xingmangCanvasHost || activeProjectIdRef.current) viewportRestorationRef.current?.initialized()
  }, [activeProject?.id, viewportInitProjectEpoch])
  useEffect(() => {
    // onInit is one-shot and may carry an obsolete project epoch. Readiness
    // also comes from the live pane; the pending request owns its own scope.
    if (reactFlow.viewportInitialized && draftActionsEnabled && (!window.xingmangCanvasHost || activeProject)) viewportRestorationRef.current?.initialized()
  }, [reactFlow.viewportInitialized, activeProject?.id, viewportInitProjectEpoch, draftActionsEnabled])
  const createdNodeFocusRef = useRef<ReturnType<typeof createCreatedNodeFocusCoordinator> | null>(null)
  if (!createdNodeFocusRef.current) createdNodeFocusRef.current = createCreatedNodeFocusCoordinator({
    onNavigation: () => cancelInsertionViewportNavigation(),
    schedule: (callback) => window.requestAnimationFrame(callback),
    cancel: (handle) => window.cancelAnimationFrame(handle),
    scope: () => ({ projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current }),
    readNode: (id) => {
      const node = reactFlow.getNode(id)
      return node ? { ...node, position: reactFlow.getInternalNode(id)?.internals.positionAbsolute ?? node.position } : undefined
    },
  })
  useEffect(() => () => createdNodeFocusRef.current?.cancel(), [activeProject?.id, currentDraftProjectEpoch])
  const overviewViewportRef = useRef<Viewport | null>(null)
  const insertionViewportFrameRef = useRef<number | null>(null)
  const insertionViewportFocusRevisionRef = useRef(0)
  const altDragSessionRef = useRef<{
    nodeIds: string[]
    originalPositions: ReadonlyMap<string, XYPosition>
    preserveInputConnections: boolean
  } | null>(null)
  const moreActionsRef = useRef<HTMLDivElement>(null)
  const runMenuRef = useRef<HTMLDivElement>(null)
  const quickInsertTriggerRef = useRef<HTMLButtonElement>(null)
  const connectionStartRef = useRef<PendingCanvasConnection | null>(null)
  const moreActionsTriggerRef = useRef<HTMLButtonElement>(null)
  const runMenuTriggerRef = useRef<HTMLButtonElement>(null)
  const groupsRef = useRef<CanvasGroupSummary[]>([])
  const groupsLoadedRef = useRef(false)
  const mediaModelsRef = useRef({ image: imageModels, video: videoModels, text: textModels })
  mediaModelsRef.current = { image: imageModels, video: videoModels, text: textModels }
  const fixedNodeSourceNames = fixedCanvasNodeSourceNames(nodes)
  const nodeSourceKey = JSON.stringify([layerEditorScope, canvasNodeSourceSignature(fixedNodeSourceNames, groups, catalogReadRevision), mediaRetryRevision])
  const nodeSourceScopeRef = useRef({ key: nodeSourceKey, revision: 0 })
  if (nodeSourceScopeRef.current.key !== nodeSourceKey) nodeSourceScopeRef.current = { key: nodeSourceKey, revision: nodeSourceScopeRef.current.revision + 1 }
  const nodeSourceCatalog = nodeSourceSnapshot.key === nodeSourceKey && draftActionsEnabled ? nodeSourceSnapshot.catalog : emptyCanvasNodeSourceCatalog
  const nodeSourceCatalogRef = useRef<CanvasNodeSourceCatalog>(nodeSourceCatalog)
  nodeSourceCatalogRef.current = nodeSourceCatalog
  const mediaPreparationErrorsRef = useRef(mediaPreparationErrors)
  mediaPreparationErrorsRef.current = mediaPreparationErrors
  const catalogReadRevisionRef = useRef(0)
  const mediaRetryRevisionRef = useRef(0)
  const mediaPreparationMountedRef = useRef(true)
  const groupCatalogRef = useRef<ReturnType<typeof createCanvasGroupCatalog<CanvasGroupSummary>> | null>(null)
  const mediaPreparationRevisionRef = useRef(0)
  const appliedMediaSignatureRef = useRef('')
  const imageGroup = mediaGroups.image ?? null
  const videoGroup = mediaGroups.video ?? null
  const videoProtocol = groups.find((group) => group.name === videoGroup)?.videoProtocol ?? 'relay-videos'
  const textGroup = mediaGroups.text ?? null
  const readGroupCatalog = useCallback((force = false) => {
    if (!draftActionsEnabledRef.current) return Promise.reject(new Error('画布连接已停止，请重新进入工作区核对'))
    if (!groupCatalogRef.current) groupCatalogRef.current = createCanvasGroupCatalog<CanvasGroupSummary>({
      load: () => hostBridge().listGroups(),
      changed: (snapshot) => {
        if (!mediaPreparationMountedRef.current || !draftActionsEnabledRef.current) return
        setRefreshingGroups(snapshot.refreshing)
        setGroupsError(snapshot.error)
        if (snapshot.groups !== null) {
          groupsRef.current = [...snapshot.groups]
          groupsLoadedRef.current = true
          setGroups([...snapshot.groups])
          setGroupsLoaded(true)
          if (!snapshot.refreshing && !snapshot.error) {
            catalogReadRevisionRef.current += 1
            setCatalogReadRevision(catalogReadRevisionRef.current)
            if (Object.keys(mediaPreparationErrorsRef.current).length > 0) {
              mediaRetryRevisionRef.current += 1
              setMediaRetryRevision(mediaRetryRevisionRef.current)
            }
          }
        }
      },
    })
    return groupCatalogRef.current.refresh(force).then((listed) => {
      if (force && mediaPreparationMountedRef.current && draftActionsEnabledRef.current) {
        mediaRetryRevisionRef.current += 1
        setMediaRetryRevision(mediaRetryRevisionRef.current)
      }
      return listed
    })
  }, [])
  const refreshGroups = useCallback((force = false) => { void readGroupCatalog(force).catch(() => undefined) }, [readGroupCatalog])
  useEffect(() => {
    if (!groupsLoaded || !draftActionsEnabled || !projectCanRun || !window.xingmangCanvasHost) return
    const revision = nodeSourceScopeRef.current.revision, epoch = projectEpochRef.current, projectId = activeProjectIdRef.current
    let active = true
    function current() { return active && draftActionsEnabledRef.current && nodeSourceScopeRef.current.revision === revision && projectEpochRef.current === epoch && activeProjectIdRef.current === projectId }
    void prepareCanvasNodeSources({ names: fixedNodeSourceNames, groups, prepare: (name) => hostBridge().prepareGroup(name), isCurrent: current,
      onChange(catalog) { if (current()) { nodeSourceCatalogRef.current = catalog; setNodeSourceSnapshot({ key: nodeSourceKey, catalog }) } },
    }).catch(() => undefined)
    return () => { active = false }
  }, [nodeSourceKey, nodeSourceScopeRef.current.revision, groupsLoaded, draftActionsEnabled, projectCanRun])
  useEffect(() => {
    mediaPreparationMountedRef.current = true
    return () => {
      mediaPreparationMountedRef.current = false
      mediaPreparationRevisionRef.current += 1
      groupCatalogRef.current?.dispose()
      groupCatalogRef.current = null
    }
  }, [])
  useEffect(() => {
    if (!window.xingmangCanvasHost) return
    const refreshVisible = () => { if (document.visibilityState === 'visible') refreshGroups() }
    window.addEventListener('focus', refreshVisible)
    document.addEventListener('visibilitychange', refreshVisible)
    return () => {
      window.removeEventListener('focus', refreshVisible)
      document.removeEventListener('visibilitychange', refreshVisible)
    }
  }, [refreshGroups])
  useEffect(() => {
    if (!mediaConfigOpen || !window.xingmangCanvasHost) return
    refreshGroups()
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') refreshGroups()
    }, 30000)
    return () => window.clearInterval(interval)
  }, [mediaConfigOpen, refreshGroups])
  const rejectUnavailableGroups = useCallback((preflight: CanvasRunPreflight) => {
    const missing = groupsLoadedRef.current ? unavailableCanvasMediaRunGroups(preflight, groupsRef.current) : []
    if (!missing.length) return false
    setBanner(`分组「${missing.join('」、「')}」已不可用，请在生成配置中重新选择`)
    setMediaConfigOpen(true)
    return true
  }, [])

  const refreshProjects = useCallback(async (nextQuery?: CanvasProjectListQuery) => {
    const revision = ++projectRequestRevisionRef.current
    if (nextQuery) {
      projectQueryRef.current = { ...nextQuery }
      setProjectQuery({ ...nextQuery })
    }
    setProjectLoading(true)
    setProjectError(null)
    try {
      const host = hostBridge()
      if (host.listProjectPage) {
        const loaded = await loadCanvasProjectPage((query) => host.listProjectPage!(query), projectQueryRef.current, () => projectRequestRevisionRef.current === revision)
        if (loaded && projectRequestRevisionRef.current === revision) {
          projectQueryRef.current = loaded.query
          setProjectQuery(loaded.query)
          setProjectPage(loaded.page)
          setProjects(loaded.page.items)
        }
      } else {
        const listed = await host.listProjects()
        if (projectRequestRevisionRef.current === revision) { setProjectPage(null); setProjects(listed) }
      }
    } catch (error) {
      if (projectRequestRevisionRef.current === revision) setProjectError(error instanceof Error ? error.message : String(error))
    } finally {
      if (projectRequestRevisionRef.current === revision) setProjectLoading(false)
    }
  }, [])

  const changeProjectQuery = useCallback((query: CanvasProjectListQuery) => { void refreshProjects(query) }, [refreshProjects])
  const invalidateProjectQuery = useCallback(() => {
    projectRequestRevisionRef.current += 1
    setProjectLoading(true)
    setProjectError(null)
  }, [])

  useEffect(() => {
    if (!window.xingmangCanvasHost) return
    void refreshProjects()
    return () => { projectRequestRevisionRef.current += 1 }
  }, [refreshProjects])

  useEffect(() => {
    applyCanvasAppearance(appearanceRef.current)
    const host = window.xingmangCanvasHost
    const unsubscribeTheme = subscribeCanvasTheme(host, (nextTheme) => {
      appearanceRef.current = { ...appearanceRef.current, theme: nextTheme }
      applyCanvasAppearance(appearanceRef.current)
      setTheme(nextTheme)
    })
    const unsubscribeAppearance = typeof host?.onAppearanceChange === 'function'
      ? host.onAppearanceChange((appearance) => {
        appearanceRef.current = appearance
        applyCanvasAppearance(appearance)
        setTheme(appearance.theme)
      })
      : () => {}
    return () => { unsubscribeTheme(); unsubscribeAppearance() }
  }, [])

  const applyProjectUiPreferences = useCallback((next: CanvasUiPreferences) => {
    setUiPreferences(next)
    setMinimapOpen(next.minimapOpen)
    setFocusMode(next.focusMode)
    setInspectorTab(next.rightPanel ?? 'node')
    setAssetTrayOpen(next.rightPanel === 'assets')
    setRunInspectorOpen(next.rightPanel === 'runs')
  }, [])

  const setComposerCollapsed = useCallback((composerCollapsed: boolean) => {
    setUiPreferences((current) => current.composerCollapsed === composerCollapsed ? current : { ...current, composerCollapsed })
  }, [])

  useEffect(() => {
    if (!activeProject) return
    setUiPreferences((current) => {
      const rightPanel: CanvasRightPanel = assetTrayOpen ? 'assets' : runInspectorOpen ? 'runs' : null
      if (current.rightPanel === rightPanel && current.minimapOpen === minimapOpen && current.focusMode === focusMode) return current
      return { ...current, rightPanel, minimapOpen, focusMode }
    })
  }, [activeProject, assetTrayOpen, focusMode, minimapOpen, runInspectorOpen])

  useEffect(() => {
    if (!activeProject) return
    writeCanvasUiPreferences(activeProject.id, uiPreferences)
  }, [activeProject, uiPreferences])

  const cancelInsertionViewportFocus = useCallback(() => {
    insertionViewportFocusRevisionRef.current++
    if (insertionViewportFrameRef.current !== null) window.cancelAnimationFrame(insertionViewportFrameRef.current)
    insertionViewportFrameRef.current = null
  }, [])

  const cancelInsertionViewportNavigation = useCallback(() => {
    cancelInsertionViewportFocus()
    cancelDocumentInsertionViewportNavigation()
  }, [cancelInsertionViewportFocus, cancelDocumentInsertionViewportNavigation])

  const focusInsertedNodes = useCallback((token: InsertionViewportToken | null, nodeIds: readonly string[]) => {
    cancelInsertionViewportFocus()
    if (!token || nodeIds.length === 0) return
    createdNodeFocusRef.current?.cancel()
    viewportRestorationRef.current?.cancel()
    const projectEpoch = projectEpochRef.current, projectId = activeProjectIdRef.current
    const focusRevision = insertionViewportFocusRevisionRef.current
    const ownerId = layerEditorOwnerRef.current.ownerId, accountId = layerEditorOwnerRef.current.accountId
    const ids = new Set(nodeIds)
    function current() {
      return draftActionsEnabledRef.current && projectCanEditRef.current && !projectTransitionRef.current
        && layerEditorOwnerRef.current.ownerId === ownerId && layerEditorOwnerRef.current.accountId === accountId
        && insertionViewportFocusRevisionRef.current === focusRevision && projectEpochRef.current === projectEpoch && activeProjectIdRef.current === projectId && isInsertionViewportCurrent(token!)
    }
    function focus(attempt = 0) {
      if (!current()) return
      insertionViewportFrameRef.current = window.requestAnimationFrame(() => {
        if (!current()) return
        insertionViewportFrameRef.current = null
        const flow = currentReactFlowRef.current, all = flow.getNodes()
        const inserted = all.filter((node) => ids.has(node.id))
        if (inserted.length !== ids.size) {
          if (attempt < 8 && getGraphSnapshot().nodes.filter((node) => ids.has(node.id)).length === ids.size) focus(attempt + 1)
          return
        }
        const targets = inserted.filter((node) => !node.hidden), pane = document.querySelector<HTMLElement>('.canvas-flow')
        if (!pane || targets.length === 0) return
        const safe = measureCanvasSafeViewport(pane), next = safe ? fitCanvasViewport(flow.getNodesBounds(targets), safe, 1) : null
        if (!next) { if (attempt < 8) focus(attempt + 1); return }
        void flow.setViewport(next, { duration: 180 }).then(() => {
          if (current()) setDocumentViewport(flow.getViewport())
        }).catch(() => { /* A disposed pane never retries across a project boundary. */ })
      })
    }
    focus()
  }, [cancelInsertionViewportFocus, getGraphSnapshot, isInsertionViewportCurrent, setDocumentViewport])

  useEffect(() => () => cancelInsertionViewportFocus(), [activeProject?.id, currentDraftProjectEpoch, draftActionsEnabled, cancelInsertionViewportFocus])

  const fitCanvasNodes = useCallback((nodeIds?: readonly string[], maximumZoom = 1) => {
    cancelInsertionViewportNavigation()
    createdNodeFocusRef.current?.cancel()
    viewportRestorationRef.current?.cancel()
    const projectEpoch = projectEpochRef.current, projectId = activeProjectIdRef.current
    window.requestAnimationFrame(() => {
      if (projectEpochRef.current !== projectEpoch || activeProjectIdRef.current !== projectId || projectTransitionRef.current) return
      const flow = currentReactFlowRef.current
      const selected = nodeIds ? new Set(nodeIds) : null
      const targets = flow.getNodes().filter((node) => !node.hidden && (!selected || selected.has(node.id)))
      const pane = document.querySelector<HTMLElement>('.canvas-flow')
      if (!pane || targets.length === 0) return
      const safe = measureCanvasSafeViewport(pane)
      const next = safe ? fitCanvasViewport(flow.getNodesBounds(targets), safe, maximumZoom) : null
      if (next) void flow.setViewport(next, { duration: 180 })
    })
  }, [cancelInsertionViewportNavigation])

  const fitCanvas = useCallback(() => { fitCanvasNodes() }, [fitCanvasNodes])

  const toggleCanvasOverview = useCallback(() => {
    cancelInsertionViewportNavigation()
    createdNodeFocusRef.current?.cancel()
    viewportRestorationRef.current?.cancel()
    if (nodes.length === 0) return
    const restore = overviewViewportRef.current
    if (restore) {
      overviewViewportRef.current = null
      void reactFlow.setViewport(restore, { duration: 180 })
      setDocumentViewport(restore)
      return
    }
    overviewViewportRef.current = reactFlow.getViewport()
    fitCanvasNodes()
  }, [nodes.length, reactFlow, setDocumentViewport, fitCanvasNodes, cancelInsertionViewportNavigation])

  const fitSelection = useCallback(() => {
    cancelInsertionViewportNavigation()
    createdNodeFocusRef.current?.cancel()
    viewportRestorationRef.current?.cancel()
    const selected = nodes.filter((node) => node.selected)
    if (selected.length === 0) {
      setBanner('请先选择要聚焦的节点')
      return
    }
    fitCanvasNodes(selected.map((node) => node.id), 1.18)
  }, [nodes, fitCanvasNodes, cancelInsertionViewportNavigation])

  const restoreCanvasViewport = useCallback((nextViewport: Viewport) => {
    cancelInsertionViewportFocus()
    createdNodeFocusRef.current?.cancel()
    overviewViewportRef.current = null
    viewportRestorationRef.current?.request(nextViewport)
  }, [cancelInsertionViewportFocus])

  useEffect(() => {
    if (nodes.length === 0) overviewViewportRef.current = null
  }, [nodes.length])

  const persistBrowserDraft = useCallback((project: CanvasStoredProjectSummary, content: string, cloudVersion = draftBaseVersionRef.current): CanvasBrowserDraft | null => {
    if (!draftOwnerId) return null
    let candidate: CanvasBrowserDraft | null = null
    try {
      const reservation = reserveCanvasDraftRevision(draftWriterIdRef.current, draftRevisionSequenceRef.current)
      candidate = createCanvasBrowserDraft({
        ownerId: draftOwnerId,
        projectId: project.id,
        writerId: draftWriterIdRef.current,
        revision: reservation.revision,
        cloudVersion,
        content,
      })
      const previous = browserDraftRef.current
      if (previous?.projectId === project.id && previous.writerId === draftWriterIdRef.current && previous.content === candidate.content && previous.cloudVersion === cloudVersion) {
        try { assertCanvasBrowserDraftStored(window.localStorage, previous); return previous }
        catch { /* A removed or changed disk copy must be written again. */ }
      }
      // The repo may retain the new immutable version before cleanup fails.
      // Consume its id before writing, even when acknowledgement will throw.
      draftRevisionSequenceRef.current = reservation.revisionSequence
      const saved = writeCanvasBrowserDraft(window.localStorage, candidate)
      browserDraftRef.current = saved
      setDraftStorageError(null)
      return saved
    } catch (error) {
      if (candidate) browserDraftRef.current = resolveCanvasDraftProtectionAfterWriteFailure(candidate, browserDraftRef.current, (draft) => assertCanvasBrowserDraftStored(window.localStorage, draft))
      setDraftStorageError(error instanceof Error ? error.message : '本地草稿保存失败，请导出当前工作流后再离开')
      return null
    }
  }, [draftOwnerId])

  const openStoredProject = useCallback(async (projectId: string, options: { skipDraftRecovery?: boolean; confirmed?: Extract<CanvasProjectRestoreResult, { state: 'restored' }>; resolvedRecovery?: ProjectHistoryRecoveryRecord } = {}) => {
    const pendingHistoryAtOpen = historyPendingRef.current
    const revision = ++projectRequestRevisionRef.current
    projectEpochRef.current += 1
    autoSaveRevisionRef.current += 1
    setProjectLoading(true)
    setProjectError(null)
    try {
      const opened = options.confirmed ?? await hostBridge().openProject(projectId)
      if (projectRequestRevisionRef.current !== revision) return false
      if (opened.project.id !== projectId || (options.confirmed && !draftActionsEnabledRef.current)) throw new Error('恢复结果的账户或工程无法确认，当前画布仍保留')
      const workflow = parseWorkflowFile(opened.content)
      if (!workflow) throw new Error('项目内容无法读取')
      const nextDocument = workflowDocument(workflow)
      const cloudContent = serializeWorkflow(workflow)
      let recoveryRecord: ProjectHistoryRecoveryRecord | null = null
      let recoveryError: string | null = null
      if (storageMode === 'cloud') {
        try {
          if (!creationOwnerId || historyRecoveryOwnerRef.current !== creationOwnerId) throw new Error('版本恢复所属账号尚未核对，请重新进入工作区；当前不会覆盖原恢复记录')
          recoveryRecord = readProjectHistoryRecovery(window.localStorage, creationOwnerId, projectId)
          if (options.resolvedRecovery) {
            if (options.resolvedRecovery.ownerId !== creationOwnerId || options.resolvedRecovery.projectId !== projectId) throw new Error('原恢复记录不属于当前账号或工程，当前不会结束核对')
            // Another page may already have acknowledged this exact receipt.
            // A different surviving operation must never be cleared by it.
            if (recoveryRecord) {
              assertProjectHistoryRecoveryStored(window.localStorage, options.resolvedRecovery)
              clearProjectHistoryRecovery(window.localStorage, options.resolvedRecovery)
            }
            recoveryRecord = null
          }
        } catch (error) {
          if (options.resolvedRecovery) throw error
          recoveryError = error instanceof Error ? error.message : '本机版本恢复记录尚未核对，请保留浏览器数据'
        }
      }
      let drafts: CanvasBrowserDraft[] = []
      if (draftOwnerId && !options.skipDraftRecovery) {
        try { drafts = listCanvasBrowserDrafts(window.localStorage, draftOwnerId, projectId).filter((draft) => draft.content !== cloudContent) }
        catch (error) { setDraftStorageError(error instanceof Error ? error.message : '本地草稿读取失败，请保留当前编辑并导出工作流') }
      }
      activeProjectIdRef.current = opened.project.id
      const editRoute = new URL(window.location.href), editTargetId = readWorkshopEditTarget(editRoute.searchParams, opened.project.id)
      setWorkshopEditTarget(editTargetId ? { id: editTargetId, projectId: opened.project.id } : null)
      if (!editTargetId && editRoute.searchParams.has('workshopEdit')) {
        clearWorkshopEditTarget(editRoute.searchParams)
        window.history.replaceState(window.history.state, '', `${editRoute.pathname}${editRoute.search}${editRoute.hash}`)
      }
      historyDialogEpochRef.current += 1
      setHistoryScope(null)
      historyPendingRef.current = recoveryRecord ? { projectId, epoch: projectEpochRef.current, input: recoveryRecord.input, record: recoveryRecord } : null
      historyMissingRef.current = null
      historyRecoveryErrorRef.current = recoveryError
      setHistoryPendingState(recoveryRecord ? 'unknown' : undefined)
      setHistoryError(recoveryError)
      if (templateCreatedProjectRef.current?.projectId !== opened.project.id) {
        templateCreatedProjectRef.current = null
        templateProjectSubmissionRef.current.confirmed()
      }
      draftBaseVersionRef.current = opened.project.version ?? 0
      lastConfirmedContentRef.current = cloudContent
      browserDraftRef.current = null
      restoredDraftRef.current = null
      browserUnsavedRef.current = false
      saveConflictRef.current = Boolean(recoveryRecord || recoveryError)
      draftRecoveryPendingRef.current = drafts.length > 0
      setSaveConflict(recoveryError ?? (recoveryRecord ? '原版本恢复操作尚需核对，自动保存已暂停。请打开“版本历史”核对原结果；刷新不会重复提交。' : null))
      draftLocalActionGuard.current.invalidate()
      draftDialogEpochRef.current += 1
      setDraftDialogMode('recovery')
      setDraftDialogScope(drafts.length ? currentDraftActionScope() : null)
      setDraftConfirmation(null)
      setDraftDialogNotice(null)
      setDraftDialogError(null)
      setDraftListAvailable(true)
      setDraftLocalActionBusy(false)
      setDraftRecovery(drafts.length ? drafts : null)
      setSelectedDraft(drafts[0] ? { writerId: drafts[0].writerId, revision: drafts[0].revision } : null)
      projectHydrationRef.current = true
      execute({ type: 'replace-document', document: nextDocument, resetHistory: true })
      setDirtyNodeIds(dirtyCanvasNodeIds(workflow.nodes))
      setActiveProject(opened.project)
      setProjects((current) => [opened.project, ...current.filter((project) => project.id !== opened.project.id)])
      setSelectedRunId(null)
      setRunRecords([])
      runsRequestRevisionRef.current += 1
      pendingRunProjectionIdsRef.current.clear()
      runInputGraphsRef.current.clear()
      activeRunsRef.current.clear()
      runWaitingBannerRef.current = null
      setRunning(false)
      setRunRecoveryRevision((current) => current + 1)
      setRunsError(null)
      setBanner(null)
      applyProjectUiPreferences(canvasStartupUiPreferences(readCanvasUiPreferences(opened.project.id)))
      setAutoSaveState(recoveryRecord || recoveryError ? 'failed' : 'saved')
      restoreCanvasViewport(nextDocument.viewport)
      return true
    } catch (error) {
      if (projectRequestRevisionRef.current === revision) {
        // A failed reload advances the request epoch but leaves the original
        // editor graph installed. Its unknown restore must remain reconcilable.
        if (pendingHistoryAtOpen && historyPendingRef.current === pendingHistoryAtOpen && activeProjectIdRef.current === pendingHistoryAtOpen.projectId && draftActionsEnabledRef.current) pendingHistoryAtOpen.epoch = projectEpochRef.current
        setProjectError(error instanceof Error ? error.message : String(error))
      }
      return false
    }
    finally { if (projectRequestRevisionRef.current === revision) setProjectLoading(false) }
  }, [applyProjectUiPreferences, draftOwnerId, creationOwnerId, storageMode, execute, restoreCanvasViewport])

  useEffect(() => {
    if (storageMode !== 'cloud' || !creationOwnerId || !activeProject || !draftActionsEnabled) return
    const ownerId = creationOwnerId, projectId = activeProject.id, epoch = projectEpochRef.current
    let alive = true, sequence = 0
    function current(ticket: number) { return alive && ticket === sequence && draftActionsEnabledRef.current && historyRecoveryOwnerRef.current === ownerId && projectEpochRef.current === epoch && activeProjectIdRef.current === projectId && !historyBusyRef.current }
    async function refreshProjectHistoryRecovery() {
      const ticket = ++sequence
      if (!current(ticket)) return
      try {
        const record = readProjectHistoryRecovery(window.localStorage, ownerId, projectId)
        let pending = historyPendingRef.current
        if (record && (!pending?.record || JSON.stringify(pending.record) !== JSON.stringify(record))) {
          pending = { projectId, epoch, input: record.input, record }
          historyPendingRef.current = pending
          historyMissingRef.current = null
          setHistoryPendingState('unknown')
        }
        if (!pending?.record || pending.projectId !== projectId || pending.epoch !== epoch) return
        historyRecoveryErrorRef.current = null
        saveConflictRef.current = true
        if (autosaveTimerRef.current !== null) { window.clearTimeout(autosaveTimerRef.current); autosaveTimerRef.current = null }
        setSaveConflict('原版本恢复操作尚需核对，自动保存已暂停。打开“版本历史”核对或明确重试；刷新不会重复提交。')
        setAutoSaveState('failed')
        const inspect = hostBridge().inspectProjectRestore
        if (!inspect) throw new Error('当前宿主尚未提供原版本恢复核对，请更新应用；原记录仍保留')
        const result = await inspect(projectId, pending.input)
        if (!current(ticket) || historyPendingRef.current !== pending) return
        setHistoryPendingState(result.state === 'restored' ? 'completed' : result.state)
        historyMissingRef.current = result.state === 'missing' && record ? pending : null
        setHistoryError(null)
      } catch (error) {
        if (!current(ticket)) return
        const message = error instanceof Error ? error.message : '原版本恢复尚未核对，请保留浏览器记录'
        historyMissingRef.current = null
        historyRecoveryErrorRef.current = historyPendingRef.current ? null : message
        saveConflictRef.current = true; setSaveConflict(message); setAutoSaveState('failed'); setHistoryError(message)
      }
    }
    function storageChanged(event: StorageEvent) { if (event.key === null || event.key === projectHistoryRecoveryKey(ownerId, projectId)) void refreshProjectHistoryRecovery() }
    function samePageChanged() { void refreshProjectHistoryRecovery() }
    void refreshProjectHistoryRecovery()
    window.addEventListener('storage', storageChanged)
    window.addEventListener(projectHistoryRecoveryEvent, samePageChanged)
    return () => { alive = false; sequence++; window.removeEventListener('storage', storageChanged); window.removeEventListener(projectHistoryRecoveryEvent, samePageChanged) }
  }, [storageMode, creationOwnerId, activeProject?.id, activeProject?.version, currentDraftProjectEpoch, draftActionsEnabled])

  blankOpenRef.current = openStoredProject
  useEffect(() => {
    if (storageMode !== 'cloud') { setBlankCreationReady(true); return }
    let live = true
    setBlankCreationReady(false)
    let controller: ReturnType<typeof createBlankProjectCreation>
    try {
      if (!creationOwnerId) throw new Error('当前账户尚未确认，尚未提交新建画布。')
      const bridge = hostBridge()
      if (!bridge.createTemplateProject || !bridge.inspectProjectCreation) throw new Error('原工程创建核对入口尚未就绪，尚未提交新建画布。')
      try {
        const savedDraft = readSavedBlankProjectDraft(window.localStorage, creationOwnerId)
        setBlankProjectName(savedDraft?.name ?? '')
        setBlankDraftError(null)
      } catch (error) { setBlankDraftError(error instanceof Error ? error.message : '新名称草稿尚未读取，请保留浏览器数据并重新进入原账户。') }
      controller = createBlankProjectCreation({
        ownerId: creationOwnerId, storage: window.localStorage, createOperationId: () => crypto.randomUUID(),
        submit: (record) => bridge.createTemplateProject!({ operationId: record.operationId, content: record.content }),
        inspect: (record) => bridge.inspectProjectCreation!({ operationId: record.operationId, creationDigest: record.creationDigest }),
        async open(project) {
          if (!draftActionsEnabledRef.current) throw new Error('账户连接已停止，请保留原新建记录。')
          if (project.archivedAt) throw new Error('原工程已归档，请在项目中心切换归档列表核对和恢复。')
          if (!await blankOpenRef.current(project.id)) throw new Error('原工程暂未能打开，请保留原新建记录并重试打开。')
          if (!live || !draftActionsEnabledRef.current) throw new Error('账户等待已停止，请保留原新建记录。')
          const route = new URL(window.location.href)
          route.searchParams.set('project', project.id)
          route.searchParams.delete('template')
          route.searchParams.delete('templateOperation')
          window.history.replaceState(window.history.state, '', `${route.pathname}${route.search}${route.hash}`)
        },
        isActive: () => live && draftActionsEnabledRef.current,
      })
    } catch (error) {
      setBlankCreation({ phase: 'idle', pending: null, confirmedProject: null, error: error instanceof Error ? error.message : '本地新建恢复记录不可用，尚未提交创建。', busy: false })
      return
    }
    blankCreationRef.current = controller
    const unsubscribe = controller.subscribe((state) => { if (live) setBlankCreation(state) })
    void controller.restore().then((state) => { if (live) setBlankCreationReady(!state.error) }).catch((error) => {
      if (live) setBlankCreation({ ...controller.state(), error: error instanceof Error ? error.message : '原新建记录尚未读取，请保留浏览器数据并重新核对。' })
    })
    return () => {
      live = false
      unsubscribe()
      controller.dispose()
      if (blankCreationRef.current === controller) blankCreationRef.current = null
    }
  }, [creationOwnerId, storageMode])

  useEffect(() => { if (!draftActionsEnabled) blankCreationRef.current?.invalidate() }, [draftActionsEnabled])

  const changeBlankProjectName = useCallback((name: string) => {
    if (!draftActionsEnabledRef.current || !creationOwnerId) return
    setBlankProjectName(name)
    try {
      writeSavedBlankProjectDraft(window.localStorage, creationOwnerId, { name })
      setBlankDraftError(null)
    } catch (error) { setBlankDraftError(error instanceof Error ? error.message : '新名称草稿暂未能可靠保存，请保留当前输入。') }
  }, [creationOwnerId])

  const continueBlankProjectCreation = useCallback(async () => {
    const controller = blankCreationRef.current
    if (!draftActionsEnabledRef.current || !controller || controller.state().busy || controller.state().phase !== 'missing') return
    await controller.continueOriginal()
  }, [])

  const finishBlankProjectCreation = useCallback(async () => {
    const controller = blankCreationRef.current
    if (!draftActionsEnabledRef.current || !controller || controller.state().busy || controller.state().phase !== 'confirmed') return
    await controller.finishConfirmed()
  }, [])

  const createStoredProject = useCallback(async (name: string) => {
    if (storageMode === 'cloud') {
      const controller = blankCreationRef.current
      if (!draftActionsEnabledRef.current || !blankCreationReady || !controller || controller.state().busy) return false
      const state = controller.state()
      if (!state.pending && blankDraftError) return false
      if (!state.pending) { await controller.start({ name }); return false }
      if (state.phase !== 'confirmed') { await controller.inspectOriginal(); return false }
      const opened = await controller.openConfirmed()
      if (!draftActionsEnabledRef.current || opened.error || opened.phase !== 'confirmed') return false
      // The original project was opened successfully. Only its exact saved
      // submission may now be cleared; a failed cleanup remains recoverable.
      await controller.finishConfirmed()
      return true
    }
    setProjectLoading(true)
    setProjectError(null)
    try {
      const created = await hostBridge().createProject(name)
      if (!created) return false
      setProjects((current) => [created.project, ...current.filter((project) => project.id !== created.project.id)])
      // Creation has already committed even if the following read fails.
      // Persist its route now so refreshing cannot create another project.
      if (new URLSearchParams(window.location.search).has('template')) {
        const route = new URL(window.location.href)
        route.searchParams.set('project', created.project.id)
        route.searchParams.delete('template')
        window.history.replaceState(window.history.state, '', `${route.pathname}${route.search}${route.hash}`)
      }
      return await openStoredProject(created.project.id)
    } catch (error) { setProjectError(error instanceof Error ? error.message : String(error)); return false }
    finally { setProjectLoading(false) }
  }, [openStoredProject, storageMode, blankCreationReady, blankDraftError])

  const finishTemplateProjectCreation = useCallback(async (submission: SavedTemplateProjectSubmission) => {
    const bridge = hostBridge()
    if (!bridge.createTemplateProject || submission.ownerId !== draftOwnerId) throw new Error('模板恢复的账户归属无法确认，请重新进入原账户工作区')
    const setupRequest = { ...layerEditorOwnerRef.current, projectEpoch: projectEpochRef.current }
    setProjectLoading(true)
    try {
      const created = await bridge.createTemplateProject(submission)
      templateCreatedProjectRef.current = { projectId: created.project.id, templateId: submission.templateId }
      templateProjectSubmissionRef.current.confirmed()
      const route = new URL(window.location.href)
      bindWorkshopEditProject(route.searchParams, created.project.id, submission.templateId)
      route.searchParams.set('project', created.project.id)
      route.searchParams.delete('template')
      route.searchParams.delete('templateOperation')
      route.searchParams.delete('workshop')
      route.searchParams.delete('promptPreset')
      route.searchParams.delete('builtinPrompt')
      route.searchParams.delete('commerceTask'); route.searchParams.delete('interiorTask'); route.searchParams.delete('exteriorTask'); route.searchParams.delete('storyboardTask')
      window.history.replaceState(window.history.state, '', `${route.pathname}${route.search}${route.hash}`)
      if (!await openStoredProject(created.project.id)) throw new Error('模板工程已创建，但读取尚未完成；请重试读取或在项目中心打开原工程')
      try { clearSavedTemplateProjectSubmission(window.localStorage, submission) }
      catch (error) { setDraftStorageError(error instanceof Error ? error.message : '模板恢复记录清理失败；云端工程已确认，请保留当前工程地址') }
      templateCreatedProjectRef.current = null
      setSavedTemplateRecovery(null)
      setTemplateCatalog(null)
      setWorkshopCatalog(null)
      setBanner(submission.templateId === 'storyboard-creation' ? '已创建故事板工程，图片顺序、剧情与节点参数已保存' : submission.templateId.startsWith('exterior-') ? '已创建室外创作工程，图片角色与节点参数已保存' : submission.templateId === 'interior-render' ? '已创建室内创作工程，原图与节点参数已保存' : submission.templateId.startsWith('commerce-') ? '已创建商品创作工程，图片角色与节点参数已保存' : '已创建模板工程，原配置和节点已保存')
      openCreatedWorkshopSetup(created.project.id, setupRequest)
    } finally { setProjectLoading(false) }
  }, [draftOwnerId, openStoredProject, openCreatedWorkshopSetup])

  const resumeTemplateProjectCreation = useCallback(async () => {
    if (!savedTemplateRecovery || templateRecoveryBusyRef.current) return
    templateRecoveryBusyRef.current = true
    setTemplateRecoveryBusy(true)
    setTemplateRecoveryError(null)
    try {
      const opened = await openStoredProject(savedTemplateRecovery.operationId)
      if (opened) {
        const route = new URL(window.location.href)
        route.searchParams.set('project', savedTemplateRecovery.operationId)
        route.searchParams.delete('template')
        route.searchParams.delete('templateOperation')
        route.searchParams.delete('workshop')
        route.searchParams.delete('promptPreset')
        route.searchParams.delete('builtinPrompt')
        route.searchParams.delete('commerceTask'); route.searchParams.delete('interiorTask'); route.searchParams.delete('exteriorTask'); route.searchParams.delete('storyboardTask')
        window.history.replaceState(window.history.state, '', `${route.pathname}${route.search}${route.hash}`)
        try { clearSavedTemplateProjectSubmission(window.localStorage, savedTemplateRecovery) }
        catch (error) { setDraftStorageError(error instanceof Error ? error.message : '模板恢复记录清理失败；云端工程已确认') }
        setSavedTemplateRecovery(null)
        return
      }
      writeSavedTemplateProjectSubmission(window.localStorage, savedTemplateRecovery)
      await finishTemplateProjectCreation(savedTemplateRecovery)
    } catch (error) { setTemplateRecoveryError(error instanceof Error ? error.message : '原模板创建核对失败，请保留本地恢复记录后重试') }
    finally { templateRecoveryBusyRef.current = false; setTemplateRecoveryBusy(false) }
  }, [savedTemplateRecovery, openStoredProject, finishTemplateProjectCreation])

  useEffect(() => {
    if (projectLoading || initialRouteConsumedRef.current) return
    initialRouteConsumedRef.current = true
    const route = new URLSearchParams(window.location.search)
    const projectId = route.get('project')
    const templateId = route.get('template')
    const workshopId = route.get('workshop')
    const promptPresetId = route.get('promptPreset')
    const builtinPromptId = route.get('builtinPrompt')
    const commerceKind = commerceTaskKindFromRoute(route.get('commerceTask'))
    const interiorTask = interiorTaskFromRoute(route.get('interiorTask'))
    const exteriorTask = exteriorTaskFromRoute(route.get('exteriorTask'))
    const storyboardTask = storyboardTaskFromRoute(route.get('storyboardTask'))
    const template = templateId ? builtinCanvasTemplates.find((entry) => entry.id === templateId) : null
    if (!projectId && !template && !workshopId && !promptPresetId && !builtinPromptId && !commerceKind && !interiorTask && !exteriorTask && !storyboardTask && !route.get('templateOperation')) return
    function openExteriorRoute(task: ExteriorTask) {
      setExteriorSession({ scope: currentWorkshopSetupScope(), task, references: exteriorTaskRoles(task).map((role) => ({ role, binding: { kind: 'missing' } })), imageSource: exteriorTaskSourceSignature(groupsRef.current, mediaGroupsRef.current.image), textSource: exteriorTaskSourceSignature(groupsRef.current, mediaGroupsRef.current.text) })
    }
    function openStoryboardRoute(task: StoryboardTask) {
      setStoryboardSession({ scope: currentWorkshopSetupScope(), task, references: storyboardTaskRoles(task).map((role) => ({ role, binding: { kind: 'missing' } })), imageSource: storyboardTaskSourceSignature(groupsRef.current, mediaGroupsRef.current.image), textSource: storyboardTaskSourceSignature(groupsRef.current, mediaGroupsRef.current.text) })
    }
    const openInitial = async () => {
      const pendingId = route.get('templateOperation')
      const candidateId = projectId ?? pendingId
      if (candidateId) {
        if (pendingId && workshopId && readWorkshopEditTarget(route, null) === workshopId) {
          const editRoute = new URL(window.location.href)
          bindWorkshopEditProject(editRoute.searchParams, candidateId, `workshop-${workshopId}`)
          window.history.replaceState(window.history.state, '', `${editRoute.pathname}${editRoute.search}${editRoute.hash}`)
        }
        const opened = await openStoredProject(candidateId)
        try {
          const saved = draftOwnerId ? readSavedTemplateProjectSubmission(window.localStorage, draftOwnerId, candidateId) : null
          if (opened) {
            if (saved) clearSavedTemplateProjectSubmission(window.localStorage, saved)
            if (pendingId) {
              const confirmedRoute = new URL(window.location.href)
              confirmedRoute.searchParams.set('project', candidateId)
              confirmedRoute.searchParams.delete('template')
              confirmedRoute.searchParams.delete('templateOperation')
              confirmedRoute.searchParams.delete('workshop')
              confirmedRoute.searchParams.delete('promptPreset')
              confirmedRoute.searchParams.delete('builtinPrompt')
              confirmedRoute.searchParams.delete('commerceTask'); confirmedRoute.searchParams.delete('interiorTask'); confirmedRoute.searchParams.delete('exteriorTask'); confirmedRoute.searchParams.delete('storyboardTask')
              window.history.replaceState(window.history.state, '', `${confirmedRoute.pathname}${confirmedRoute.search}${confirmedRoute.hash}`)
            } else if (template) setTemplateCatalog({ initialTemplateId: template.id })
            else if (workshopId) setWorkshopCatalog({ initialItemId: workshopId })
            else if (promptPresetId) setWorkshopCatalog({ initialPromptId: promptPresetId })
            else if (builtinPromptId) setWorkshopCatalog({ initialBuiltinPromptId: builtinPromptId })
            else if (commerceKind) { const task = defaultCommerceTask(commerceKind); setCommerceSession({ scope: currentWorkshopSetupScope(), task, references: commerceTaskRoles(task).map((role) => ({ role, binding: { kind: 'missing' } })) }) }
            else if (interiorTask) setInteriorSession({ scope: currentWorkshopSetupScope(), task: interiorTask, source: { binding: { kind: 'missing' } }, group: mediaGroupsRef.current.image, models: [...mediaModelsRef.current.image] })
            else if (exteriorTask) openExteriorRoute(exteriorTask)
            else if (storyboardTask) openStoryboardRoute(storyboardTask)
          } else if (saved) {
            setSavedTemplateRecovery(saved)
            setTemplateRecoveryError('上次模板工程创建结果尚未确认，完整原配置已保存在当前账户的本地恢复记录中')
          } else if (pendingId) setProjectError('原模板创建记录在此浏览器不可读取，请在项目中心核对原工程，避免重复创建')
        } catch (error) { setProjectError(error instanceof Error ? error.message : '模板本地恢复记录不可读取，请保留原页面地址') }
        return
      }
      if (workshopId) { setWorkshopCatalog({ initialItemId: workshopId }); return }
      if (promptPresetId) { setWorkshopCatalog({ initialPromptId: promptPresetId }); return }
      if (builtinPromptId) { setWorkshopCatalog({ initialBuiltinPromptId: builtinPromptId }); return }
      if (commerceKind) { const task = defaultCommerceTask(commerceKind); setCommerceSession({ scope: currentWorkshopSetupScope(), task, references: commerceTaskRoles(task).map((role) => ({ role, binding: { kind: 'missing' } })) }); return }
      if (interiorTask) { setInteriorSession({ scope: currentWorkshopSetupScope(), task: interiorTask, source: { binding: { kind: 'missing' } }, group: mediaGroupsRef.current.image, models: [...mediaModelsRef.current.image] }); return }
      if (exteriorTask) { openExteriorRoute(exteriorTask); return }
      if (storyboardTask) { openStoryboardRoute(storyboardTask); return }
      if (!template) return
      setProjectError(null)
      setTemplateCatalog({ initialTemplateId: template.id })
    }
    void openInitial()
  }, [projectLoading, openStoredProject, draftOwnerId, currentWorkshopSetupScope])

  const renameStoredProject = useCallback(async (projectId: string, name: string) => {
    const revision = ++projectRequestRevisionRef.current
    setProjectLoading(true)
    setProjectError(null)
    try {
      const renamed = await hostBridge().renameProject(projectId, name)
      if (projectPaginationEnabled) await refreshProjects()
      else setProjects((current) => current.map((project) => project.id === renamed.id ? renamed : project))
      setActiveProject((current) => current?.id === renamed.id ? renamed : current)
      setBanner(null)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setProjectError(message)
      throw error instanceof Error ? error : new Error(message)
    }
    finally { if (projectRequestRevisionRef.current === revision) setProjectLoading(false) }
  }, [projectPaginationEnabled, refreshProjects])

  const duplicateStoredProject = useCallback(async (projectId: string, name: string) => {
    const revision = ++projectRequestRevisionRef.current
    setProjectLoading(true)
    setProjectError(null)
    try {
      const duplicated = await hostBridge().duplicateProject(projectId, name)
      if (!duplicated) return false
      if (projectPaginationEnabled) await refreshProjects()
      else setProjects((current) => [duplicated.project, ...current.filter((project) => project.id !== duplicated.project.id)])
      setBanner(null)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setProjectError(message)
      throw error instanceof Error ? error : new Error(message)
    }
    finally { if (projectRequestRevisionRef.current === revision) setProjectLoading(false) }
  }, [projectPaginationEnabled, refreshProjects])

  const setStoredProjectArchived = useCallback(async (projectId: string, archived: boolean) => {
    const revision = ++projectRequestRevisionRef.current
    setProjectLoading(true)
    setProjectError(null)
    try {
      const updated = await hostBridge().setProjectArchived(projectId, archived)
      if (projectPaginationEnabled) await refreshProjects()
      else setProjects((current) => current.map((project) => project.id === updated.id ? updated : project))
      if (archived) setActiveProject((current) => current?.id === projectId ? null : current)
      setBanner(null)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setProjectError(message)
      throw error instanceof Error ? error : new Error(message)
    }
    finally { if (projectRequestRevisionRef.current === revision) setProjectLoading(false) }
  }, [projectPaginationEnabled, refreshProjects])

  const mediaPreparationCurrent = useCallback((prepared: PreparedMediaConfiguration) => isCanvasMediaPreparationCurrent(prepared.scope, {
    requestRevision: mediaPreparationRevisionRef.current,
    projectEpoch: projectEpochRef.current,
    projectId: activeProjectIdRef.current,
    catalogSignature: canvasMediaCatalogSignature(withPreferredMediaDefaults(mediaGroupsRef.current, groupsRef.current, siteId), groupsRef.current, catalogReadRevisionRef.current),
  }, mediaPreparationMountedRef.current && draftActionsEnabledRef.current), [siteId])

  const currentPendingMediaKinds = useCallback(() => canvasPendingMediaKinds({
    selected: mediaGroupsRef.current, groups: groupsRef.current,
    legacyReadRevision: catalogReadRevisionRef.current, projectEpoch: projectEpochRef.current,
    projectId: activeProjectIdRef.current, settledSignatures: settledMediaSignaturesRef.current,
    pendingKinds: pendingMediaKindsRef.current,
  }), [])

  const rejectPendingMedia = useCallback((preflight: CanvasRunPreflight) => {
    if (mediaPreparationBlockedRef.current) {
      setBanner(mediaPreparationBlockedRef.current)
      return true
    }
    const pending = pendingCanvasMediaRunKinds(preflight, currentPendingMediaKinds(), mediaGroupsRef.current)
    if (!pending.length) return false
    const labels = { image: '生图', video: '视频', text: '文字' }
    setBanner(`${pending.map((kind) => labels[kind]).join('、')}来源正在核对，请等待此运行范围的模型准备完成；画布可继续编辑和保存`)
    return true
  }, [currentPendingMediaKinds])

  const applyPreparedMediaConfiguration = useCallback((prepared: PreparedMediaConfiguration, pendingKinds: readonly MediaCapabilityKind[] = []) => {
    if (!mediaPreparationCurrent(prepared)) return false
    mediaModelsRef.current = { image: prepared.imageModels, video: prepared.videoModels, text: prepared.textModels }
    mediaPreparationErrorsRef.current = prepared.errors
    pendingMediaKindsRef.current = [...pendingKinds]
    setImageModels(prepared.imageModels)
    setVideoModels(prepared.videoModels)
    setTextModels(prepared.textModels)
    setMediaPreparationErrors(prepared.errors)
    setPendingMediaKinds([...pendingKinds])
    const kinds: readonly MediaCapabilityKind[] = prepared.kind === 'all' ? ['image', 'video', 'text'] : [prepared.kind]
    for (const kind of kinds) {
      if (pendingKinds.includes(kind)) delete settledMediaSignaturesRef.current[kind]
      else settledMediaSignaturesRef.current[kind] = canvasMediaPurposePreparationSignature(kind, prepared.mediaGroups, groupsRef.current, catalogReadRevisionRef.current, prepared.scope)
    }
    // Progress supplies defaults for empty fields only. Explicit model choices
    // made while another source is reading remain part of the document.
    const merged = mergeCanvasMediaPreparationDefaults(mediaGroupsRef.current, prepared.mediaGroups)
    if (!mediaGroupsEqual(mediaGroupsRef.current, merged)) {
      mediaGroupsRef.current = merged
      execute({ type: 'set-media-groups', mediaGroups: merged })
    }
    if (prepared.kind === 'all' && pendingKinds.length === 0) appliedMediaSignatureRef.current = JSON.stringify([projectEpochRef.current,
      canvasMediaCatalogSignature(prepared.mediaGroups, groupsRef.current, catalogReadRevisionRef.current), mediaRetryRevisionRef.current])
    return true
  }, [mediaPreparationCurrent, execute])

  const prepareMediaConfiguration = useCallback(async (
    targetOrResolver: CanvasMediaGroups | ((availableGroups: readonly CanvasGroupSummary[]) => CanvasMediaGroups),
    preparationKind: MediaPreparationKind,
    onProgress?: (prepared: PreparedMediaConfiguration, pendingKinds: readonly MediaCapabilityKind[]) => void,
  ): Promise<PreparedMediaConfiguration | null> => {
    const requestRevision = ++mediaPreparationRevisionRef.current
    const projectEpoch = projectEpochRef.current
    const projectId = activeProjectIdRef.current
    function currentRequest() {
      return mediaPreparationMountedRef.current && draftActionsEnabledRef.current
        && requestRevision === mediaPreparationRevisionRef.current
        && projectEpoch === projectEpochRef.current && projectId === activeProjectIdRef.current
    }
    if (!currentRequest()) return null
    setPreparingMedia(preparationKind)
    // Cancelling a newer read and restoring an earlier selection cannot reuse
    // the earlier signature after its model arrays have been invalidated.
    appliedMediaSignatureRef.current = ''
    const requestedKinds: MediaCapabilityKind[] = preparationKind === 'all' ? ['image', 'video', 'text'] : [preparationKind]
    const freshModels = { ...mediaModelsRef.current }
    const freshErrors = { ...mediaPreparationErrorsRef.current }
    for (const kind of requestedKinds) {
      freshModels[kind] = []
      delete freshErrors[kind]
      delete settledMediaSignaturesRef.current[kind]
    }
    mediaModelsRef.current = freshModels
    mediaPreparationErrorsRef.current = freshErrors
    pendingMediaKindsRef.current = requestedKinds
    setImageModels(freshModels.image)
    setVideoModels(freshModels.video)
    setTextModels(freshModels.text)
    setMediaPreparationErrors(freshErrors)
    setPendingMediaKinds(requestedKinds)
    try {
      const availableGroups = groupsLoadedRef.current ? groupsRef.current : await readGroupCatalog()
      if (!currentRequest()) return null
      const requested = typeof targetOrResolver === 'function' ? targetOrResolver(availableGroups) : targetOrResolver
      const target = preparationKind === 'all' ? withPreferredMediaDefaults(requested, availableGroups, siteId) : requested
      const scope: CanvasMediaPreparationScope = {
        requestRevision, projectEpoch, projectId,
        catalogSignature: canvasMediaCatalogSignature(target, availableGroups, catalogReadRevisionRef.current),
      }
      const prepared = await prepareCanvasMediaSources({
        target, groups: availableGroups, kind: preparationKind,
        previousModels: mediaModelsRef.current, previousErrors: mediaPreparationErrorsRef.current,
        prepare: (group) => hostBridge().prepareGroup(group),
        onProgress: (progress: CanvasMediaPreparationProgress) => {
          const preparedProgress = { ...progress, scope, kind: preparationKind }
          if (mediaPreparationCurrent(preparedProgress)) onProgress?.(preparedProgress, progress.pendingKinds)
        },
        isCurrent: () => isCanvasMediaPreparationCurrent(scope, {
          requestRevision: mediaPreparationRevisionRef.current, projectEpoch: projectEpochRef.current,
          projectId: activeProjectIdRef.current,
          catalogSignature: canvasMediaCatalogSignature(target, groupsRef.current, catalogReadRevisionRef.current),
        }, mediaPreparationMountedRef.current && draftActionsEnabledRef.current),
      })
      return prepared ? { ...prepared, scope, kind: preparationKind } : null
    } catch (error) {
      // Identity and host lifetime failures remain global. An obsolete request
      // must not clear a newer project's models or replace its current warning.
      if (!currentRequest()) return null
      if (isCanvasMediaPreparationScopeError(error)) {
        const message = error instanceof Error ? error.message : '画布账户或连接已变化，请重新进入工作区核对'
        mediaPreparationBlockedRef.current = message
        setMediaPreparationBlocked(message)
        mediaModelsRef.current = { image: [], video: [], text: [] }
        mediaPreparationErrorsRef.current = { image: message, video: message, text: message }
        settledMediaSignaturesRef.current = {}
        setImageModels([])
        setVideoModels([])
        setTextModels([])
        setMediaPreparationErrors(mediaPreparationErrorsRef.current)
      } else {
        const message = error instanceof Error ? error.message : '模型来源暂时无法读取，请重新核对'
        const failedErrors = { ...mediaPreparationErrorsRef.current }
        for (const kind of requestedKinds) {
          failedErrors[kind] = message
          settledMediaSignaturesRef.current[kind] = canvasMediaPurposePreparationSignature(kind, mediaGroupsRef.current, groupsRef.current, catalogReadRevisionRef.current, { projectEpoch, projectId })
        }
        mediaPreparationErrorsRef.current = failedErrors
        setMediaPreparationErrors(failedErrors)
      }
      throw error
    } finally {
      if (requestRevision === mediaPreparationRevisionRef.current && mediaPreparationMountedRef.current) {
        pendingMediaKindsRef.current = []
        setPendingMediaKinds([])
        setPreparingMedia(null)
      }
    }
  }, [siteId, readGroupCatalog, mediaPreparationCurrent])

  const selectedMediaSignature = JSON.stringify([canvasMediaCatalogSignature(withPreferredMediaDefaults(mediaGroups, groups, siteId), groups, catalogReadRevision), mediaRetryRevision])
  const currentMediaProjectEpoch = projectEpochRef.current
  const exteriorCreationPreparing = !activeProject && exteriorSession?.scope === layerEditorScope && !exteriorSession.nodeId
  const storyboardCreationPreparing = !activeProject && storyboardSession?.scope === layerEditorScope && !storyboardSession.nodeId
  useEffect(() => {
    if (!projectCanRun || !window.xingmangCanvasHost || (!activeProject && !exteriorCreationPreparing && !storyboardCreationPreparing) || !draftActionsEnabled || projectTransition || mediaPreparationBlockedRef.current) {
      setPreparingMedia(null)
      return
    }
    const current = { ...mediaGroups }
    const signature = JSON.stringify([currentMediaProjectEpoch, canvasMediaCatalogSignature(withPreferredMediaDefaults(current, groupsRef.current, siteId), groupsRef.current, catalogReadRevisionRef.current), mediaRetryRevisionRef.current])
    if (signature === appliedMediaSignatureRef.current && currentPendingMediaKinds().length === 0) return
    let currentEffect = true
    void prepareMediaConfiguration(current, 'all', (prepared, pendingKinds) => {
      if (currentEffect) applyPreparedMediaConfiguration(prepared, pendingKinds)
    }).then((prepared) => {
      if (!currentEffect || !prepared || !applyPreparedMediaConfiguration(prepared)) return
      const created = mediaKeyCreatedNotice(prepared.keyCreatedGroups.map((group) => canvasGroupDisplayName(group, groupsRef.current)))
      const notices = [...(created ? [created] : []), ...prepared.warnings]
      if (notices.length > 0) setBanner(notices.join('；'))
    }).catch((error) => {
      if (!currentEffect || !mediaPreparationMountedRef.current || !draftActionsEnabledRef.current) return
      setBanner(error instanceof Error ? error.message : '模型来源核对未完成，请重新核对')
    })
    return () => { currentEffect = false; mediaPreparationRevisionRef.current += 1 }
  }, [projectCanRun, activeProject?.id, exteriorCreationPreparing, storyboardCreationPreparing, currentMediaProjectEpoch, selectedMediaSignature, draftActionsEnabled, projectTransition, applyPreparedMediaConfiguration, currentPendingMediaKinds, execute, prepareMediaConfiguration])

  const selectMediaGroup = useCallback((kind: MediaCapabilityKind, group: string) => {
    if (!group || !draftActionsEnabledRef.current) return
    const labels: Record<MediaCapabilityKind, string> = { image: '生图', video: '视频', text: '文字' }
    // Commit the user's source choice immediately, then recheck in background.
    // Old source models must become unusable before React schedules the effect.
    mediaPreparationRevisionRef.current += 1
    appliedMediaSignatureRef.current = ''
    delete settledMediaSignaturesRef.current[kind]
    mediaModelsRef.current = { ...mediaModelsRef.current, [kind]: [] }
    if (kind === 'image') setImageModels([])
    else if (kind === 'video') setVideoModels([])
    else setTextModels([])
    const next = { ...mediaGroupsRef.current, [kind]: group }
    mediaGroupsRef.current = next
    execute({ type: 'set-media-groups', mediaGroups: next })
    setBanner(`${labels[kind]}已切换到「${canvasGroupDisplayName(group, groupsRef.current)}」，正在后台核对模型；原默认模型保留`)
  }, [execute])

  const selectMediaModel = useCallback((kind: MediaCapabilityKind, model: string) => {
    if (!model) return
    const key = kind === 'image' ? 'imageModel' : kind === 'video' ? 'videoModel' : 'textModel'
    const next = { ...mediaGroupsRef.current, [key]: model }
    mediaGroupsRef.current = next
    execute({ type: 'set-media-groups', mediaGroups: next })
  }, [execute])

  // Run bookkeeping reacts to main-process events and must see the current graph
  // without making the subscription depend on it: re-subscribing on every node
  // change would tear the run event listener down mid-run.
  const graphRef = useRef({ nodes, edges })
  graphRef.current = { nodes, edges }
  const runGroupsRef = useRef({ image: imageGroup ?? '', video: videoGroup ?? '', videoProtocol, text: textGroup ?? '', imageModel: mediaGroups.imageModel, videoModel: mediaGroups.videoModel, textModel: mediaGroups.textModel })
  runGroupsRef.current = { image: imageGroup ?? '', video: videoGroup ?? '', videoProtocol, text: textGroup ?? '', imageModel: mediaGroups.imageModel, videoModel: mediaGroups.videoModel, textModel: mediaGroups.textModel }
  const confirmedRunGroups = useCallback(() => {
    const current = runGroupsRef.current
    // Catalog refs update before React commits the protocol in runGroupsRef.
    // Match the selected source against that same confirmed catalog snapshot.
    return { ...current, videoProtocol: groupsRef.current.find((group) => group.name === current.video)?.videoProtocol ?? 'relay-videos' }
  }, [])

  // Removing a node from the middle of a chain leaves two dangling ends. Heal
  // them in the same command so one undo restores the original wiring too.
  // Declared this early because the node handler registration below lists it as
  // a dependency, and a dependency array is read while rendering.
  const deleteNodesBridging = useCallback((nodeIds: readonly string[]) => {
    const bridges = bridgeEdgesForRemoval(edges, nodeIds).map((draft) => ({ id: nextNodeId(), ...draft }))
    execute({ type: 'delete-elements', nodeIds: [...nodeIds], ...(bridges.length > 0 ? { bridges } : {}) })
    setBanner(bridges.length > 0
      ? `已删除 ${nodeIds.length} 个节点，并接通 ${bridges.length} 条连线`
      : `已删除 ${nodeIds.length} 个节点`)
  }, [edges, execute])

  const patchNodeData = useCallback((nodeId: string, patch: Partial<CanvasNode['data']>) => {
    setNodes((current) => current.map((node) => (
      node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node
    )))
  }, [setNodes])

  const markDirtyFrom = useCallback((nodeId: string, patch: Partial<WorkflowNodeData> = {}, discrete = false) => {
    const { nodes: currentNodes, edges: currentEdges } = graphRef.current
    const dirty = new Set<string>([nodeId])
    const queue = [nodeId]
    while (queue.length > 0) {
      const source = queue.shift() as string
      for (const edge of currentEdges) {
        if (edge.source !== source || dirty.has(edge.target)) continue
        dirty.add(edge.target)
        queue.push(edge.target)
      }
    }
    const updated = markNodeAndDescendantsDirty(currentNodes, currentEdges, nodeId, patch)
    graphRef.current = { nodes: updated, edges: currentEdges }
    execute({ type: 'replace-nodes', nodes: updated.map(canvasNodeDocumentRecord), mergeKey: discrete ? undefined : `data:${nodeId}` })
    setDirtyNodeIds((current) => new Set([...current, ...dirty]))
  }, [execute])

  const undo = useCallback(() => {
    if (!projectCanEditRef.current) return
    cancelInsertionViewportFocus()
    const live = collaborationRef.current
    if (live?.needsOperationSave()) { void live.history('undo').catch((error) => setBanner(error instanceof Error ? error.message : '本人协作撤销未确认')); return }
    const navigation = undoDocument()
    graphRef.current = getGraphSnapshot()
    setDirtyNodeIds(dirtyCanvasNodeIds(graphRef.current.nodes))
    if (navigation?.kind === 'restore') restoreCanvasViewport(navigation.viewport)
  }, [undoDocument, getGraphSnapshot, cancelInsertionViewportFocus, restoreCanvasViewport])

  const redo = useCallback(() => {
    if (!projectCanEditRef.current) return
    cancelInsertionViewportFocus()
    const live = collaborationRef.current
    if (live?.needsOperationSave()) { void live.history('redo').catch((error) => setBanner(error instanceof Error ? error.message : '本人协作重做未确认')); return }
    const navigation = redoDocument()
    graphRef.current = getGraphSnapshot()
    setDirtyNodeIds(dirtyCanvasNodeIds(graphRef.current.nodes))
    if (navigation?.kind === 'focus') focusInsertedNodes(navigation.token, navigation.nodeIds)
  }, [redoDocument, getGraphSnapshot, cancelInsertionViewportFocus, focusInsertedNodes])

  const applyPromptDraft = useCallback((nodeId: string, prompt: string, discrete = false, promptReferences?: PromptReference[], editorScope?: string) => {
    if (!draftActionsEnabledRef.current || projectTransitionRef.current || editorScope !== undefined && editorScope !== layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })) return
    const current = getGraphSnapshot(), target = current?.nodes.find((node) => node.id === nodeId)
    if (target?.data.settings?.storyboardTask && storyboardTaskUsesAnalysis(parseNodeStoryboardTask(target.type ?? '', target.data.settings.storyboardTask))) {
      try {
        if (!projectCanEditRef.current || activeRunsRef.current.size || startingRunsRef.current) throw new Error('故事板正在运行或不可编辑，请稍后修改剧情')
        const workflow = buildStoryboardPromptEdit({ workflow: { ...createEmptyWorkflow('故事板创作'), nodes: current.nodes.map(toWorkflowNode), edges: current.edges.map(toWorkflowEdge) }, nodeId, prompt, promptReferences, currentReferences: buildCanvasUpstreamReferences(current.nodes, current.edges, []).get(nodeId) ?? [], createId: nextNodeId })
        if (!workflow) return
        const dirty = markNodeAndDescendantsDirty(workflow.nodes.map(toCanvasNode), workflow.edges, nodeId)
        execute({ type: 'replace-graph', nodes: dirty.map(canvasNodeDocumentRecord), edges: workflow.edges, ...(discrete ? {} : { mergeKey: `storyboard-prompt:${nodeId}` }) })
        graphRef.current = getGraphSnapshot(); setDirtyNodeIds(dirtyCanvasNodeIds(graphRef.current.nodes))
      } catch (cause) { setBanner(cause instanceof Error ? cause.message : '故事板剧情无法更新，请重新打开配置') }
      return
    }
    const updated = applyCanvasPromptDraft({ getGraphSnapshot, execute, setNodes }, nodeId, prompt, { discrete, promptReferences })
    if (!updated) return
    graphRef.current = updated
    setDirtyNodeIds(dirtyCanvasNodeIds(updated.nodes))
  }, [getGraphSnapshot, execute, setNodes])

  const setNodeFlags = useCallback((nodeIds: string[], flag: 'locked' | 'disabled', value: boolean) => {
    if (nodeIds.length === 0) return
    execute(flag === 'locked'
      ? { type: 'set-node-flags', nodeIds, locked: value }
      : { type: 'set-node-flags', nodeIds, disabled: value })
    const count = nodeIds.length
    setBanner(flag === 'locked'
      ? value ? `已锁定${count > 1 ? ` ${count} 个` : ''}节点位置` : `已解锁${count > 1 ? ` ${count} 个` : ''}节点位置`
      : value ? `已禁用${count > 1 ? ` ${count} 个` : ''}节点` : `已启用${count > 1 ? ` ${count} 个` : ''}节点`)
  }, [execute])

  const setInspectorNodeFlag = useCallback((nodeId: string, flag: 'locked' | 'disabled', value: boolean) => {
    setNodeFlags([nodeId], flag, value)
  }, [setNodeFlags])

  const buildExecutors = useCallback(() => (
    createHostExecutors({ imageGroup: imageGroup ?? '', videoGroup: videoGroup ?? '', host: hostBridge(), capabilities: canvasCapabilities() })
  ), [imageGroup, videoGroup])

  const requestNodeScopeRun = useCallback((nodeId: string, kind: 'to-node' | 'from-node', placeOutput = false): boolean => {
    if (!projectCanRunRef.current) { setBanner('协作项目暂不开放运行；当前内容可按权限查看、编辑和导出'); return false }
    if (projectTransitionRef.current || startingRunsRef.current > 0) {
      setBanner('正在保存工程或提交任务，请稍候再运行节点')
      return false
    }
    const target = nodes.find((entry) => entry.id === nodeId)
    if (!target) return false
    if (placeOutput && (!['image-collage', 'image-layer', 'image-crop', 'image-tile'].includes(target.type ?? '') || outputPlacementCoordinator.pending(nodeId))) return false
    if (target.data.status === 'running' || target.data.status === 'queued') {
      setBanner('该节点正在生成，请等待结束或先取消')
      return false
    }
    const resumeTaskId = target.data.result?.taskId
    if (resumeTaskId && resumingTaskIdsRef.current.has(resumeTaskId)) {
      setBanner('请等待该节点的视频任务续查完成后再运行')
      return false
    }
    if (target.disabled || target.type === 'unknown') {
      setBanner('该节点已禁用，不能单独运行')
      return false
    }
    if (!window.xingmangCanvasHost) {
      if (kind === 'from-node') setBanner('从此向后运行仅在桌面开发界面中可用')
      return false
    }
    try {
      const graph = toCanvasRunGraph(nodes, edges, { image: imageGroup ?? '', video: videoGroup ?? '', videoProtocol, text: textGroup ?? '', imageModel: mediaGroups.imageModel, videoModel: mediaGroups.videoModel, textModel: mediaGroups.textModel }, nodeSourceCatalogRef.current)
      const scope: CanvasRunScope = { kind, nodeId }
      const preflight = buildCanvasRunPreflight({ capabilities: canvasCapabilities(), sourceCatalog: nodeSourceCatalogRef.current,
        imageAssetDimensions,
        graph,
        scope,
        cachedNodeIds: cachedNodeIdsForPreflight(nodes, scope),
        imageGroup: imageGroup ?? undefined,
        videoGroup: videoGroup ?? undefined,
        videoProtocol,
        imageModels: mediaModelsRef.current.image,
        videoModels: mediaModelsRef.current.video,
        textGroup: textGroup ?? undefined,
        textModels: mediaModelsRef.current.text,
        nodeBlockReasons: dramaPreflightBlockReasons(nodes, edges),
      })
      if (rejectPendingMedia(preflight) || rejectUnavailableGroups(preflight)) return false
      setRunPreflight(preflight)
      if (!preflight.canStart) {
        setBanner(preflight.warnings.filter((entry) => entry.includes('：')).join('；') || '当前节点无法执行')
        return false
      }
      setPendingCanvasRun({ graph, scope, ...(placeOutput ? { outputPlacement: { nodeId, editorScope: layerEditorScope } } : {}) })
      setBanner(placeOutput ? '请确认处理范围；成功后将成品放到独立图片节点' : kind === 'from-node' ? '请确认从此向后的运行范围和额度风险' : '请确认运行到此的范围和额度风险')
      return true
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
      return false
    }
  }, [imageAssetDimensions, nodes, edges, imageGroup, videoGroup, videoProtocol, textGroup, mediaGroups.imageModel, mediaGroups.videoModel, mediaGroups.textModel, rejectPendingMedia, rejectUnavailableGroups, layerEditorScope, outputPlacementCoordinator])

  // 浏览器预览保留轻量单节点执行；桌面端始终经主进程预检和运行服务。
  const rerunNode = useCallback(async (nodeId: string) => {
    if (projectTransitionRef.current) return
    if (window.xingmangCanvasHost) {
      requestNodeScopeRun(nodeId, 'to-node')
      return
    }
    if (running || resumingTaskIdsRef.current.size > 0) return
    const target = nodes.find((entry) => entry.id === nodeId)
    if (!target || target.disabled || target.type === 'unknown') return
    const inputs: NodeInputs = {}
    for (const edge of edges) {
      if (edge.target !== nodeId) continue
      const source = nodes.find((entry) => entry.id === edge.source)
      if (!source) continue
      if (rerunTextSourceKinds.has(source.type ?? '')) {
        inputs.text = inputs.text === undefined ? source.data.prompt : `${inputs.text}\n${source.data.prompt}`
      }
      if (rerunImageSourceKinds.has(source.type ?? '') && source.data.result?.kind === 'image') {
        inputs.image ??= source.data.result
        inputs.images = [...(inputs.images ?? []), source.data.result]
      }
      if (rerunVideoSourceKinds.has(source.type ?? '') && source.data.result?.kind === 'video') {
        inputs.video ??= source.data.result
        inputs.videos = [...(inputs.videos ?? []), source.data.result]
      }
      if (rerunAudioSourceKinds.has(source.type ?? '') && source.data.result?.kind === 'audio') {
        inputs.audio ??= source.data.result
        inputs.audios = [...(inputs.audios ?? []), source.data.result]
      }
    }
    setRunning(true)
    const controller = new AbortController()
    abortRef.current = controller
    const runStartedAt = new Date().toISOString()
    patchNodeData(nodeId, { status: 'running', errorMessage: undefined, runStartedAt })
    try {
      const executors = buildExecutors()
      const result = await executors[target.type as NodeKind](toWorkflowNode(target), inputs, controller.signal)
      patchNodeData(nodeId, {
        status: 'succeeded',
        result: result.output.asset,
        costQuota: result.costQuota,
        latestAttemptDurationMs: Date.now() - Date.parse(runStartedAt),
        runStartedAt: undefined,
      })
    } catch (error) {
      patchNodeData(nodeId, {
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
        latestAttemptDurationMs: Date.now() - Date.parse(runStartedAt),
        runStartedAt: undefined,
      })
    } finally {
      abortRef.current = null
      setRunning(false)
    }
  }, [running, nodes, edges, patchNodeData, buildExecutors, requestNodeScopeRun])

  const runFromNode = useCallback((nodeId: string) => {
    requestNodeScopeRun(nodeId, 'from-node')
  }, [requestNodeScopeRun])

  const downloadNodeAsset = useCallback(async (nodeId: string) => {
    const scope = layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
    function current() { return agentMountedRef.current && draftActionsEnabledRef.current && !projectTransitionRef.current && scope === layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current }) }
    if (!current()) return
    try {
      // Run projection can publish the new result before React commits its
      // render. Resolve on click, never from the old rendered nodes closure.
      const asset = getGraphSnapshot().nodes.find((entry) => entry.id === nodeId)?.data.result
      if (!asset?.assetId) throw new Error('当前节点还没有可下载的产物，请等待处理完成')
      setBanner('正在保存产物…')
      const saved = await hostBridge().saveAsset(asset.assetId)
      if (current()) setBanner(saved.saved ? '产物已保存' : '产物尚未保存，可重新另存')
    } catch (cause) { if (current()) setBanner(cause instanceof Error ? cause.message : '产物保存失败，请稍后重试') }
  }, [getGraphSnapshot])

  const showNodeAssetMenu = useCallback(async (nodeId: string) => {
    const assetId = nodes.find((entry) => entry.id === nodeId)?.data.result?.assetId
    if (assetId) await hostBridge().showAssetMenu(assetId)
  }, [nodes])

  const currentAssetLibraryScope = useCallback(() => JSON.stringify([layerEditorOwnerRef.current.ownerId, layerEditorOwnerRef.current.accountId, activeProjectIdRef.current, projectEpochRef.current]), [])

  const refreshAssets = useCallback(async (query: CanvasAssetQuery = assetQueryRef.current): Promise<boolean> => {
    const revision = ++assetsRequestRevisionRef.current, scope = currentAssetLibraryScope()
    function current() { return agentMountedRef.current && revision === assetsRequestRevisionRef.current && scope === currentAssetLibraryScope() }
    setAssetsLoading(true)
    try {
      const page = await hostBridge().listAssets(query)
      if (!current()) return false
      assertAssetCategoryPageFilter(query, page)
      setAssetPage(page)
      setAssetCatalog((current) => {
        const merged = new Map(current.map((asset) => [asset.assetId, asset]))
        for (const asset of page.items) merged.set(asset.assetId, asset)
        return [...merged.values()]
      })
      setNodes((current) => applyCatalogClipDurationToNodes(current, page.items))
      return true
    } catch (error) {
      if (current()) setBanner(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      if (current()) setAssetsLoading(false)
    }
  }, [currentAssetLibraryScope])

  const submitCanvasAssetMutation = useCallback(async (input: AssetMutationInput, signal?: AbortSignal): Promise<AssetMutationResult> => {
    const scope = currentAssetLibraryScope(), query = JSON.stringify(assetQueryRef.current), queryGeneration = assetQueryGenerationRef.current, token = {}, controller = new AbortController()
    if (!agentMountedRef.current || !draftActionsEnabledRef.current || !hostBridge().manageAssetMutations || !hostBridge().inspectAssetMutationOperation) throw new Error('当前宿主或账号不支持可恢复素材整理，请更新或重新登录；本次没有提交')
    if (assetMutationPendingRef.current?.scope === scope) throw new Error('已有素材整理操作正在进行，请稍候或核对原操作')
    assetMutationPendingRef.current = { scope, token, controller }
    function current() { return agentMountedRef.current && draftActionsEnabledRef.current && scope === currentAssetLibraryScope() && queryGeneration === assetQueryGenerationRef.current && query === JSON.stringify(assetQueryRef.current) && assetMutationPendingRef.current?.token === token && !controller.signal.aborted && !signal?.aborted }
    try {
      const result = await assetMutationRecovery.submit(input, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal)
      if (!current()) throw new Error('素材视图或账号已变化，原操作记录仍保留；请在操作记录中核对')
      setBanner('素材操作已确认，可在操作记录中核对与撤销原改动')
      await refreshAssets()
      if (!current()) throw new Error('素材视图已变化，原操作回执保留在操作记录中')
      return result
    } finally { if (assetMutationPendingRef.current?.token === token) assetMutationPendingRef.current = null }
  }, [currentAssetLibraryScope, refreshAssets, assetMutationRecovery.submit])

  const renameCanvasAsset = useCallback(async (assetId: string, displayName: string) => {
    const result = await submitCanvasAssetMutation({ operationId: crypto.randomUUID(), action: 'rename', assetId, displayName })
    if (result.outcomes[0].state !== 'succeeded') throw new Error(result.outcomes[0].message)
  }, [submitCanvasAssetMutation])

  const updateCanvasAssetMetadata = useCallback(async (assetId: string, input: { favorite?: boolean; tags?: string[] }) => {
    const request: AssetMutationInput = input.tags !== undefined
      ? { operationId: crypto.randomUUID(), action: 'tags', assetIds: [assetId], tags: [...input.tags] }
      : { operationId: crypto.randomUUID(), action: input.favorite ? 'favorite' : 'unfavorite', assetIds: [assetId] }
    const result = await submitCanvasAssetMutation(request)
    if (result.outcomes[0].state !== 'succeeded') throw new Error(result.outcomes[0].message)
  }, [submitCanvasAssetMutation])

  const favoriteCanvasAssets = useCallback((assetIds: readonly string[], favorite: boolean) => submitCanvasAssetMutation({ operationId: crypto.randomUUID(), action: favorite ? 'favorite' : 'unfavorite', assetIds: [...assetIds] }), [submitCanvasAssetMutation])

  // The old desktop canvas's direct writes, kept for a desktop without the
  // recoverable pair. A reply that lands after the library has moved to another
  // project or account is not patched into that view; it reads its own page.
  const renameCanvasAssetDirectly = useCallback(async (assetId: string, displayName: string) => {
    const scope = currentAssetLibraryScope()
    const renamed = await hostBridge().renameAsset({ assetId, displayName })
    if (!agentMountedRef.current || scope !== currentAssetLibraryScope()) return
    const apply = <T extends CanvasAssetSummary>(asset: T): T => (asset.assetId === renamed.assetId ? { ...asset, displayName: renamed.displayName } : asset) as T
    setAssetPage((current) => ({ ...current, items: current.items.map(apply) }))
    setAssetCatalog((current) => current.map(apply))
    setBanner('素材名称已更新')
    void refreshAssets()
  }, [currentAssetLibraryScope, refreshAssets])

  const updateCanvasAssetMetadataDirectly = useCallback(async (assetId: string, input: { favorite?: boolean; tags?: string[] }) => {
    // The desktop main process still checks the old canvas's tag limits, not the kernel's 20 and 40.
    const tags = input.tags
    if (tags && (tags.length > 12 || tags.some((tag) => tag.length > 32) || new Set(tags.map((tag) => tag.toLocaleLowerCase('zh-CN'))).size !== tags.length)) throw new Error('最多 12 个不重复标签，每个不超过 32 个字符')
    const scope = currentAssetLibraryScope()
    const updated = await hostBridge().updateAssetMetadata({ assetId, ...input })
    if (!agentMountedRef.current || scope !== currentAssetLibraryScope()) return
    const apply = <T extends CanvasAssetSummary>(asset: T): T => (asset.assetId === updated.assetId
      ? { ...asset, favorite: updated.favorite, tags: [...updated.tags], ...(updated.lastUsedAt ? { lastUsedAt: updated.lastUsedAt } : {}) }
      : asset) as T
    setAssetPage((current) => ({ ...current, items: current.items.map(apply) }))
    setAssetCatalog((current) => current.map(apply))
    setBanner(input.favorite === true ? '已收藏素材' : input.favorite === false ? '已取消收藏' : '素材标签已更新')
    void refreshAssets()
  }, [currentAssetLibraryScope, refreshAssets])

  const markCanvasAssetUsed = useCallback(async (assetId: string) => {
    try {
      const updated = await hostBridge().markAssetUsed(assetId)
      const apply = <T extends CanvasAssetSummary>(asset: T): T => (asset.assetId === updated.assetId ? { ...asset, lastUsedAt: updated.lastUsedAt } : asset) as T
      setAssetPage((current) => ({ ...current, items: current.items.map(apply) }))
      setAssetCatalog((current) => current.map(apply))
    } catch {
      // Usage ranking is auxiliary; a metadata write must not block canvas editing.
    }
  }, [])

  const mutateCanvasAssets = useCallback(async (action: CanvasAssetMutationAction, assetIds: readonly string[], content = ''): Promise<CanvasAssetMutationResult> => {
    if (action !== 'purge' && !directAssetMutations) {
      const result = await submitCanvasAssetMutation({ operationId: crypto.randomUUID(), action, assetIds: [...assetIds] })
      return { action, outcomes: result.outcomes.map((item) => ({ assetId: item.assetId, state: item.state, message: item.message })) }
    }
    const scope = currentAssetLibraryScope(), query = JSON.stringify(assetQueryRef.current), queryGeneration = assetQueryGenerationRef.current, token = {}
    if (assetMutationPendingRef.current?.scope === scope) throw new Error('已有素材整理操作正在进行，请稍候')
    assetMutationPendingRef.current = { scope, token }
    function current() { return agentMountedRef.current && scope === currentAssetLibraryScope() && queryGeneration === assetQueryGenerationRef.current && query === JSON.stringify(assetQueryRef.current) && assetMutationPendingRef.current?.token === token }
    try {
      const bridge = hostBridge()
      const result = await runCanvasAssetMutationBatch({ action, ids: assetIds, current, perform: (assetId) => action === 'delete' ? bridge.deleteAsset(assetId) : action === 'restore' ? bridge.restoreAsset(assetId) : bridge.purgeAsset(assetId, content) })
      // Refresh even when only some writes succeeded. Page totals, tags and
      // recycle-bin membership must all come from the same confirmed query.
      if (current() && !await refreshAssets() && current()) result.refreshError = '素材操作已结束，但列表读取未完成；请刷新核对，未确认项仍保留'
      return result
    } finally { if (assetMutationPendingRef.current?.token === token) assetMutationPendingRef.current = null }
  }, [currentAssetLibraryScope, refreshAssets, submitCanvasAssetMutation, directAssetMutations])

  const deleteCanvasAssets = useCallback((assetIds: readonly string[]) => mutateCanvasAssets('delete', assetIds), [mutateCanvasAssets])
  const restoreCanvasAssets = useCallback((assetIds: readonly string[]) => mutateCanvasAssets('restore', assetIds), [mutateCanvasAssets])
  const purgeCanvasAssets = useCallback((assetIds: readonly string[], content: string) => mutateCanvasAssets('purge', assetIds, content), [mutateCanvasAssets])

  useEffect(() => {
    if (!window.xingmangCanvasHost) {
      void refreshAssets({ offset: 0, limit: 24, mediaType: 'all' })
    }
  }, [refreshAssets])

  useEffect(() => {
    if (!window.xingmangCanvasHost) return
    let active = true
    const revision = ++assetsRequestRevisionRef.current, scope = currentAssetLibraryScope()
    function current() { return active && agentMountedRef.current && revision === assetsRequestRevisionRef.current && scope === currentAssetLibraryScope() }
    const query = { offset: 0, limit: 24, mediaType: 'all' as const, search: '', view: 'all' as const, source: 'all' as const, sort: 'created-desc' as const, tag: '' }
    assetQueryGenerationRef.current++
    assetQueryRef.current = query
    setAssetQuery(query)
    setAssetPage(emptyCanvasAssetPage())
    setAssetCatalog([])
    if (!activeProject) { setAssetsLoading(false); return () => { active = false } }
    setAssetsLoading(true)
    void hostBridge().listAssets(query).then((page) => {
      if (!current()) return
      setAssetPage(page)
      setAssetCatalog((current) => {
        const pageIds = new Set(page.items.map((asset) => asset.assetId))
        return [...current.filter((asset) => !pageIds.has(asset.assetId)), ...page.items]
      })
      setNodes((current) => applyCatalogClipDurationToNodes(current, page.items))
    }).catch((error) => {
      if (current()) setBanner(error instanceof Error ? error.message : String(error))
    }).finally(() => {
      if (current()) setAssetsLoading(false)
    })
    return () => { active = false }
  }, [activeProject?.id, runRecoveryRevision, currentAssetLibraryScope])

  // Gallery batches can mix media. Resolve their saved references independently
  // of the newest library page; never guess a missing candidate's media kind.
  const galleryCandidateAssetIds = collectGalleryCandidateAssetIds(nodes).join('|')
  useEffect(() => {
    if (!galleryCandidateAssetIds || !activeProject?.id) return
    const host = hostBridge()
    if (!host.getAssetDetail) return
    const controller = new AbortController(), epoch = projectEpochRef.current
    const known = new Set(assetCatalog.map((asset) => asset.assetId))
    const pending = galleryCandidateAssetIds.split('|').filter((id) => /^[A-Za-z0-9_-]{43}$/.test(id) && !known.has(id)).slice(0, 128)
    let cursor = 0, unavailable = 0
    async function read() {
      while (cursor < pending.length && !controller.signal.aborted) {
        const id = pending[cursor++]
        try {
          const asset = await host.getAssetDetail!(id, controller.signal)
          if (controller.signal.aborted || projectEpochRef.current !== epoch) return
          if (asset.deletedAt || asset.assetId !== id) { unavailable++; continue }
          setAssetCatalog((current) => [...current.filter((item) => item.assetId !== id), asset])
        } catch { if (!controller.signal.aborted) unavailable++ }
      }
    }
    void Promise.all(Array.from({ length: Math.min(4, pending.length) }, read)).then(() => {
      if (unavailable && !controller.signal.aborted && projectEpochRef.current === epoch) setBanner('部分画廊素材暂不可读取，已保留原顺序；可重新选择此节点重试')
    })
    return () => controller.abort()
  }, [galleryCandidateAssetIds, activeProject?.id, runRecoveryRevision, layerEditorScope])

  const createPromptPreset = useCallback(async (input: PromptPresetInput): Promise<CanvasPromptPreset> => {
    if (!draftActionsEnabled || !promptCatalog.active()) throw new Error('账户已变化，请重新进入工作区后管理提示词。')
    const scope = promptCatalog.scope()
    const preset = await hostBridge().createPromptPreset(promptPresetInputForHost(input, canvasCapabilities()))
    if (!promptCatalog.current(scope)) throw new Error('账户已变化，提示词回执未应用。请重新进入工作区核对。')
    promptCatalog.upsert(preset)
    return preset
  }, [draftActionsEnabled, promptCatalog])

  const savePromptPreset = useCallback(async (nodeId: string) => {
    const prompt = nodes.find((node) => node.id === nodeId)?.data.prompt
    if (!prompt?.trim()) return
    if (prompt.length > maximumPromptPresetLength) { setBanner(`提示词预设最多 ${maximumPromptPresetLength} 字，当前画布正文已保留，请缩短后再保存为预设。`); return }
    const firstLine = prompt.split(/\r?\n/, 1)[0].trim()
    try {
      await createPromptPreset({ name: firstLine.slice(0, 60) || '未命名提示词', prompt })
      setBanner('已保存到「创作库 / 提示词」')
    } catch (error) { setBanner(error instanceof Error ? error.message : String(error)) }
  }, [nodes, createPromptPreset])

  const captureTextSession = useCallback((nodeId: string, selection: TextOutputSelection): CanvasTextSession => {
    if (!mediaPreparationMountedRef.current || !draftActionsEnabledRef.current || projectTransitionRef.current) throw new Error('工程正在切换，请稍后打开文字')
    const node = getGraphSnapshot().nodes.find((entry) => entry.id === nodeId)
    if (!node || !['text', 'prompt', 'text-generate', 'output'].includes(node.type ?? '') || node.type === 'output' && selection !== 'result') throw new Error('请选择文字节点或输出节点的文字结果')
    const output = inspectNodeTextOutput(node.type ?? '', node.data, selection, canvasCapabilities().features.fileDownload)
    if (selection === 'result' && !output.available) throw new Error(output.reason || '请先生成文字')
    const scope = layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
    const title = typeof node.data.settings?.title === 'string' ? node.data.settings.title : node.type === 'text-generate' ? '文字生成' : node.type === 'output' ? '输出' : '文本输入'
    const notice = selection === 'result'
      ? output.running ? '正在生成新内容；这里保留的是上次结果。' : output.stale ? '输入已变化；这里保留的是上次生成结果。' : node.data.status === 'failed' ? '上次运行失败；这里保留的是之前成功生成的结果。' : '生成结果单独保留。另存为文本节点后，可编辑并连接到下一步。'
      : node.data.promptReferences?.length ? '此处编辑完整正文。保存修改后，引用标签会展开为普通文字。' : '编辑正文不会提交模型请求；保存后可继续连接下游或复用到工坊。'
    return { id: nextNodeId(), nodeId, kind: node.type ?? '', selection, title: `${title} · ${selection === 'result' ? node.type === 'output' ? '文字结果' : '生成结果' : '正文'}`, value: output.text, references: JSON.stringify(node.data.promptReferences ?? []), scope, notice }
  }, [getGraphSnapshot])

  const performTextAction = useCallback(async (session: CanvasTextSession, action: 'copy' | 'download' | 'place' | 'preset' | 'save', text: string, signal: AbortSignal) => {
    function assertScope() {
      signal.throwIfAborted()
      if (!mediaPreparationMountedRef.current) throw new Error('文字编辑会话已关闭')
      assertLayerEditorScope(session.scope, { ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
      if (projectTransitionRef.current) throw new Error('工程正在切换，请稍后操作文字')
    }
    function current() {
      assertScope()
      assertTextDraft(text)
      if (session.selection === 'result' && text !== session.value) throw new Error('生成结果不可直接覆盖，请另存为文本节点后编辑')
      return assertTextSessionNode(getGraphSnapshot().nodes, session)
    }
    assertScope()
    assertTextDraft(text)
    if (session.selection === 'result' && text !== session.value) throw new Error('生成结果不可直接覆盖，请另存为文本节点后编辑')
    if (action === 'copy') {
      if (!text.trim()) throw new Error('没有可复制的文字')
      if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不能复制，请下载 TXT 或选择正文手动复制')
      await navigator.clipboard.writeText(text)
      assertScope()
      setBanner('已复制完整正文')
      return
    }
    if (action === 'download') {
      if (!text.trim()) throw new Error('没有可下载的文字')
      downloadCanvasText(text, session.title)
      setBanner('已下载完整 TXT 正文')
      return
    }
    const node = current()
    const output = inspectNodeTextOutput(node.type ?? '', node.data, session.selection, canvasCapabilities().features.fileDownload)
    if (activeRunsRef.current.size || startingRunsRef.current || pendingRunProjectionIdsRef.current.size) throw new Error('请等待当前运行结束后再保存或复用文字；可先复制或下载上次结果')
    if (action === 'save') {
      if (session.selection !== 'input') throw new Error('请先将结果另存为文本节点')
      if (!projectCanEditRef.current) throw new Error('当前协作正在同步或等待核对，文字仍保留在编辑窗口；请等待完成后再保存。')
      if (text !== session.value) applyPromptDraft(session.nodeId, text, true, [], session.scope)
      setBanner('文字已保存，可一步撤销')
      return
    }
    if (action === 'place') {
      if (!output.canPlace) throw new Error(output.reason || '当前结果暂不能另存')
      if (!projectCanEditRef.current) throw new Error('当前项目暂不可编辑，请保留文字，协作核对完成后再另存节点。')
      const graph = getGraphSnapshot()
      const command = buildOutputTextNode(graph.nodes.map(canvasNodeDocumentRecord), session.nodeId, session.selection, nextNodeId())
      execute(command)
      graphRef.current = getGraphSnapshot()
      const added = new Set(command.nodes.map((entry) => entry.id))
      setNodes((entries) => entries.map((entry) => ({ ...entry, selected: added.has(entry.id) })))
      window.requestAnimationFrame(() => {
        const scope = layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
        if (!mediaPreparationMountedRef.current || !draftActionsEnabledRef.current || projectTransitionRef.current || scope !== session.scope) return
        const currentNodes = getGraphSnapshot().nodes
        if (![...added].every((id) => currentNodes.some((entry) => entry.id === id))) return
        void reactFlow.fitView({ nodes: [...added].map((id) => ({ id })), padding: 0.3, duration: 180, maxZoom: 1 })
      })
      setBanner('已另存为独立文本节点，原结果保留；可一步撤销')
      return
    }
    const key = `${session.scope}:${session.nodeId}:${action}`
    if (textActionPendingRef.current.has(key)) throw new Error('此文字正在保存，请勿重复提交')
    textActionPendingRef.current.add(key)
    try {
      const downloadable = canvasCapabilities().features.fileDownload
      const snapshot = inspectNodeTextOutput(node.type ?? '', { ...node.data, ...(session.selection === 'result' ? { outputText: text } : { prompt: text }) }, session.selection, downloadable)
      const input = textOutputPresetInput(snapshot, session.title.slice(0, canvasCapabilities().promptPresets.nameMaxLength), downloadable)
      const uncertain = textActionUncertainRef.current.get(key)
      if (uncertain) {
        await promptCatalog.load(true)
        current()
        const catalog = promptCatalog.snapshot()
        if (catalog.loading || catalog.error || !catalog.loaded) throw new Error('上次保存结果仍待核对，请稍后重试读取，或进入创意工坊核对；不会重复提交')
        if (!catalog.items.some((item) => item.name === uncertain.name && item.prompt === uncertain.prompt)) throw new Error('目录暂未确认上次保存，请到创意工坊核对后再处理；不会自动重复提交，正文可复制或下载')
        textActionUncertainRef.current.delete(key)
        if (input.name !== uncertain.name || input.prompt !== uncertain.prompt) throw new Error('上次正文已确认保存；当前修改尚未保存，请再次点击保存')
        setBanner('已在创意工坊确认上次保存的正文，没有重复创建')
        return
      }
      try { await createPromptPreset(input) } catch (cause) {
        const failure = promptPresetSaveFailure(cause, false)
        if (failure.kind === 'uncertain') textActionUncertainRef.current.set(key, input)
        throw new Error(failure.message)
      }
      // A confirmed write stays successful even if a new model result arrives.
      // Only the current account/project may receive its completion message.
      try { assertScope() } catch { return }
      setBanner('已将正文保存到「创意工坊 / 我的提示词」')
    } finally { textActionPendingRef.current.delete(key) }
  }, [getGraphSnapshot, applyPromptDraft, execute, setNodes, createPromptPreset, promptCatalog, reactFlow])

  const textNodeAction = useCallback((nodeId: string, selection: TextOutputSelection, action: 'open' | 'copy' | 'download' | 'place' | 'preset') => {
    try {
      const session = captureTextSession(nodeId, selection)
      if (action === 'open') { setTextSession(session); return }
      void performTextAction(session, action, session.value, new AbortController().signal).catch((cause) => {
        const scope = layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
        if (mediaPreparationMountedRef.current && scope === session.scope) setBanner(cause instanceof Error ? cause.message : '文字操作未完成，请重试')
      })
    } catch (cause) { setBanner(cause instanceof Error ? cause.message : '文字节点暂不可用') }
  }, [captureTextSession, performTextAction])

  const deletePromptPreset = useCallback(async (id: string, expectedVersion?: number) => {
    try {
      if (!draftActionsEnabled || !promptCatalog.active()) throw new Error('账户已变化，请重新进入工作区。')
      const scope = promptCatalog.scope()
      if (await hostBridge().deletePromptPreset(id, expectedVersion ?? promptCatalog.snapshot().items.find((item) => item.id === id)?.version)) {
        if (!promptCatalog.current(scope)) return
        promptCatalog.remove(id)
        setBanner('提示词预设已删除')
      } else throw new Error('提示词已删除或不可读取，请刷新目录核对。')
    } catch (error) { setBanner(error instanceof Error ? error.message : String(error)); throw error }
  }, [draftActionsEnabled, promptCatalog])

  const updatePromptPreset = useCallback(async (id: string, patch: Omit<PromptPresetUpdateInput, 'id'>) => {
    try {
      if (!draftActionsEnabled || !promptCatalog.active()) throw new Error('账户已变化，请重新进入工作区。')
      const scope = promptCatalog.scope()
      const updated = await hostBridge().updatePromptPreset(promptPresetUpdateForHost({ id, ...patch }, canvasCapabilities()))
      if (!promptCatalog.current(scope)) throw new Error('账户已变化，请重新进入工作区核对保存结果。')
      promptCatalog.upsert(updated)
      setBanner('提示词预设已更新')
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
      throw error
    }
  }, [draftActionsEnabled, promptCatalog])

  const updateCatalogPrompt = useCallback(async (input: PromptPresetUpdateInput) => { const { id, ...patch } = input; await updatePromptPreset(id, patch) }, [updatePromptPreset])
  const reorderCatalogPrompts = useCallback(async (input: PromptPresetOrderInput) => {
    const host = hostBridge()
    if (!draftActionsEnabled || !promptCatalog.active() || !host.reorderPromptPresets) throw new Error('当前宿主暂不支持提示词排序。')
    const scope = promptCatalog.scope()
    const receipt = await host.reorderPromptPresets(input)
    if (!promptCatalog.current(scope)) throw new Error('账户已变化，排序回执未应用。')
    promptCatalog.reordered(receipt)
  }, [draftActionsEnabled, promptCatalog])
  const promptCatalogValue = useMemo(() => ({ ...promptCatalogSnapshot, enabled: draftActionsEnabled, load: promptCatalog.load, create: createPromptPreset, update: updateCatalogPrompt, remove: deletePromptPreset, reorder: hostBridge().reorderPromptPresets ? reorderCatalogPrompts : undefined, nameMaxLength: canvasCapabilities().promptPresets.nameMaxLength, metadata: canvasCapabilities().features.promptPresetGroups }), [promptCatalogSnapshot, draftActionsEnabled, promptCatalog, createPromptPreset, updateCatalogPrompt, deletePromptPreset, reorderCatalogPrompts])

  const changeAssetQuery = useCallback((query: CanvasAssetQuery) => {
    const next = {
      offset: query.offset ?? 0,
      limit: query.limit ?? 24,
      mediaType: query.mediaType ?? 'all',
      search: query.search ?? '',
      view: query.view ?? 'all',
      tag: query.tag ?? '',
      source: query.source ?? 'all',
      sort: query.sort ?? (query.view === 'recent' ? 'used-desc' : 'created-desc'),
      ...(query.categoryId !== undefined ? { categoryId: query.categoryId } : {}),
      // Find-similar filters are absent rather than empty when off: the host
      // contract treats an empty prompt or identifier as a parse error.
      ...(query.prompt ? { prompt: query.prompt } : {}),
      ...(query.runId ? { runId: query.runId } : {}),
      ...(query.nodeId ? { nodeId: query.nodeId } : {}),
    }
    assetMutationPendingRef.current?.controller?.abort()
    assetQueryGenerationRef.current++
    assetQueryRef.current = next
    setAssetQuery(next)
    void refreshAssets(next)
  }, [refreshAssets])

  const currentAssetCategoryOwnerScope = useCallback(() => JSON.stringify([layerEditorOwnerRef.current.ownerId, layerEditorOwnerRef.current.accountId]), [])
  const readAssetCategories = useCallback(async (caller?: AbortSignal): Promise<AssetCategoryDirectory> => {
    const bridge = hostBridge(), scope = currentAssetCategoryOwnerScope(), revision = ++assetCategoryReadRef.current.revision, controller = new AbortController()
    assetCategoryReadRef.current.controller?.abort(); assetCategoryReadRef.current.controller = controller
    function current() { return agentMountedRef.current && scope === currentAssetCategoryOwnerScope() && revision === assetCategoryReadRef.current.revision && !controller.signal.aborted && !caller?.aborted }
    setAssetCategoryState((previous) => ({ scope, directory: previous.scope === scope ? previous.directory : null, loading: true, error: '' }))
    try {
      if (!bridge.listAssetCategories) throw new Error('当前宿主暂不支持个人素材分类')
      const directory = await bridge.listAssetCategories(caller ? AbortSignal.any([caller, controller.signal]) : controller.signal)
      if (!current()) throw new Error('素材分类会话已变化，请重新读取')
      setAssetCategoryState({ scope, directory, loading: false, error: '' })
      const query = assetQueryRef.current
      if (typeof query.categoryId === 'string' && !directory.items.some((item) => item.id === query.categoryId)) changeAssetQuery({ ...query, offset: 0, categoryId: null })
      return directory
    } catch (cause) {
      if (current()) setAssetCategoryState((previous) => ({ scope, directory: previous.scope === scope ? previous.directory : null, loading: false, error: cause instanceof Error ? cause.message : '素材分类读取未完成' }))
      throw cause
    }
  }, [changeAssetQuery, currentAssetCategoryOwnerScope])
  useEffect(() => {
    assetCategoryReadRef.current.revision++; assetCategoryReadRef.current.controller?.abort()
    setAssetCategoryDialog(null)
    if (assetCategorySupported && draftActionsEnabled) void readAssetCategories().catch(() => undefined)
    return () => { assetCategoryReadRef.current.revision++; assetCategoryReadRef.current.controller?.abort() }
  }, [assetCategoryOwnerScope, assetCategorySupported, draftActionsEnabled, readAssetCategories])
  useEffect(() => {
    if (!assetCategorySupported || !assetTrayOpen || inspectorTab !== 'assets') return
    function refreshVisibleLibrary() {
      if (document.visibilityState !== 'visible') return
      void readAssetCategories().catch(() => undefined)
      void refreshAssets()
    }
    window.addEventListener('focus', refreshVisibleLibrary); document.addEventListener('visibilitychange', refreshVisibleLibrary)
    return () => { window.removeEventListener('focus', refreshVisibleLibrary); document.removeEventListener('visibilitychange', refreshVisibleLibrary) }
  }, [assetCategorySupported, assetTrayOpen, inspectorTab, readAssetCategories, refreshAssets])
  const openAssetCategoryManager = useCallback(() => {
    const scope = currentAssetCategoryOwnerScope()
    setAssetCategoryDialog({ scope, kind: assetCategoryRecovery.pending?.action === 'move' ? 'move' : 'manage' })
    void readAssetCategories().catch(() => undefined)
  }, [assetCategoryRecovery.pending, currentAssetCategoryOwnerScope, readAssetCategories])
  const openAssetCategoryMove = useCallback((assetIds: readonly string[]) => {
    const scope = currentAssetCategoryOwnerScope()
    if (assetCategoryRecovery.pending) { openAssetCategoryManager(); return }
    const assets = assetIds.map((assetId) => {
      const asset = assetPage.items.find((item) => item.assetId === assetId)
      if (!asset) throw new Error('所选素材已不在当前列表，请刷新后重新选择')
      return { assetId, expectedOrganizationVersion: asset.organizationVersion ?? 0, displayName: asset.displayName, categoryId: asset.categoryId ?? null }
    })
    setAssetCategoryDialog({ scope, kind: 'move', assets })
  }, [assetCategoryRecovery.pending, assetPage.items, currentAssetCategoryOwnerScope, openAssetCategoryManager])
  const readAssetCategorySelections = useCallback(async (assetIds: readonly string[], signal?: AbortSignal): Promise<AssetCategoryMoveAsset[]> => {
    const scope = currentAssetCategoryOwnerScope(), bridge = hostBridge(), assets: AssetCategoryMoveAsset[] = []
    if (!bridge.getAssetDetail) throw new Error('当前宿主暂不支持重新读取素材归属')
    for (const assetId of assetIds) {
      signal?.throwIfAborted()
      const asset = await bridge.getAssetDetail(assetId, signal)
      if (!agentMountedRef.current || scope !== currentAssetCategoryOwnerScope()) throw new Error('素材账号已变化，请重新选择')
      if (asset.assetId !== assetId) throw new Error('素材资料编号不一致，请重新读取')
      assets.push({ assetId, expectedOrganizationVersion: asset.organizationVersion ?? 0, displayName: asset.displayName, categoryId: asset.categoryId ?? null })
    }
    return assets
  }, [currentAssetCategoryOwnerScope])
  const assetCategoryChanged = useCallback((result: AssetCategoryResult) => {
    if (result.action === 'move') {
      const assignments = result.assignments
      const apply = <T extends CanvasAssetSummary>(asset: T): T => { const assignment = assignments.find((item) => item.assetId === asset.assetId); return assignment ? { ...asset, categoryId: assignment.categoryId, organizationVersion: assignment.organizationVersion } : asset }
      setAssetCatalog((previous) => previous.map(apply)); setAssetPage((previous) => ({ ...previous, items: previous.items.map(apply) })); setAssetCategoryDialog(null)
      setAssetCategorySelectionRevision((revision) => revision + 1)
      setBanner(`已移动 ${assignments.length} 份素材分类`)
    } else setBanner(result.action === 'delete-category' ? `分类已删除，${result.movedAssetCount} 份素材已回到未分类` : '素材分类已保存')
    if (result.action === 'delete-category' && assetQueryRef.current.categoryId === result.categoryId) changeAssetQuery({ ...assetQueryRef.current, offset: 0, categoryId: null })
    else void refreshAssets()
    void readAssetCategories().catch(() => undefined)
  }, [changeAssetQuery, readAssetCategories, refreshAssets])
  const submitAssetCategoryOperation = useCallback(async (input: AssetCategoryInput, signal?: AbortSignal) => {
    const scope = currentAssetCategoryOwnerScope(), method = hostBridge().manageAssetCategories
    if (!method || !draftActionsEnabledRef.current) throw new Error('当前账号会话不能提交素材分类操作')
    const result = await method(input, signal)
    if (!agentMountedRef.current || scope !== currentAssetCategoryOwnerScope() || !draftActionsEnabledRef.current) throw new Error('素材账号会话已变化，请核对原分类操作')
    return result
  }, [currentAssetCategoryOwnerScope])
  const inspectAssetCategoryOperation = useCallback(async (input: AssetCategoryInput, signal?: AbortSignal) => {
    const scope = currentAssetCategoryOwnerScope(), method = hostBridge().inspectAssetCategoryOperation
    if (!method || !draftActionsEnabledRef.current) throw new Error('当前账号会话不能核对素材分类操作')
    const result = await method(input, signal)
    if (!agentMountedRef.current || scope !== currentAssetCategoryOwnerScope() || !draftActionsEnabledRef.current) throw new Error('素材账号会话已变化，请重新核对')
    return result
  }, [currentAssetCategoryOwnerScope])
  const currentAssetCategoryUploadTarget = useCallback((): AssetCategoryUploadTarget | undefined => {
    const categoryId = assetQueryRef.current.categoryId
    if (categoryId === undefined) return undefined
    if (categoryId === null) return { categoryId: null }
    const state = assetCategoryStateRef.current
    const category = state.scope === currentAssetCategoryOwnerScope() ? state.directory?.items.find((item) => item.id === categoryId) : null
    if (!category || state.loading || state.error) throw new Error('请先刷新并确认当前素材分类，再导入文件')
    return { categoryId, expectedCategoryVersion: category.version }
  }, [currentAssetCategoryOwnerScope])

  const refreshRuns = useCallback(async (projectRunId?: string) => {
    if (!window.xingmangCanvasHost || !projectCanRunRef.current) return
    if (projectRunId) pendingRunProjectionIdsRef.current.add(projectRunId)
    const revision = ++runsRequestRevisionRef.current
    const projectEpoch = projectEpochRef.current
    const projectId = activeProjectIdRef.current
    let recoveredRunning = false
    setRunsLoading(true)
    setRunsError(null)
    try {
      const bridge = hostBridge()
      const listed = await bridge.listRuns()
      if (projectEpochRef.current !== projectEpoch || runsRequestRevisionRef.current !== revision) return
      const records = listed.filter((record) => !record.projectId || record.projectId === projectId)
      for (const record of records) outputPlacementCoordinator.accept(record)
      // Register before reading the snapshot: terminal events may arrive while
      // the original input graph is being fetched after a browser reload.
      for (const record of records) {
        if (record.purpose === 'agent-plan') continue
        if (record.status === 'running' && record.projectId === projectId && !activeRunsRef.current.has(record.runId)) {
          rememberActiveRun({ ...record, scope: record.scope })
          recoveredRunning = true
        }
        if (record.status !== 'running' && activeRunsRef.current.has(record.runId)) forgetActiveRun(record.runId)
      }
      // A durable terminal snapshot can win the race against the event stream.
      // Once its active entry is removed, the later terminal event is ignored;
      // settle only this run's still-visible waiting notice here as well.
      const waitingNotice = runWaitingBannerRef.current
      const finishedWaitingRun = waitingNotice && records.find((record) => record.purpose !== 'agent-plan' && record.runId === waitingNotice.runId && record.graphRevision === waitingNotice.graphRevision && record.status !== 'running')
      if (finishedWaitingRun && waitingNotice) {
        runWaitingBannerRef.current = null
        const remaining = activeRunsRef.current.size
        const message = `运行结束：${canvasRunStatusLabel(finishedWaitingRun.status)}${remaining ? `（还有 ${remaining} 个任务在生成）` : ''}`
        setBanner((current) => current === waitingNotice.message ? message : current)
      }
      for (const record of records) {
        if (record.purpose === 'agent-plan') continue
        if (!pendingRunProjectionIdsRef.current.has(record.runId) || runInputGraphsRef.current.has(record.runId) || !bridge.getRunInputGraph) continue
        try {
          const submitted = await bridge.getRunInputGraph(record.runId)
          if (projectEpochRef.current !== projectEpoch) return
          runInputGraphsRef.current.set(record.runId, submitted)
        } catch (error) {
          if (runsRequestRevisionRef.current === revision) setRunsError(error instanceof Error ? `运行输入读取失败：${error.message}` : '运行输入读取失败，请刷新历史重试')
        }
      }
      if (projectEpochRef.current !== projectEpoch || runsRequestRevisionRef.current !== revision) return
      setRunRecords(records)
      const pendingRecords = records.filter((record) => record.purpose !== 'agent-plan' && pendingRunProjectionIdsRef.current.has(record.runId))
      if (pendingRecords.length > 0) {
        for (const completed of [...pendingRecords].reverse()) {
          setSelectedRunId(completed.runId)
          const graph = graphRef.current
          const submitted = runInputGraphsRef.current.get(completed.runId)
          if (!submitted && bridge.getRunInputGraph) continue
          // A cold catalog has no confirmed source protocol yet. Treating its
          // temporary relay default as a user edit would consume a native
          // terminal result before the source read finishes.
          if (submitted && (!groupsLoadedRef.current && submitted.nodes.some((node) => node.kind === 'video' || node.kind === 'video-generate') || awaitingCanvasFixedVideoSources(graph.nodes, submitted, nodeSourceCatalogRef.current))) {
            if (completed.status !== 'running') setRunsError('运行结果已保留，等待视频来源核对后回填；可刷新模型来源重试')
            continue
          }
          const matchingIds = submitted
            ? matchingCanvasRunNodeIds(submitted, toCanvasRunGraph(graph.nodes, graph.edges, confirmedRunGroups(), nodeSourceCatalogRef.current), completed)
            : new Set<string>()
          const matchingRecord = matchingRunRecordNodes(completed, matchingIds)
          setNodes((current) => {
            const currentMatchingIds = submitted
              ? matchingCanvasRunNodeIds(submitted, toCanvasRunGraph(current, graph.edges, confirmedRunGroups(), nodeSourceCatalogRef.current), completed)
              : new Set<string>()
            let projected = projectRunRecordToNodes(current, completed, graph.edges, currentMatchingIds)
            for (const record of completed.nodes) {
              if (!currentMatchingIds.has(record.nodeId)) continue
              if (isDramaAssetNodeType(record.kind) && (record.state === 'succeeded' || record.state === 'cached')) {
                projected = markDownstreamShotsStale(projected, graph.edges, record.nodeId) as typeof projected
              }
              if (record.kind !== 'drama-parse' || (record.state !== 'succeeded' && record.state !== 'cached')) continue
              const outputText = [...record.attempts].reverse().find((attempt) => attempt.outputText)?.outputText
              if (!outputText) continue
              try { setDramaParseConfirm({ nodeId: record.nodeId, tables: parseDramaTablesJson(outputText).tables }) }
              catch { setBanner('剧本已解析，但结果无法转成四表，请重试') }
            }
            return projected
          })
          setDirtyNodeIds((current) => {
            const next = new Set(current)
            for (const record of completed.nodes) {
              if (matchingIds.has(record.nodeId) && (record.state === 'succeeded' || record.state === 'cached')) next.delete(record.nodeId)
              else next.add(record.nodeId)
            }
            for (const nodeId of autoFixedDownstreamNodeIds(graph.nodes, matchingRecord, graph.edges)) next.add(nodeId)
            return next
          })
          if (completed.status !== 'running') {
            pendingRunProjectionIdsRef.current.delete(completed.runId)
            runInputGraphsRef.current.delete(completed.runId)
            if (completed.nodes.some((record) => !matchingIds.has(record.nodeId))) setBanner('输入已变化，旧运行结果保留在候选和运行历史中；当前节点仍待重新运行')
          }
        }
      } else if (!selectedRunId && records[0]) setSelectedRunId(records[0].runId)
    } catch (error) {
      if (runsRequestRevisionRef.current === revision) setRunsError(error instanceof Error ? error.message : String(error))
    } finally {
      if (runsRequestRevisionRef.current === revision) setRunsLoading(false)
      // listRuns starts the server monitor. A fast terminal can arrive before
      // the restored map entry exists, so reconcile history once after recovery.
      if (recoveredRunning && projectEpochRef.current === projectEpoch) window.setTimeout(() => { void refreshRunsRef.current() }, 0)
    }
  }, [confirmedRunGroups, forgetActiveRun, rememberActiveRun, selectedRunId, setNodes, outputPlacementCoordinator])

  const refreshRunsRef = useRef(refreshRuns)
  refreshRunsRef.current = refreshRuns

  useEffect(function retryPendingRunProjectionAfterCatalog() {
    // This runs after the render updates runGroupsRef with the known protocol.
    // Project epochs in refreshRuns still reject replies from a previous canvas.
    if (!groupsLoaded || !pendingRunProjectionIdsRef.current.size) return
    void refreshRunsRef.current()
  }, [groupsLoaded, catalogReadRevision, videoProtocol, nodeSourceCatalog])

  useEffect(() => {
    if (!window.xingmangCanvasHost || !activeProject) return
    void refreshRunsRef.current()
  }, [activeProject?.id])

  const openInspectorTab = useCallback((tab: CanvasInspectorTab) => {
    setAgentOpen(false)
    if (focusMode && tab !== 'node') setFocusMode(false)
    setInspectorTab(tab)
    if (tab === 'assets') {
      setRunInspectorOpen(false)
      setAssetTrayOpen(true)
      void refreshAssets()
    } else if (tab === 'runs') {
      setAssetTrayOpen(false)
      setRunInspectorOpen(true)
      void refreshRuns()
    } else {
      setAssetTrayOpen(false)
      setRunInspectorOpen(false)
      setNodeInspectorOpen(true)
    }
  }, [focusMode, refreshAssets, refreshRuns])

  const closeInspector = useCallback(() => {
    if (inspectorTab === 'assets') setAssetTrayOpen(false)
    else if (inspectorTab === 'runs') setRunInspectorOpen(false)
    else setNodeInspectorOpen(false)
  }, [inspectorTab])

  const locateNode = useCallback((nodeId: string) => {
    const target = nodes.find((node) => node.id === nodeId)
    if (!target) {
      setBanner('节点已不在当前画布中')
      return
    }
    setNodes((current) => current.map((node) => ({ ...node, selected: node.id === nodeId })))
    setInspectorTab('node')
    setAssetTrayOpen(false)
    setRunInspectorOpen(false)
    setNodeInspectorOpen(true)
    fitCanvasNodes([nodeId], 1.15)
  }, [nodes, fitCanvasNodes, setNodes])

  const showAssetTray = useCallback(() => {
    setUiPreferences((current) => ({ ...current, libraryCollapsed: true }))
    openInspectorTab('assets')
  }, [openInspectorTab])

  const toggleAssetTray = useCallback(() => {
    if (inspectorTab === 'assets' && assetTrayOpen) closeInspector()
    else showAssetTray()
  }, [assetTrayOpen, closeInspector, inspectorTab, showAssetTray])

  const toggleRunInspector = useCallback(() => {
    if (inspectorTab === 'runs' && runInspectorOpen) closeInspector()
    else openInspectorTab('runs')
  }, [closeInspector, inspectorTab, openInspectorTab, runInspectorOpen])

  useEffect(() => hostBridge().onRunEvent((event) => {
    const active = activeRunsRef.current.get(event.runId)
    if (!active || event.graphRevision !== active.graphRevision || (active.projectId && active.projectId !== activeProjectIdRef.current)) return
    const submitted = runInputGraphsRef.current.get(event.runId)
    const graph = graphRef.current
    const awaitingVideoCatalog = submitted && (!groupsLoadedRef.current && submitted.nodes.some((node) => node.kind === 'video' || node.kind === 'video-generate') || awaitingCanvasFixedVideoSources(graph.nodes, submitted, nodeSourceCatalogRef.current))
    const matchingIds = submitted && !awaitingVideoCatalog ? matchingCanvasRunNodeIds(submitted, toCanvasRunGraph(graph.nodes, graph.edges, confirmedRunGroups(), nodeSourceCatalogRef.current)) : new Set<string>()
    setRunRecords((current) => mergeCanvasRunEvent(current, event))
    if (event.type === 'run-waiting') {
      if (event.framePreparations.length || event.imagePreparations?.length || event.waitingForVideo) {
        const message = event.imagePreparations?.length ? '正在处理图像并保存素材，完成后会继续原工作流' : event.framePreparations.length ? '正在准备视频帧图片，完成后会继续原工作流' : '视频任务已提交，正在查询原任务进度'
        runWaitingBannerRef.current = { runId: event.runId, graphRevision: event.graphRevision, message }
        setBanner(message)
        void refreshRuns(event.runId)
      }
    }
    if (event.type === 'node-stage' && matchingIds.has(event.nodeId)) {
      patchNodeData(event.nodeId, {
        runStage: event.stage,
        runProgress: event.progress,
        runProgressMode: event.progressMode,
        runHealth: event.health,
        status: event.stage === 'validating' || event.stage === 'resolving-cache' || event.stage === 'waiting-slot'
          ? 'queued'
          : 'running',
      })
    }
    if (event.type === 'node-state' && event.nodeId && event.state && matchingIds.has(event.nodeId)) {
      const state = event.state === 'cached' ? 'succeeded'
        : event.state === 'skipped' || event.state === 'cancelled' || event.state === 'interrupted'
          ? 'failed'
          : event.state === 'cancelling' ? 'running'
            : event.state as CanvasNode['data']['status']
      patchNodeData(event.nodeId, {
        status: state,
        // A cache hit collapses to 'succeeded' for run semantics, but the user
        // still needs to know nothing was paid for or regenerated.
        ...(['succeeded', 'cached'].includes(event.state) ? { fromCache: event.state === 'cached' } : {}),
        ...((event.state === 'queued' || event.state === 'running') ? { runStartedAt: event.at } : {}),
        ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
        ...(typeof event.costQuota === 'number' ? { costQuota: event.costQuota } : {}),
        ...(['succeeded', 'failed', 'skipped', 'cancelled', 'cached', 'interrupted'].includes(event.state) ? {
          runStartedAt: undefined, runStage: undefined, runProgress: undefined, runProgressMode: undefined, runHealth: undefined,
        } : {}),
      })
    }
    if (event.type === 'run-terminal') {
      forgetActiveRun(event.runId)
      const waitingNotice = runWaitingBannerRef.current
      const remaining = activeRunsRef.current.size
      const message = remaining > 0
        ? `运行结束：${canvasRunStatusLabel(event.status)}（还有 ${remaining} 个任务在生成）`
        : `运行结束：${canvasRunStatusLabel(event.status)}`
      if (!waitingNotice) setBanner(message)
      else if (waitingNotice.runId === event.runId && waitingNotice.graphRevision === event.graphRevision) {
        runWaitingBannerRef.current = null
        setBanner((current) => current === waitingNotice.message ? message : current)
      }
      void refreshAssets()
      void refreshRuns(event.runId)
    }
  }), [confirmedRunGroups, forgetActiveRun, patchNodeData, refreshAssets, refreshRuns, assetQuery])

  // 断线恢复:视频节点凭已落盘的 taskId 继续轮询(应用重启/中途关窗后
  // 打开工作流文件即可续查,不重新扣费提交任务)。
  const resumeTask = useCallback(async (nodeId: string) => {
    if (projectTransitionRef.current) return
    const node = nodes.find((entry) => entry.id === nodeId)
    const taskId = node?.data.result?.taskId
    if (!taskId || resumingTaskIdsRef.current.has(taskId)) return
    const projectEpoch = projectEpochRef.current
    const nodeKind = node?.type
    const isCurrent = () => projectEpochRef.current === projectEpoch && !projectTransitionRef.current
    resumingTaskIdsRef.current.add(taskId)
    setResumingTaskIds(new Set(resumingTaskIdsRef.current))
    setNodes((current) => current.map((entry) => (
      entry.id === nodeId && entry.data.result?.taskId === taskId
        ? { ...entry, data: { ...entry.data, status: 'running', errorMessage: undefined } }
        : entry
    )))
    setBanner('正在查询原视频任务')
    try {
      const asset = await hostBridge().resumeVideoTask(taskId)
      if (!isCurrent()) return
      setNodes((current) => current.map((entry) => (
        entry.id === nodeId && entry.type === nodeKind && entry.data.result?.taskId === taskId
          ? { ...entry, data: { ...entry.data, status: 'succeeded', result: generatedVideoAssetRef(asset), errorMessage: undefined } }
          : entry
      )))
      setBanner('视频查询完成，产物已保存到素材库')
      void refreshAssets()
    } catch (error) {
      if (!isCurrent()) return
      const errorMessage = error instanceof Error ? error.message : String(error)
      setNodes((current) => current.map((entry) => (
        entry.id === nodeId && entry.type === nodeKind && entry.data.result?.taskId === taskId
          ? { ...entry, data: { ...entry.data, status: 'failed', errorMessage } }
          : entry
      )))
      setBanner(errorMessage)
    } finally {
      resumingTaskIdsRef.current.delete(taskId)
      if (isCurrent()) setResumingTaskIds(new Set(resumingTaskIdsRef.current))
    }
  }, [nodes, setNodes, refreshAssets, assetQuery])

  /**
   * 切换到某个候选。2026-08-20 起选择与采纳合并为一个动作：被选中的候选立刻
   * 成为节点产物，下游只标记为待重新运行，绝不自动发起新的付费请求。
   */
  const useCandidate = useCallback((nodeId: string, candidate: string | WorkflowCandidateRef) => {
    const candidateId = typeof candidate === 'string' ? candidate : candidate.candidateId
    const owner = nodes.find((node) => node.id === nodeId)
    if (owner?.type === 'video' || owner?.type === 'video-generate') {
      try {
        if (!draftActionsEnabledRef.current || projectTransitionRef.current || activeRunsRef.current.size || startingRunsRef.current || pendingRunProjectionIdsRef.current.size) {
          throw new Error('请等待当前运行或项目加载结束后再采用候选视频')
        }
        assertEditableVideoNode(getGraphSnapshot().nodes, nodeId)
      } catch (cause) {
        setBanner(cause instanceof Error ? cause.message : '暂时无法采用候选视频')
        return
      }
    }
    const target = typeof candidate === 'string'
      ? owner && currentNodeCandidates(owner.id, owner.type, owner.data, assetCatalog).find((entry) => entry.candidateId === candidateId)
      : candidate
    if (!owner || !target) {
      setBanner('候选已不在当前运行记录中')
      return
    }
    if (sameCanvasMediaAsset(owner.data.result, target.asset)) {
      setBanner('这就是该节点当前的产物')
      return
    }
    const restored = nodes.map((node) => node.id === nodeId ? { ...node, data: { ...node.data, candidates: currentNodeCandidates(node.id, node.type, node.data, assetCatalog) } } : node)
    const updated = selectNodeCandidate(restored, edges, nodeId, target)
    execute({ type: 'replace-nodes', nodes: updated.map(canvasNodeDocumentRecord) })
    setNodes(updated)
    const descendants = updated.filter((node) => node.id !== nodeId && node.data.dirty).map((node) => node.id)
    setDirtyNodeIds((current) => new Set([...current].filter((id) => id !== nodeId).concat(descendants)))
    setBanner('已切换节点产物；下游节点等待重新运行')
  }, [nodes, edges, assetCatalog, execute, setNodes, getGraphSnapshot])

  const bindAssetToNode = useCallback((nodeId: string, asset: CanvasAssetSummary) => {
    const current = documentController.getGraphSnapshot()
    const binding = buildCanvasMediaAssetBinding(current.nodes, current.edges, nodeId, asset)
    if (binding.status === 'missing-target') {
      setBanner('目标节点已删除，素材没有绑定；已上传素材可在素材库中查看')
      return
    }
    if (binding.status === 'type-mismatch') {
      setBanner('素材类型与当前节点不匹配，素材没有绑定；已上传素材可在素材库中查看')
      return
    }
    graphRef.current = { nodes: binding.nodes, edges: current.edges }
    execute({ type: 'replace-nodes', nodes: binding.nodes.map(canvasNodeDocumentRecord) })
    setNodes(binding.nodes)
    setDirtyNodeIds((previous) => new Set([...previous].filter((id) => id !== nodeId).concat(binding.downstreamNodeIds)))
    // Recorded here rather than when the drag starts: a drag that is cancelled,
    // dropped on nothing or rejected above for the wrong media type is not a use.
    void markCanvasAssetUsed(asset.assetId)
    setBanner(`${asset.mediaType === 'audio' ? '音频' : asset.mediaType === 'video' ? '视频' : '图片'}素材已就绪；下游节点等待重新运行`)
  }, [documentController.getGraphSnapshot, execute, markCanvasAssetUsed, setNodes])

  const createAssetNode = useCallback((asset: CanvasAssetSummary, position?: XYPosition) => {
    if (!mediaPreparationMountedRef.current || !draftActionsEnabledRef.current || projectTransitionRef.current) return
    const kind = assetInputNodeKind(asset)
    const definition = builtinNodeRegistry.require(kind)
    const dimensions = mediaAssetNodeDimensions(asset)
    const bounds = document.querySelector('.canvas-flow')?.getBoundingClientRect()
    const preferredCenter = bounds
      ? currentReactFlowRef.current.screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 })
      : { x: 420, y: 300 }
    // Uploads may finish together before React commits another render. The
    // document controller publishes each add synchronously for the next one.
    const resolvedPosition = position ?? findAvailableCanvasPosition(getGraphSnapshot().nodes.map((node) => {
      const fallback = builtinNodeRegistry.resolve(node.type ?? 'unknown')?.dimensions
      return { ...node, width: node.width ?? fallback?.width, height: node.height ?? fallback?.height }
    }), preferredCenter, unresolvedMediaPlacementDimensions(asset) ?? dimensions)
    const canvasNode = toCanvasNode({
      id: nextNodeId(), kind, definitionVersion: definition.version,
      position: resolvedPosition,
      width: dimensions.width,
      height: dimensions.height,
      data: { prompt: '', model: '', status: 'succeeded', result: mediaAssetRef(asset) },
    })
    execute({ type: 'add-nodes', nodes: [canvasNodeDocumentRecord(canvasNode)] })
    if (!position) {
      createdNodeFocusRef.current?.start(canvasNode.id, dimensions, (target) => {
        if (!mediaPreparationMountedRef.current || !draftActionsEnabledRef.current || projectTransitionRef.current) return
        const flow = currentReactFlowRef.current
        const viewportBounds = document.querySelector('.canvas-flow')?.getBoundingClientRect()
        void flow.setCenter(
          target.x + target.width / 2,
          target.y + target.height / 2,
          { zoom: createdNodeFocusZoom(target, viewportBounds, flow.getViewport().zoom), duration: 180 },
        )
      })
    }
    setBanner(asset.mediaType === 'video' ? '视频已添加到画布' : asset.mediaType === 'audio' ? '音频已添加到画布' : '图片已导入到画布')
  }, [execute, getGraphSnapshot])

  outputPlacementAdapterRef.current = {
    scope: () => !mediaPreparationMountedRef.current || !draftActionsEnabledRef.current || projectTransitionRef.current || !activeProjectIdRef.current ? null
      : layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: true }),
    graph: () => { const current = getGraphSnapshot(); return toCanvasRunGraph(current.nodes, current.edges, runGroupsRef.current, nodeSourceCatalogRef.current) },
    outputIds: (nodeId, selection) => {
      const node = getGraphSnapshot().nodes.find((entry) => entry.id === nodeId)
      if (!node) throw new Error('原图像工具已删除')
      return nodeOutputImageIds(node.type ?? '', node.data, selection)
    },
    async read(assetId, signal) {
      const host = hostBridge()
      if (!host.getAssetDetail) throw new Error('当前宿主暂不支持核对成品，请更新后重试')
      const asset = await host.getAssetDetail(assetId, signal)
      if (asset.mediaType !== 'image' || asset.deletedAt) throw new Error('图片成品已回收或不可读取，请先在素材库中核对')
      await verifyOutputImageReadable(asset, signal)
      return asset
    },
    commit(nodeId, assets) {
      const current = getGraphSnapshot()
      const measured = current.nodes.map((node) => ({ ...canvasNodeDocumentRecord(node), width: node.measured?.width ?? node.width, height: node.measured?.height ?? node.height }))
      const command = buildOutputImageNodes(measured, nodeId, assets, assets.map(() => nextNodeId()))
      execute(command)
      const addedIds = new Set(command.nodes.map((node) => node.id))
      setNodes((latest) => latest.map((node) => ({ ...node, selected: addedIds.has(node.id) })))
      for (const asset of assets) void markCanvasAssetUsed(asset.assetId)
      const first = command.nodes[0]
      createdNodeFocusRef.current?.start(first.id, { width: first.width!, height: first.height! }, (target) => {
        if (!mediaPreparationMountedRef.current || !draftActionsEnabledRef.current || projectTransitionRef.current) return
        const flow = currentReactFlowRef.current
        const bounds = document.querySelector('.canvas-flow')?.getBoundingClientRect()
        void flow.setCenter(target.x + target.width / 2, target.y + target.height / 2, { zoom: createdNodeFocusZoom(target, bounds, flow.getViewport().zoom), duration: 180 })
      })
    },
    busy: setOutputPendingNodeIds,
    notice: setBanner,
  }

  const videoPlacementPendingRef = useRef(new Set<string>())
  const placeVideoCandidate = useCallback((nodeId: string, candidateId: string) => {
    const scope = layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
    const key = `${scope}:${nodeId}:${candidateId}`
    if (videoPlacementPendingRef.current.has(key)) return
    function currentCandidate() {
      assertLayerEditorScope(scope, { ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
      if (!mediaPreparationMountedRef.current || projectTransitionRef.current || activeRunsRef.current.size || startingRunsRef.current || pendingRunProjectionIdsRef.current.size) throw new Error('工程正在切换或运行，请完成后再放置视频')
      const node = assertEditableVideoNode(getGraphSnapshot().nodes, nodeId)
      const candidate = currentNodeCandidates(nodeId, node.type, node.data, assetCatalog).find((entry) => entry.candidateId === candidateId)
      if (!candidate || candidate.asset.kind !== 'video' || !candidate.asset.assetId) throw new Error('视频候选已变化，请重新选择')
      return candidate
    }
    void (async () => {
      try {
        const snapshot = currentCandidate()
        const host = hostBridge()
        if (!host.getAssetDetail) throw new Error('当前宿主暂不支持核对视频素材')
        videoPlacementPendingRef.current.add(key)
        setBanner('正在核对候选视频')
        const asset = await host.getAssetDetail(snapshot.asset.assetId!)
        if (currentCandidate().asset.assetId !== snapshot.asset.assetId) throw new Error('视频候选已变化，没有添加新节点')
        if (asset.mediaType !== 'video' || asset.assetId !== snapshot.asset.assetId || asset.deletedAt) throw new Error('视频已回收或不可读取，请在素材库中核对')
        createAssetNode(asset)
        setBanner('候选视频已作为独立素材放到画布，可一次撤销；没有重新生成')
      } catch (cause) {
        if (mediaPreparationMountedRef.current && scope === layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })) setBanner(cause instanceof Error ? cause.message : '视频放置未完成')
      } finally { videoPlacementPendingRef.current.delete(key) }
    })()
  }, [getGraphSnapshot, assetCatalog, createAssetNode])

  const placeNodeOutput = useCallback((nodeId: string, selection: OutputImageSelection) => {
    try {
      const adapter = outputPlacementAdapterRef.current
      if (!adapter || !adapter.scope()) return
      const ids = adapter.outputIds(nodeId, selection)
      const token = outputPlacementCoordinator.begin(nodeId, selection, adapter.graph(), ids)
      if (token) { setBanner('正在核对成品图片'); void outputPlacementCoordinator.resolve(token, ids) }
    } catch (error) { setBanner(error instanceof Error ? error.message : '成品放置未完成，请重试') }
  }, [outputPlacementCoordinator])

  const openFrameSelection = useCallback((nodeId: string) => {
    frameLoadingRef.current?.abort()
    const controller = new AbortController()
    frameLoadingRef.current = controller
    const scope = layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
    function assertActive() {
      controller.signal.throwIfAborted()
      assertLayerEditorScope(scope, { ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
      if (!mediaPreparationMountedRef.current || projectTransitionRef.current || activeRunsRef.current.size || startingRunsRef.current || pendingRunProjectionIdsRef.current.size) throw new Error('工程正在切换或运行，请完成后再选帧')
    }
    void (async () => {
      try {
        assertActive()
        const graph = getGraphSnapshot(), snapshot = captureFrameSelection(graph.nodes, graph.edges, nodeId)
        const host = hostBridge()
        if (!host.getAssetDetail || !host.readVideoForFramePreview) throw new Error('当前宿主暂不支持视频选帧，请更新后重试')
        setBanner('正在读取视频资料')
        const asset = await host.getAssetDetail(snapshot.sourceAssetId, controller.signal)
        assertActive()
        const latest = getGraphSnapshot()
        assertFrameSelection(latest.nodes, latest.edges, snapshot)
        if (asset.mediaType !== 'video' || asset.assetId !== snapshot.sourceAssetId || asset.deletedAt) throw new Error('视频已回收或不可读取，请在素材库中核对')
        const session = { snapshot, asset, scope }
        frameSessionRef.current = session; setFrameSession(session)
        setBanner('在视频中选择画面，应用后再运行抽帧')
      } catch (cause) {
        if (!controller.signal.aborted && mediaPreparationMountedRef.current && scope === layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })) setBanner(cause instanceof Error ? cause.message : '视频选帧暂时无法打开')
      } finally { if (frameLoadingRef.current === controller) frameLoadingRef.current = null }
    })()
  }, [getGraphSnapshot])

  const applyFrameSelection = useCallback(async (timestampSeconds: number, signal: AbortSignal) => {
    signal.throwIfAborted()
    const session = frameSessionRef.current
    if (!session || session !== frameSession) throw new Error('选帧会话已关闭，请重新打开')
    assertLayerEditorScope(session.scope, { ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
    if (!mediaPreparationMountedRef.current || projectTransitionRef.current || activeRunsRef.current.size || startingRunsRef.current || pendingRunProjectionIdsRef.current.size) throw new Error('工程正在切换或运行，请完成后再应用时间点')
    const graph = getGraphSnapshot()
    assertFrameSelection(graph.nodes, graph.edges, session.snapshot)
    if (!Number.isFinite(timestampSeconds) || timestampSeconds < 0 || timestampSeconds > 86_400) throw new Error('抽帧时间点无效')
    const node = graph.nodes.find((item) => item.id === session.snapshot.nodeId)!
    if (timestampSeconds !== session.snapshot.timestampSeconds) markDirtyFrom(node.id, { settings: { ...node.data.settings, timestampSeconds } }, true)
    frameSessionRef.current = null; setFrameSession(null)
    setBanner(`已选择 ${timestampSeconds.toFixed(3)} 秒；运行抽帧节点即可保存图片`)
  }, [frameSession, getGraphSnapshot, markDirtyFrom])

  const loadFrameVideo = useCallback(async (assetId: string, signal: AbortSignal) => {
    const session = frameSessionRef.current
    if (!session || session.asset.assetId !== assetId) throw new Error('视频选帧会话已变化')
    function assertCurrent() {
      signal.throwIfAborted()
      if (session !== frameSessionRef.current) throw new Error('视频选帧会话已变化')
      assertLayerEditorScope(session!.scope, { ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
      if (!mediaPreparationMountedRef.current || projectTransitionRef.current || activeRunsRef.current.size || startingRunsRef.current || pendingRunProjectionIdsRef.current.size) throw new Error('工程正在切换或运行，请完成后再选帧')
      const graph = getGraphSnapshot()
      assertFrameSelection(graph.nodes, graph.edges, session!.snapshot)
    }
    assertCurrent()
    const host = hostBridge()
    if (!host.readVideoForFramePreview) throw new Error('当前宿主暂不支持视频预览')
    const blob = await host.readVideoForFramePreview(assetId, signal)
    assertCurrent()
    return blob
  }, [getGraphSnapshot])

  const openFrameSequence = useCallback((nodeId: string) => {
    frameSequenceLoadingRef.current?.abort()
    const controller = new AbortController()
    frameSequenceLoadingRef.current = controller
    const scope = layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
    function assertActive() {
      controller.signal.throwIfAborted()
      assertLayerEditorScope(scope, { ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
      if (!projectCanEditRef.current || !mediaPreparationMountedRef.current || projectTransitionRef.current || activeRunsRef.current.size || startingRunsRef.current || pendingRunProjectionIdsRef.current.size) throw new Error('工程正在切换、运行或只读，请稍后再创建分镜')
    }
    void (async () => {
      try {
        assertActive()
        const snapshot = captureFrameSequenceSource(getGraphSnapshot().nodes, nodeId)
        const host = hostBridge()
        if (!host.getAssetDetail || !host.readVideoForFramePreview) throw new Error('当前宿主暂不支持视频分镜，请更新后重试')
        setBanner('正在读取分镜源视频')
        const asset = await host.getAssetDetail(snapshot.sourceAssetId, controller.signal)
        assertActive()
        assertFrameSequenceSource(getGraphSnapshot().nodes, snapshot)
        if (asset.mediaType !== 'video' || asset.assetId !== snapshot.sourceAssetId || asset.deletedAt) throw new Error('视频已回收或不可读取，请在素材库中核对')
        const session = { snapshot, asset, scope }
        frameSequenceSessionRef.current = session; setFrameSequenceSession(session)
        setBanner('选择多个时间点，创建可独立调整的抽帧与分镜拼图')
      } catch (cause) {
        if (!controller.signal.aborted && mediaPreparationMountedRef.current && scope === layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })) setBanner(cause instanceof Error ? cause.message : '视频分镜暂时无法打开')
      } finally { if (frameSequenceLoadingRef.current === controller) frameSequenceLoadingRef.current = null }
    })()
  }, [getGraphSnapshot])

  const loadFrameSequenceVideo = useCallback(async (assetId: string, signal: AbortSignal) => {
    const session = frameSequenceSessionRef.current
    if (!session || session.asset.assetId !== assetId) throw new Error('分镜会话已变化，请重新打开')
    function assertCurrent() {
      signal.throwIfAborted()
      if (session !== frameSequenceSessionRef.current) throw new Error('分镜会话已关闭，请重新打开')
      assertLayerEditorScope(session!.scope, { ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
      if (!projectCanEditRef.current || !mediaPreparationMountedRef.current || projectTransitionRef.current || activeRunsRef.current.size || startingRunsRef.current || pendingRunProjectionIdsRef.current.size) throw new Error('工程正在切换、运行或只读，请稍后再创建分镜')
      assertFrameSequenceSource(getGraphSnapshot().nodes, session!.snapshot)
    }
    assertCurrent()
    const host = hostBridge()
    if (!host.readVideoForFramePreview) throw new Error('当前宿主暂不支持视频预览')
    const blob = await host.readVideoForFramePreview(assetId, signal)
    assertCurrent()
    return blob
  }, [getGraphSnapshot])

  const applyFrameSequence = useCallback(async (timestamps: number[], metadata: FrameEditorMetadata, signal: AbortSignal) => {
    signal.throwIfAborted()
    const session = frameSequenceSessionRef.current
    if (!session || session !== frameSequenceSession) throw new Error('分镜会话已关闭，请重新打开')
    assertLayerEditorScope(session.scope, { ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
    if (!projectCanEditRef.current || !mediaPreparationMountedRef.current || projectTransitionRef.current || activeRunsRef.current.size || startingRunsRef.current || pendingRunProjectionIdsRef.current.size) throw new Error('工程正在切换、运行或只读，请稍后再创建分镜')
    const graph = getGraphSnapshot()
    const command = buildFrameSequenceGraph(graph.nodes, graph.edges, session.snapshot, timestamps, metadata, nextNodeId)
    execute(command)
    frameSequenceSessionRef.current = null; setFrameSequenceSession(null)
    const inserted = new Set(command.nodes.map((node) => node.id))
    setNodes((current) => current.map((node) => ({ ...node, selected: inserted.has(node.id) })))
    setBanner(`已创建 ${timestamps.length} 帧分镜与有序拼图，可一次撤销；选择拼图并运行上游后保存成品`)
    window.requestAnimationFrame(() => {
      const scope = layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
      if (scope === session.scope && !projectTransitionRef.current) void reactFlow.fitView({ nodes: command.nodes.map((node) => ({ id: node.id })), padding: 0.2, duration: 180, maxZoom: 1 })
    })
  }, [frameSequenceSession, getGraphSnapshot, execute, setNodes, reactFlow])

  const captureAssetImportScope = useCallback(() => {
    const epoch = projectEpochRef.current
    const projectId = activeProjectIdRef.current
    const owner = layerEditorOwnerRef.current
    return {
      epoch,
      current: () => mediaPreparationMountedRef.current && draftActionsEnabledRef.current && !projectTransitionRef.current
        && activeProjectIdRef.current === projectId && layerEditorOwnerRef.current.ownerId === owner.ownerId && layerEditorOwnerRef.current.accountId === owner.accountId
        ? projectEpochRef.current : -1,
    }
  }, [])

  const pickAssetForNode = useCallback(async (nodeId: string, isCurrent?: () => boolean) => {
    try {
      if (isCurrent && !isCurrent()) return
      const projectEpoch = projectEpochRef.current
      const target = nodes.find((node) => node.id === nodeId)
      if (!target) return
      const mediaType = target.type === 'video-input' ? 'video' : target.type === 'audio-input' ? 'audio' : 'image'
      const completed = await completeCanvasMediaImport(hostBridge().pickAsset({ mediaType }), projectEpoch, () => isCurrent && !isCurrent() ? -1 : projectEpochRef.current, (asset) => {
        bindAssetToNode(nodeId, importedAssetSummary(asset))
        if (isCurrent) setWorkshopSetupAssets((previous) => ({ ...previous, [asset.assetId]: { state: 'available' } }))
        void refreshAssets()
      })
      if (completed === 'stale' && (!isCurrent || isCurrent())) setBanner('工程会话已重新打开，上传结果没有绑定当前画布；已上传素材可在素材库中查看')
    } catch (error) {
      if (!isCurrent || isCurrent()) setBanner(error instanceof Error ? error.message : String(error))
    }
  }, [nodes, bindAssetToNode, refreshAssets, assetQuery])

  const pickAssetForTemplate = useCallback(async (): Promise<CanvasAssetSummary | null> => {
    const asset = await hostBridge().pickAsset({ mediaType: 'image' })
    if (!asset) return null
    const summary = importedAssetSummary(asset)
    if (summary.mediaType !== 'image') throw new Error('行业模板当前只支持图片素材作为参考输入')
    void refreshAssets()
    return summary
  }, [refreshAssets, assetQuery])

  const listAssetsForTemplate = useCallback((query: CanvasAssetQuery) => hostBridge().listAssets(query), [])
  const officialAssetAccess = useMemo<OfficialAssetAccess | undefined>(() => {
    const bridge = hostBridge()
    if (!bridge.listOfficialAssets || !bridge.acquireOfficialAsset || !bridge.inspectOfficialAsset) return undefined
    function assertCurrent(scope: string) {
      if (!mediaPreparationMountedRef.current || !draftActionsEnabledRef.current || scope !== currentWorkshopSetupScope()) throw new Error('账号或工程已变化；已经取得的副本可在我的素材中核对')
    }
    return {
      async list(query, signal) { const scope = currentWorkshopSetupScope(); assertCurrent(scope); const result = await hostBridge().listOfficialAssets!(query, signal); assertCurrent(scope); return result },
      async acquire(input, signal) { const scope = currentWorkshopSetupScope(); assertCurrent(scope); const result = await hostBridge().acquireOfficialAsset!(input, signal); assertCurrent(scope); setAssetCatalog((previous) => [...previous.filter((asset) => asset.assetId !== result.asset.assetId), result.asset]); return result },
      async inspect(input, signal) { const scope = currentWorkshopSetupScope(); assertCurrent(scope); const result = await hostBridge().inspectOfficialAsset!(input, signal); assertCurrent(scope); setAssetCatalog((previous) => [...previous.filter((asset) => asset.assetId !== result.asset.assetId), result.asset]); return result },
    }
  }, [currentWorkshopSetupScope])


  const importAssetForNode = useCallback(async (nodeId: string, file: File) => {
    try {
      const projectEpoch = projectEpochRef.current
      const target = nodes.find((node) => node.id === nodeId)
      if (!target) return
      const mediaType = target.type === 'video-input' ? 'video' : target.type === 'audio-input' ? 'audio' : 'image'
      const completed = await completeCanvasMediaImport(hostBridge().importAssetFile(file, { mediaType }), projectEpoch, () => projectEpochRef.current, (asset) => {
        bindAssetToNode(nodeId, importedAssetSummary(asset))
        void refreshAssets()
      })
      if (completed === 'stale') setBanner('工程会话已重新打开，上传结果没有绑定当前画布；已上传素材可在素材库中查看')
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
    }
  }, [nodes, bindAssetToNode, refreshAssets, assetQuery])

  const importAssetToCanvas = useCallback(async (file: File, position: XYPosition) => {
    const scope = captureAssetImportScope()
    if (scope.current() !== scope.epoch) return
    try {
      const completed = await completeCanvasMediaImport(hostBridge().importAssetFile(file), scope.epoch, scope.current, (asset) => {
        createAssetNode(importedAssetSummary(asset), position)
        void refreshAssets()
      })
      if (completed === 'stale' && mediaPreparationMountedRef.current && draftActionsEnabledRef.current) setBanner('工程会话已变化，上传结果没有添加到当前画布；已上传素材可在素材库中查看')
    } catch (error) {
      if (scope.current() === scope.epoch) setBanner(error instanceof Error ? error.message : String(error))
    }
  }, [captureAssetImportScope, createAssetNode, refreshAssets, assetQuery])

  const pickAssetToCanvas = useCallback(async (categoryTarget?: AssetCategoryUploadTarget) => {
    const scope = captureAssetImportScope()
    if (scope.current() !== scope.epoch) return
    try {
      const completed = await completeCanvasMediaImport(categoryTarget ? hostBridge().pickAsset(categoryTarget) : hostBridge().pickAsset(), scope.epoch, scope.current, (asset) => {
        createAssetNode(importedAssetSummary(asset))
        void refreshAssets()
      })
      if (completed === 'stale' && mediaPreparationMountedRef.current && draftActionsEnabledRef.current) setBanner('工程会话已变化，上传结果没有添加到当前画布；已上传素材可在素材库中查看')
    } catch (error) {
      if (scope.current() === scope.epoch) setBanner(error instanceof Error ? error.message : String(error))
    }
  }, [captureAssetImportScope, createAssetNode, refreshAssets, assetQuery])
  const pickLibraryAssetToCanvas = useCallback(async () => {
    try { await pickAssetToCanvas(currentAssetCategoryUploadTarget()) }
    catch (cause) { setBanner(cause instanceof Error ? cause.message : '当前素材分类尚未确认，请刷新核对') }
  }, [currentAssetCategoryUploadTarget, pickAssetToCanvas])

  const inspectTileEditor = useCallback((nodeId: string, editorScope: string, expectedInputScope: string, editing: boolean) => {
    assertLayerEditorScope(editorScope, { ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
    if (!agentMountedRef.current || !draftActionsEnabledRef.current || projectTransitionRef.current) throw new Error('画布会话已变化，请重新打开平铺工具')
    if (editing && (!projectCanEditRef.current || activeRunsRef.current.size || startingRunsRef.current || pendingRunProjectionIdsRef.current.size)) throw new Error('当前画布只读或任务仍在运行，请稍后修改平铺配置')
    const current = getGraphSnapshot(), node = current.nodes.find((entry) => entry.id === nodeId)
    if (!node || node.type !== 'image-tile') throw new Error('平铺节点已变化，请重新选择节点')
    const seen = new Set<string>(); let ancestor: CanvasNode | undefined = node
    while (ancestor) {
      if (seen.has(ancestor.id)) throw new Error('节点分组层级无法确认，请重新打开工程')
      if (editing && (ancestor.draggable === false || ancestor.disabled || ancestor.data.__canvasLocked || ancestor.data.__canvasDisabled || ancestor.data.status === 'running' || ancestor.data.status === 'queued')) throw new Error('节点或分组已锁定、禁用或正在运行，暂时不能修改贴图')
      seen.add(ancestor.id); ancestor = ancestor.parentId ? current.nodes.find((entry) => entry.id === ancestor!.parentId) : undefined
    }
    const references = buildCanvasUpstreamReferences(current.nodes, current.edges, assetCatalog).get(nodeId) ?? []
    if (tileEditorInputScope(references, node.data.settings?.tileInput) !== expectedInputScope) throw new Error('贴图输入或当前选择已变化，请重新打开平铺工具')
    return { node, references }
  }, [getGraphSnapshot, assetCatalog])
  const changeTileSettings = useCallback((nodeId: string, patch: Record<string, unknown>, editorScope: string, expectedInputScope: string) => {
    const { node, references } = inspectTileEditor(nodeId, editorScope, expectedInputScope, true)
    if (!Object.keys(patch).length || Object.keys(patch).some((key) => !['tileInput', 'imageTransform'].includes(key))) throw new Error('平铺配置包含不支持的字段')
    const next: Record<string, unknown> = {}
    if (Object.hasOwn(patch, 'tileInput')) {
      const selected = parseTileInput(patch.tileInput)
      if ('missing' in selected || !resolveTileInputSlots(references).slots.some((slot) => slot.edgeId === selected.edgeId && slot.outputIndex === selected.outputIndex && !slot.missing)) throw new Error('所选贴图已不在当前连接中，请重新选择')
      next.tileInput = selected
    }
    if (Object.hasOwn(patch, 'imageTransform')) next.imageTransform = imageTransformRecipeForNode('image-tile', patch)
    const settings = { ...node.data.settings, ...next }
    if (JSON.stringify(settings) === JSON.stringify(node.data.settings)) return
    markDirtyFrom(nodeId, { settings }, true)
  }, [inspectTileEditor, markDirtyFrom])
  const downloadTileSource = useCallback(async (nodeId: string, selection: TileInputSelection, editorScope: string, expectedInputScope: string) => {
    const { node, references } = inspectTileEditor(nodeId, editorScope, expectedInputScope, false)
    const selected = resolveTileInputSlots(references, node.data.settings?.tileInput === undefined ? undefined : parseTileInput(node.data.settings.tileInput)).selected
    const requested = parseTileInput(selection)
    if ('missing' in requested || !selected || selected.missing || selected.pending || selected.edgeId !== requested.edgeId || selected.outputIndex !== requested.outputIndex || selected.reference?.asset?.kind !== 'image' || !selected.reference.asset.assetId) throw new Error('当前原贴图尚未就绪或已经变化，请重新选择')
    // Download the owned original bytes. Never export the repeated preview or
    // the tile node's older processed result under an original-image label.
    const saved = await hostBridge().saveAsset(selected.reference.asset.assetId)
    if (!saved.saved) throw new Error('原图未保存，请在素材库重试')
  }, [inspectTileEditor])

  const changeNodeModelSource = useCallback((nodeId: string, group: string | undefined) => {
    try {
      if (!draftActionsEnabledRef.current || !projectCanEditRef.current || projectTransitionRef.current || activeRunsRef.current.size || startingRunsRef.current || pendingRunProjectionIdsRef.current.size) throw new Error('工程正在切换或运行，请稍后修改节点来源')
      const node = getGraphSnapshot().nodes.find((entry) => entry.id === nodeId), purpose = canvasNodeMediaKind(node?.type ?? '')
      if (!node || !purpose || node.draggable === false || node.disabled) throw new Error('请选择可编辑的生成节点')
      if (group !== undefined) {
        const source = groupsRef.current.find((entry) => entry.name === group)
        if (!source || source.purposes !== undefined && !source.purposes.includes(purpose) || source.connectionStatus && source.connectionStatus !== 'ready') throw new Error('所选节点来源不存在、用途不符或尚未检测，请重新选择')
      }
      if (node.data.group === group) return
      markDirtyFrom(nodeId, { group }, true)
      setBanner('已更新节点来源；保留原模型、参数和旧结果，请核对模型可用性后运行')
    } catch (cause) { setBanner(cause instanceof Error ? cause.message : '节点来源无法修改') }
  }, [getGraphSnapshot, markDirtyFrom])

  const changeVideoParameters = useCallback((nodeId: string, patch?: VideoParameterPatch) => {
    try {
      if (!draftActionsEnabledRef.current || projectTransitionRef.current || activeRunsRef.current.size || startingRunsRef.current || pendingRunProjectionIdsRef.current.size) throw new Error('工程正在切换或运行，请稍后修改视频参数')
      const current = getGraphSnapshot(), node = assertEditableVideoNode(current.nodes, nodeId)
      const available = resolveCanvasNodeModelAvailability(node.type ?? '', node.data, { connected: true, sourceCatalog: nodeSourceCatalogRef.current, imageModels: mediaModelsRef.current.image, videoModels: mediaModelsRef.current.video, textModels: mediaModelsRef.current.text, videoProtocol: runGroupsRef.current.videoProtocol })
      if (available.sourceError) throw new Error(available.sourceError)
      if (patch?.model !== undefined && !available.videoModels.includes(patch.model)) throw new Error('此节点来源不提供所选视频模型，请重新选择')
      let resolved = patch
      if (!resolved) {
        const graph = toCanvasRunGraph(current.nodes, current.edges, confirmedRunGroups(), nodeSourceCatalogRef.current)
        const runNode = graph.nodes.find((entry) => entry.id === nodeId)
        if (!runNode) throw new Error('视频节点已变化，请重新核对参数')
        const inputs = inspectCanvasVideoInputs(runNode, graph.edges, new Map(graph.nodes.map((entry) => [entry.id, entry])))
        assertCanvasVideoInputCardinality(inputs)
        resolved = inspectVideoNodeParameters(node.data, node.data.model || (node.data.group === undefined ? runGroupsRef.current.videoModel ?? '' : ''), available.videoProtocol, inputs.imageCount).reset
      }
      if (!Object.keys(resolved).length) return
      markDirtyFrom(nodeId, buildVideoParameterPatch(node.data, resolved), true)
    } catch (cause) { setBanner(cause instanceof Error ? cause.message : '视频参数无法修改') }
  }, [getGraphSnapshot, markDirtyFrom, confirmedRunGroups])

  const changeVideoCandidateCount = useCallback((nodeId: string, value: VideoCandidateCount) => {
    try {
      if (!draftActionsEnabledRef.current || projectTransitionRef.current || activeRunsRef.current.size || startingRunsRef.current || pendingRunProjectionIdsRef.current.size) throw new Error('工程正在切换或运行，请稍后修改视频数量')
      const node = assertEditableVideoNode(getGraphSnapshot().nodes, nodeId)
      const videoCandidateCount = parseVideoCandidateCount(value, node.type ?? '')
      if (videoCandidateCount === node.data.videoCandidateCount) return
      markDirtyFrom(nodeId, { videoCandidateCount }, true)
    } catch (cause) { setBanner(cause instanceof Error ? cause.message : '视频数量无法修改') }
  }, [getGraphSnapshot, markDirtyFrom])

  const changeVideoReferenceOrder = useCallback((nodeId: string, value: VideoReferenceOrder) => {
    try {
      if (!draftActionsEnabledRef.current || projectTransitionRef.current || activeRunsRef.current.size || startingRunsRef.current || pendingRunProjectionIdsRef.current.size) throw new Error('工程正在切换或运行，请稍后调整视频素材')
      const current = getGraphSnapshot()
      const node = assertEditableVideoNode(current.nodes, nodeId)
      const order = parseVideoReferenceOrder(value)
      const references = buildCanvasUpstreamReferences(current.nodes, current.edges, assetPage.items).get(nodeId) ?? []
      const previous = node.data.settings?.videoReferenceOrder === undefined ? undefined : parseVideoReferenceOrder(node.data.settings.videoReferenceOrder)
      const known = new Set([...references.map((reference) => ({ edgeId: reference.edgeId, outputIndex: reference.outputIndex ?? 0 })), ...(previous?.slots ?? [])].map(videoReferenceIdentityKey))
      if (order.slots.some((slot) => !known.has(videoReferenceIdentityKey(slot)))) throw new Error('视频素材连接已变化，请重新核对顺序')
      if (JSON.stringify(previous) === JSON.stringify(order)) return
      markDirtyFrom(nodeId, { settings: { ...node.data.settings, videoReferenceOrder: order } }, true)
    } catch (cause) { setBanner(cause instanceof Error ? cause.message : '视频素材顺序无法修改') }
  }, [getGraphSnapshot, markDirtyFrom, assetPage.items])

  const removeVideoReference = useCallback((nodeId: string, edgeId: string) => {
    try {
      if (!draftActionsEnabledRef.current || projectTransitionRef.current || activeRunsRef.current.size || startingRunsRef.current || pendingRunProjectionIdsRef.current.size) throw new Error('工程正在切换或运行，请稍后移除视频素材')
      const current = getGraphSnapshot()
      const node = assertEditableVideoNode(current.nodes, nodeId)
      const edge = current.edges.find((entry) => entry.id === edgeId && entry.target === nodeId && ['out:image', 'out:images', 'out:audio', 'out:video'].includes(entry.sourceHandle ?? ''))
      if (!edge) throw new Error('视频素材连接已变化，请重新选择')
      const previous = node.data.settings?.videoReferenceOrder === undefined ? undefined : parseVideoReferenceOrder(node.data.settings.videoReferenceOrder)
      const order: VideoReferenceOrder = { version: 1, slots: previous?.slots.filter((slot) => slot.edgeId !== edgeId) ?? [] }
      const updated = markNodeAndDescendantsDirty(current.nodes, current.edges, nodeId, { settings: { ...node.data.settings, videoReferenceOrder: order } })
      execute({ type: 'replace-graph', nodes: updated.map(canvasNodeDocumentRecord), edges: current.edges.filter((entry) => entry.id !== edgeId).map(toWorkflowEdge) })
      graphRef.current = getGraphSnapshot()
      setDirtyNodeIds(dirtyCanvasNodeIds(graphRef.current.nodes))
    } catch (cause) { setBanner(cause instanceof Error ? cause.message : '视频素材无法移除') }
  }, [getGraphSnapshot, execute])

  const assertCommerceCurrent = useCallback((scope: string) => {
    if (!agentMountedRef.current || !draftActionsEnabledRef.current || !projectCanEditRef.current || projectTransitionRef.current || scope !== currentWorkshopSetupScope()) throw new Error('账号、工程或编辑权限已变化，请重新打开创作配置')
    if (activeRunsRef.current.size || startingRunsRef.current || pendingRunProjectionIdsRef.current.size) throw new Error('请等待当前运行及结果回填结束后修改创作任务')
  }, [currentWorkshopSetupScope])

  const openCommerceCreation = useCallback(() => {
    try {
      commerceOpenRevisionRef.current += 1
      const scope = currentWorkshopSetupScope(); assertCommerceCurrent(scope)
      const task = defaultCommerceTask('material-a')
      const session = { scope, task, references: commerceTaskRoles(task).map((role): CommerceTaskReferenceDraft => ({ role, binding: { kind: 'missing' } })) }
      commerceSessionRef.current = session; setCommerceSession(session); setMoreActionsOpen(false)
    } catch (cause) { setBanner(cause instanceof Error ? cause.message : '暂时无法创建商品任务') }
  }, [currentWorkshopSetupScope, assertCommerceCurrent])

  const openInteriorCreation = useCallback(() => {
    try {
      interiorOpenRevisionRef.current += 1
      const scope = currentWorkshopSetupScope(); assertCommerceCurrent(scope)
      const session = { scope, task: defaultInteriorTask(), source: { binding: { kind: 'missing' as const } }, group: mediaGroupsRef.current.image, models: [...mediaModelsRef.current.image] }
      interiorSessionRef.current = session; setInteriorSession(session); setMoreActionsOpen(false); setQuickInsert(null)
    } catch (cause) { setBanner(cause instanceof Error ? cause.message : '暂时无法创建室内任务') }
  }, [currentWorkshopSetupScope, assertCommerceCurrent])

  const openExteriorCreation = useCallback(() => {
    try {
      exteriorOpenRevisionRef.current += 1
      const scope = currentWorkshopSetupScope(); assertCommerceCurrent(scope)
      const task = defaultExteriorTask('exterior-render')
      const session = { scope, task, references: exteriorTaskRoles(task).map((role): ExteriorTaskReferenceDraft => ({ role, binding: { kind: 'missing' } })), imageSource: exteriorTaskSourceSignature(groupsRef.current, mediaGroupsRef.current.image), textSource: exteriorTaskSourceSignature(groupsRef.current, mediaGroupsRef.current.text) }
      exteriorSessionRef.current = session; setExteriorSession(session); setMoreActionsOpen(false); setQuickInsert(null)
    } catch (cause) { setBanner(cause instanceof Error ? cause.message : '暂时无法创建室外任务') }
  }, [currentWorkshopSetupScope, assertCommerceCurrent])

  const openExteriorEdit = useCallback(async (nodeId: string, scope: string) => {
    const revision = ++exteriorOpenRevisionRef.current
    try {
      assertCommerceCurrent(scope)
      const graph = getGraphSnapshot(), node = graph.nodes.find((entry) => entry.id === nodeId)
      if (!node || node.draggable === false || node.disabled) throw new Error('请选择可编辑的室外任务节点')
      assertExteriorNodeEditable(graph.nodes.map(toWorkflowNode), nodeId)
      const task = parseNodeExteriorTask(node.type ?? '', node.data.settings?.exteriorTask)
      const order = node.data.settings?.imageReferenceOrder === undefined ? undefined : parseNodeImageReferenceOrder(node.type ?? '', node.data.settings.imageReferenceOrder)
      const upstream = buildCanvasUpstreamReferences(graph.nodes, graph.edges, assetCatalog).get(nodeId) ?? []
      const signature = exteriorTaskEditSignature(graph.nodes.map(toWorkflowNode), graph.edges.map(toWorkflowEdge), nodeId, upstream)
      const imageSource = exteriorTaskSourceSignature(groupsRef.current, mediaGroupsRef.current.image), textSource = exteriorTaskSourceSignature(groupsRef.current, mediaGroupsRef.current.text)
      const references: ExteriorTaskReferenceDraft[] = []
      for (const role of exteriorTaskRoles(task)) {
        const slot = order?.slots.find((entry) => entry.role === role)
        const actual = slot && 'edgeId' in slot ? upstream.find((entry) => entry.edgeId === slot.edgeId && (entry.outputIndex ?? 0) === slot.outputIndex) : undefined
        const binding: ExteriorTaskReferenceDraft['binding'] = slot && 'edgeId' in slot ? { kind: 'existing', edgeId: slot.edgeId, outputIndex: slot.outputIndex } : { kind: 'missing' }
        let asset: CanvasImageAssetSummary | undefined
        if (actual?.asset?.assetId && hostBridge().getAssetDetail) {
          const detail = await hostBridge().getAssetDetail!(actual.asset.assetId)
          assertCommerceCurrent(scope)
          if (revision !== exteriorOpenRevisionRef.current) return
          if (detail?.mediaType === 'image' && detail.assetId === actual.asset.assetId && isTemplateImageAsset(detail)) asset = detail
        }
        references.push({ role, binding, ...(asset ? { asset } : {}), label: actual?.label, ...(!actual || actual.status !== 'ready' || !asset ? { unavailableReason: '原图或参考图已失效、尚未就绪，请重新选择室外图片' } : {}) })
      }
      assertCommerceCurrent(scope)
      if (revision !== exteriorOpenRevisionRef.current) return
      const latest = getGraphSnapshot()
      assertExteriorNodeEditable(latest.nodes.map(toWorkflowNode), nodeId)
      if (imageSource !== exteriorTaskSourceSignature(groupsRef.current, mediaGroupsRef.current.image) || textSource !== exteriorTaskSourceSignature(groupsRef.current, mediaGroupsRef.current.text)
        || signature !== exteriorTaskEditSignature(latest.nodes.map(toWorkflowNode), latest.edges.map(toWorkflowEdge), nodeId, buildCanvasUpstreamReferences(latest.nodes, latest.edges, assetCatalog).get(nodeId) ?? [])) throw new Error('图片、分析节点或生成来源已变化，请重新打开室外配置')
      const textEdges = graph.edges.filter((edge) => edge.target === nodeId && edge.targetHandle === 'in:text')
      const analysisNode = textEdges.length === 1 ? graph.nodes.find((entry) => entry.id === textEdges[0].source && entry.type === 'text-generate') : undefined
      const session = { scope, task, references, imageSource, textSource, ...(exteriorTaskUsesAnalysis(task) ? { analysis: { model: analysisNode?.data.model ?? '' } } : {}), nodeId, signature }
      exteriorSessionRef.current = session; setExteriorSession(session)
    } catch (cause) { if (scope === currentWorkshopSetupScope() && revision === exteriorOpenRevisionRef.current) setBanner(cause instanceof Error ? cause.message : '室外配置无法打开') }
  }, [assertCommerceCurrent, currentWorkshopSetupScope, getGraphSnapshot, assetCatalog])

  const openStoryboardCreation = useCallback(() => {
    try {
      storyboardOpenRevisionRef.current += 1
      const scope = currentWorkshopSetupScope(); assertCommerceCurrent(scope)
      const task = defaultStoryboardTask()
      const session = { scope, task, references: storyboardTaskRoles(task).map((role): StoryboardTaskReferenceDraft => ({ role, binding: { kind: 'missing' } })), imageSource: storyboardTaskSourceSignature(groupsRef.current, mediaGroupsRef.current.image), textSource: storyboardTaskSourceSignature(groupsRef.current, mediaGroupsRef.current.text) }
      storyboardSessionRef.current = session; setStoryboardSession(session); setMoreActionsOpen(false); setQuickInsert(null)
    } catch (cause) { setBanner(cause instanceof Error ? cause.message : '暂时无法创建故事板任务') }
  }, [currentWorkshopSetupScope, assertCommerceCurrent])

  const openStoryboardEdit = useCallback(async (nodeId: string, scope: string) => {
    const revision = ++storyboardOpenRevisionRef.current
    try {
      assertCommerceCurrent(scope)
      const graph = getGraphSnapshot(), node = graph.nodes.find((entry) => entry.id === nodeId)
      if (!node || node.draggable === false || node.disabled) throw new Error('请选择可编辑的故事板任务节点')
      assertStoryboardNodeEditable(graph.nodes.map(toWorkflowNode), nodeId)
      const task = parseNodeStoryboardTask(node.type ?? '', node.data.settings?.storyboardTask)
      const order = node.data.settings?.imageReferenceOrder === undefined ? undefined : parseNodeImageReferenceOrder(node.type ?? '', node.data.settings.imageReferenceOrder)
      const upstream = buildCanvasUpstreamReferences(graph.nodes, graph.edges, assetCatalog).get(nodeId) ?? []
      const signature = storyboardTaskEditSignature(graph.nodes.map(toWorkflowNode), graph.edges.map(toWorkflowEdge), nodeId, upstream)
      const imageSource = storyboardTaskSourceSignature(groupsRef.current, mediaGroupsRef.current.image), textSource = storyboardTaskSourceSignature(groupsRef.current, mediaGroupsRef.current.text)
      const references: StoryboardTaskReferenceDraft[] = []
      for (const [index, role] of storyboardTaskRoles(task, order?.slots.length ?? 1).entries()) {
        const slot = order?.slots[index]
        const actual = slot && 'edgeId' in slot ? upstream.find((entry) => entry.edgeId === slot.edgeId && (entry.outputIndex ?? 0) === slot.outputIndex) : undefined
        const binding: StoryboardTaskReferenceDraft['binding'] = slot && 'edgeId' in slot ? { kind: 'existing', edgeId: slot.edgeId, outputIndex: slot.outputIndex } : { kind: 'missing' }
        let asset: CanvasImageAssetSummary | undefined
        if (actual?.asset?.assetId && hostBridge().getAssetDetail) {
          const detail = await hostBridge().getAssetDetail!(actual.asset.assetId)
          assertCommerceCurrent(scope)
          if (revision !== storyboardOpenRevisionRef.current) return
          if (detail?.mediaType === 'image' && detail.assetId === actual.asset.assetId && isTemplateImageAsset(detail)) asset = detail
        }
        references.push({ role, binding, ...(asset ? { asset } : {}), label: actual?.label, ...(!actual || actual.status !== 'ready' || !asset ? { unavailableReason: '原图或参考图已失效、尚未就绪，请重新选择故事板图片' } : {}) })
      }
      assertCommerceCurrent(scope)
      if (revision !== storyboardOpenRevisionRef.current) return
      const latest = getGraphSnapshot()
      assertStoryboardNodeEditable(latest.nodes.map(toWorkflowNode), nodeId)
      if (imageSource !== storyboardTaskSourceSignature(groupsRef.current, mediaGroupsRef.current.image) || textSource !== storyboardTaskSourceSignature(groupsRef.current, mediaGroupsRef.current.text)
        || signature !== storyboardTaskEditSignature(latest.nodes.map(toWorkflowNode), latest.edges.map(toWorkflowEdge), nodeId, buildCanvasUpstreamReferences(latest.nodes, latest.edges, assetCatalog).get(nodeId) ?? [])) throw new Error('图片、分析节点或生成来源已变化，请重新打开故事板配置')
      const textEdges = graph.edges.filter((edge) => edge.target === nodeId && edge.targetHandle === 'in:text')
      const analysisNode = textEdges.length === 1 ? graph.nodes.find((entry) => entry.id === textEdges[0].source && entry.type === 'text-generate') : undefined
      const session = { scope, task, references, imageSource, textSource, ...(storyboardTaskUsesAnalysis(task) ? { analysis: { model: analysisNode?.data.model ?? '' } } : {}), nodeId, signature }
      storyboardSessionRef.current = session; setStoryboardSession(session)
    } catch (cause) { if (scope === currentWorkshopSetupScope() && revision === storyboardOpenRevisionRef.current) setBanner(cause instanceof Error ? cause.message : '故事板配置无法打开') }
  }, [assertCommerceCurrent, currentWorkshopSetupScope, getGraphSnapshot, assetCatalog])

  const openInteriorEdit = useCallback(async (nodeId: string, scope: string) => {
    const revision = ++interiorOpenRevisionRef.current
    try {
      assertCommerceCurrent(scope)
      const graph = getGraphSnapshot(), node = graph.nodes.find((entry) => entry.id === nodeId)
      if (!node || node.draggable === false || node.disabled) throw new Error('请选择可编辑的室内任务节点')
      assertInteriorNodeEditable(graph.nodes.map(toWorkflowNode), nodeId)
      const task = parseNodeInteriorTask(node.type ?? '', node.data.settings?.interiorTask)
      const order = node.data.settings?.imageReferenceOrder === undefined ? undefined : parseNodeImageReferenceOrder(node.type ?? '', node.data.settings.imageReferenceOrder)
      const upstream = buildCanvasUpstreamReferences(graph.nodes, graph.edges, assetCatalog).get(nodeId) ?? []
      const signature = JSON.stringify([toWorkflowNode(node), graph.edges.filter((edge) => edge.target === nodeId).map(toWorkflowEdge), upstream])
      const slot = order?.slots.find((entry) => entry.role === 'source')
      const actual = slot && 'edgeId' in slot ? upstream.find((entry) => entry.edgeId === slot.edgeId && (entry.outputIndex ?? 0) === slot.outputIndex) : undefined
      const binding: InteriorTaskSourceDraft['binding'] = slot && 'edgeId' in slot ? { kind: 'existing', edgeId: slot.edgeId, outputIndex: slot.outputIndex } : { kind: 'missing' }
      let asset: CanvasImageAssetSummary | undefined
      if (actual?.asset?.assetId && hostBridge().getAssetDetail) {
        const detail = await hostBridge().getAssetDetail!(actual.asset.assetId)
        assertCommerceCurrent(scope)
        if (revision !== interiorOpenRevisionRef.current) return
        if (detail?.mediaType === 'image' && isTemplateImageAsset(detail)) asset = detail
      }
      const group = mediaGroupsRef.current.image
      const models = [...mediaModelsRef.current.image]
      assertCommerceCurrent(scope)
      if (revision !== interiorOpenRevisionRef.current) return
      assertInteriorNodeEditable(getGraphSnapshot().nodes.map(toWorkflowNode), nodeId)
      const source: InteriorTaskSourceDraft = { binding, ...(asset ? { asset } : {}), label: actual?.label, ...(!actual || actual.status !== 'ready' || !asset ? { unavailableReason: '原图片连接已失效或尚未就绪，请重新选择室内图片' } : {}) }
      const session = { scope, task, source, group, models, nodeId, signature }
      interiorSessionRef.current = session; setInteriorSession(session)
    } catch (cause) { if (scope === currentWorkshopSetupScope() && revision === interiorOpenRevisionRef.current) setBanner(cause instanceof Error ? cause.message : '室内配置无法打开') }
  }, [assertCommerceCurrent, currentWorkshopSetupScope, getGraphSnapshot, assetCatalog])

  const openCommerceEdit = useCallback(async (nodeId: string, scope: string) => {
    const revision = ++commerceOpenRevisionRef.current
    try {
      assertCommerceCurrent(scope)
      const graph = getGraphSnapshot(), node = graph.nodes.find((entry) => entry.id === nodeId)
      if (!node || node.draggable === false || node.disabled) throw new Error('请选择可编辑的创作任务节点')
      assertCommerceNodeEditable(graph.nodes.map(toWorkflowNode), nodeId)
      const task = parseNodeCommerceTask(node.type ?? '', node.data.settings?.commerceTask)
      const order = node.data.settings?.imageReferenceOrder === undefined ? undefined : parseNodeImageReferenceOrder(node.type ?? '', node.data.settings.imageReferenceOrder)
      const upstream = buildCanvasUpstreamReferences(graph.nodes, graph.edges, assetCatalog).get(nodeId) ?? []
      const signature = JSON.stringify([toWorkflowNode(node), graph.edges.filter((edge) => edge.target === nodeId).map(toWorkflowEdge), upstream])
      const references: CommerceTaskReferenceDraft[] = []
      for (const role of commerceTaskRoles(task)) {
        const slot = order?.slots.find((entry) => entry.role === role)
        const actual = slot && 'edgeId' in slot ? upstream.find((entry) => entry.edgeId === slot.edgeId && (entry.outputIndex ?? 0) === slot.outputIndex) : undefined
        const binding: CommerceTaskReferenceDraft['binding'] = slot && 'edgeId' in slot ? { kind: 'existing', edgeId: slot.edgeId, outputIndex: slot.outputIndex } : { kind: 'missing' }
        let asset: CanvasImageAssetSummary | undefined
        if (actual?.asset?.assetId && hostBridge().getAssetDetail) {
          const detail = await hostBridge().getAssetDetail!(actual.asset.assetId)
          assertCommerceCurrent(scope)
          if (revision !== commerceOpenRevisionRef.current) return
          if (detail?.mediaType === 'image' && isTemplateImageAsset(detail)) asset = detail
        }
        references.push({ role, binding, ...(asset ? { asset } : {}), label: actual?.label, ...(!actual || actual.status !== 'ready' || !asset ? { unavailableReason: '原图片连接已失效或尚未就绪，请重新选择素材' } : {}) })
      }
      assertCommerceCurrent(scope)
      if (revision !== commerceOpenRevisionRef.current) return
      assertCommerceNodeEditable(getGraphSnapshot().nodes.map(toWorkflowNode), nodeId)
      const session = { scope, task, references, nodeId, signature }
      commerceSessionRef.current = session; setCommerceSession(session)
    } catch (cause) { if (scope === currentWorkshopSetupScope()) setBanner(cause instanceof Error ? cause.message : '创作配置无法打开') }
  }, [assertCommerceCurrent, currentWorkshopSetupScope, getGraphSnapshot, assetCatalog])

  const compareCommerceCandidates = useCallback(async (nodeId: string, scope: string) => {
    if (commerceCompareBusyRef.current) return
    commerceCompareBusyRef.current = true
    try {
      assertCommerceCurrent(scope)
      const graph = getGraphSnapshot(), node = graph.nodes.find((entry) => entry.id === nodeId)
      if ((!node?.data.settings?.commerceTask && !node?.data.settings?.interiorTask && !node?.data.settings?.exteriorTask && !node?.data.settings?.storyboardTask) || node?.data.dirty) throw new Error('请先运行当前创作任务，再对比本批候选')
      if (!node) throw new Error('创作节点已变化')
      const assertEditable = node.data.settings?.storyboardTask ? assertStoryboardNodeEditable : node.data.settings?.exteriorTask ? assertExteriorNodeEditable : node.data.settings?.interiorTask ? assertInteriorNodeEditable : assertCommerceNodeEditable
      assertEditable(graph.nodes.map(toWorkflowNode), nodeId)
      const ids = currentNodeCandidates(nodeId, node.type, node.data, assetCatalog).filter((candidate) => candidate.asset.kind === 'image').map((candidate) => candidate.asset.assetId).filter((id): id is string => Boolean(id))
      if (ids.length < 2 || ids.length > 4 || new Set(ids).size !== ids.length) throw new Error('当前任务需要 2–4 张不同的已保存候选图片')
      const host = hostBridge(), assets: CanvasImageAssetSummary[] = []
      if (!host.getAssetDetail) throw new Error('当前宿主无法核对候选素材')
      for (const id of ids) { const asset = await host.getAssetDetail(id); assertCommerceCurrent(scope); if (!asset || asset.mediaType !== 'image' || !isTemplateImageAsset(asset)) throw new Error('候选图片已失效，请核对素材库'); assets.push(asset) }
      await host.refreshProjectAccess?.(); assertCommerceCurrent(scope)
      const access = host.getProjectAccess?.()
      if (access?.denied || access?.access && !access.access.canEdit) throw new Error('当前工程不可编辑，本次没有创建对比节点')
      const latest = getGraphSnapshot(), now = latest.nodes.find((entry) => entry.id === nodeId)
      assertEditable(latest.nodes.map(toWorkflowNode), nodeId)
      if (!now || now.data.dirty || JSON.stringify(currentNodeCandidates(nodeId, now.type, now.data, assetCatalog).map((candidate) => candidate.asset.assetId)) !== JSON.stringify(ids)) throw new Error('本批候选已变化，请重新打开对比')
      const origin = { x: Math.max(...latest.nodes.map((entry) => entry.position.x + (entry.width ?? 320))) + 100, y: node.position.y }
      const result = buildCommerceCandidateComparison(assets, origin, nextNodeId)
      if (node.data.settings?.interiorTask) result.nodes = result.nodes.map((entry) => entry.kind === 'image-compare' ? { ...entry, data: { ...entry.data, settings: { ...entry.data.settings, title: '室内候选对比' } } } : entry)
      if (node.data.settings?.exteriorTask) result.nodes = result.nodes.map((entry) => entry.kind === 'image-compare' ? { ...entry, data: { ...entry.data, settings: { ...entry.data.settings, title: '室外候选对比' } } } : entry)
      if (node.data.settings?.storyboardTask) result.nodes = result.nodes.map((entry) => entry.kind === 'image-compare' ? { ...entry, data: { ...entry.data, settings: { ...entry.data.settings, title: '故事板候选对比' } } } : entry)
      execute({ type: 'add-nodes', nodes: result.nodes.map((entry) => canvasNodeDocumentRecord(toCanvasNode(entry))), edges: result.edges })
      setBanner('已创建本批候选对比，图片来源已固定，可一次撤销')
      void reactFlow.fitView({ nodes: result.nodes.map((entry) => ({ id: entry.id })), padding: .2, duration: 180, maxZoom: 1 })
    } catch (cause) { if (scope === currentWorkshopSetupScope()) setBanner(cause instanceof Error ? cause.message : '候选对比未创建') }
    finally { commerceCompareBusyRef.current = false }
  }, [assertCommerceCurrent, currentWorkshopSetupScope, getGraphSnapshot, assetCatalog, execute, reactFlow])

  useEffect(() => {
    registerNodeChangeHandlers(withoutUnavailableNodeEntries({
      onEditStoryboardTask: (nodeId, scope) => { void openStoryboardEdit(nodeId, scope) },
      onEditExteriorTask: (nodeId, scope) => { void openExteriorEdit(nodeId, scope) },
      onCompareStoryboardCandidates: (nodeId, scope) => { void compareCommerceCandidates(nodeId, scope) },
      onCompareExteriorCandidates: (nodeId, scope) => { void compareCommerceCandidates(nodeId, scope) },
      onEditInteriorTask: (nodeId, scope) => { void openInteriorEdit(nodeId, scope) },
      onCompareInteriorCandidates: (nodeId, scope) => { void compareCommerceCandidates(nodeId, scope) },
      onEditCommerceTask: (nodeId, scope) => { void openCommerceEdit(nodeId, scope) },
      onCompareCommerceCandidates: (nodeId, scope) => { void compareCommerceCandidates(nodeId, scope) },
      onPromptChange: (nodeId, prompt, promptReferences, editorScope) => applyPromptDraft(nodeId, prompt, false, promptReferences, editorScope),
      onPromptInsert: (nodeId, prompt, promptReferences, editorScope) => applyPromptDraft(nodeId, prompt, true, promptReferences, editorScope),
      onPromptCommit: (nodeId, prompt, promptReferences, editorScope) => applyPromptDraft(nodeId, prompt, false, promptReferences, editorScope),
      onModelChange: (nodeId, model) => {
        const node = getGraphSnapshot().nodes.find((entry) => entry.id === nodeId)
        if (node && ['video', 'video-generate'].includes(node.type ?? '')) changeVideoParameters(nodeId, { model })
        else {
          if (node?.data.group !== undefined) {
            const available = resolveCanvasNodeModelAvailability(node.type ?? '', node.data, { connected: true, sourceCatalog: nodeSourceCatalogRef.current, imageModels: mediaModelsRef.current.image, videoModels: mediaModelsRef.current.video, textModels: mediaModelsRef.current.text })
            if (available.sourceError || !(node.type === 'text-generate' || node.type === 'drama-parse' ? available.textModels : available.imageModels).includes(model)) { setBanner(available.sourceError || '此节点来源不提供所选模型，请重新选择'); return }
          }
          markDirtyFrom(nodeId, { model })
        }
      },
      onSourceChange: changeNodeModelSource,
      onVideoParametersChange: changeVideoParameters,
      onPlaceVideoCandidate: placeVideoCandidate,
      onVideoCandidateCountChange: changeVideoCandidateCount,
      onVideoParametersReset: (nodeId) => changeVideoParameters(nodeId),
      onVideoReferenceOrderChange: changeVideoReferenceOrder,
      onVideoReferenceRemove: removeVideoReference,
      onTextWebSearchChange: (nodeId, enabled) => {
        try {
          if (!draftActionsEnabledRef.current || projectTransitionRef.current || activeRunsRef.current.size || startingRunsRef.current) throw new Error('工程正在切换或运行，请稍后修改联网设置')
          const node = getGraphSnapshot().nodes.find((entry) => entry.id === nodeId)
          if (!node || node.type !== 'text-generate' || node.draggable === false || node.disabled) throw new Error('请选择可编辑的文字生成节点')
          validateTextWebSearchConfiguration(node.type, node.data.model || runGroupsRef.current.textModel || '', enabled)
          markDirtyFrom(nodeId, { textWebSearch: enabled }, true)
        } catch (cause) { setBanner(cause instanceof Error ? cause.message : '联网设置无法修改') }
      },
      onSelectVideoFrame: openFrameSelection,
      onQualityChange: (nodeId, quality) => markDirtyFrom(nodeId, { quality }),
      onImageResolutionChange: (nodeId, imageResolution) => markDirtyFrom(nodeId, { imageResolution }),
      onImageCandidateCountChange: (nodeId, imageCandidateCount) => markDirtyFrom(nodeId, { imageCandidateCount }),
      onSizeChange: (nodeId, size) => markDirtyFrom(nodeId, { size }),
      onSecondsChange: (nodeId, seconds) => markDirtyFrom(nodeId, { seconds }),
      onSelectNode: (nodeId) => setNodes((current) => current.map((node) => ({ ...node, selected: node.id === nodeId }))),
      onTileSettingsChange: changeTileSettings,
      onDownloadTileSource: downloadTileSource,
      onSettingsChange: (nodeId, patch) => {
        const current = getGraphSnapshot()
        const node = current.nodes.find((entry) => entry.id === nodeId)
        if (!node) return
        const keys = Object.keys(patch)
        const viewerOnly = keys.length === 1 && ((node.type === 'image-compare' && keys[0] === 'imageCompare') || (node.type === 'image-panorama' && keys[0] === 'imagePanorama'))
        // A note never runs and has no ports, so editing it leaves nothing waiting for a rerun.
        if (viewerOnly || builtinNodeRegistry.resolve(node.type ?? 'unknown')?.executable === false) {
          // Viewing an existing image must not invalidate results or dirty downstream AI nodes.
          const updated = current.nodes.map((entry) => entry.id === nodeId ? { ...entry, data: { ...entry.data, settings: { ...entry.data.settings, ...patch } } } : entry)
          execute({ type: 'replace-nodes', nodes: updated.map(canvasNodeDocumentRecord) })
          graphRef.current = getGraphSnapshot()
          return
        }
        const staleAppearance = isDramaAssetNodeType(node?.type) && typeof patch.appearance === 'string' && patch.appearance !== node?.data.settings?.appearance
        // An editor's Apply action is one transaction, even beside a recent keystroke.
        markDirtyFrom(nodeId, { settings: { ...node?.data.settings, ...patch } }, Object.hasOwn(patch, 'imageTransform') || Object.hasOwn(patch, 'imageEditMask'))
        if (staleAppearance) {
          setNodes((current) => markDownstreamShotsStale(current, edges, nodeId) as typeof current)
        }
      },
      onAnnotateImage: (nodeId) => {
        annotationLoadingRef.current?.abort()
        const controller = new AbortController()
        annotationLoadingRef.current = controller
        void (async () => {
          try {
            if (!draftActionsEnabledRef.current || projectTransitionRef.current || activeRunsRef.current.size || startingRunsRef.current || pendingRunProjectionIdsRef.current.size) throw new Error('工程正在切换或运行，请稍后标注图片')
            const target = assertAnnotationTarget(getGraphSnapshot().nodes, nodeId)
            const sourceAssetId = target.data.result!.assetId!
            const scope = layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
            const host = hostBridge()
            if (!host.getAssetDetail || !host.renderImageAnnotation) throw new Error('当前宿主尚不支持图片标注，请更新后重试')
            setBanner('正在读取标注原图')
            const asset = await host.getAssetDetail(sourceAssetId, controller.signal)
            controller.signal.throwIfAborted()
            assertLayerEditorScope(scope, { ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
            if (projectTransitionRef.current || activeRunsRef.current.size || startingRunsRef.current || pendingRunProjectionIdsRef.current.size) throw new Error('工程已开始运行，请等待完成后再标注')
            assertAnnotationTarget(getGraphSnapshot().nodes, nodeId, sourceAssetId)
            if (asset.mediaType !== 'image' || asset.assetId !== sourceAssetId || asset.deletedAt) throw new Error('原图已回收或不可读取，请先在素材库核对')
            const session = { nodeId, asset, scope }
            annotationSessionRef.current = session; setAnnotationSession(session)
            setBanner('图片标注已打开')
          } catch (cause) { if (!controller.signal.aborted) setBanner(cause instanceof Error ? cause.message : '标注编辑器暂时无法打开') }
          finally { if (annotationLoadingRef.current === controller) annotationLoadingRef.current = null }
        })()
      },
      onEditImageMask: (nodeId, from) => {
        try {
          if (!draftActionsEnabledRef.current || projectTransitionRef.current || running || startingRunsRef.current) throw new Error('工程正在切换或运行，请稍后编辑蒙版')
          const current = getGraphSnapshot()
          const target = current.nodes.find((node) => node.id === nodeId)
          if (!target || target.draggable === false) throw new Error('节点已锁定或删除，请重新选择')
          const source = resolveImageMaskSource(current.nodes, current.edges, nodeId, from)
          const initial = from === 'input' ? parseNodeImageEditMask(target.type ?? '', target.data.settings?.imageEditMask) : undefined
          const scope = layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
          const session = { nodeId, from, source, scope, initial }
          imageMaskSessionRef.current = session
          setImageMaskSession(session)
        } catch (cause) { setBanner(cause instanceof Error ? cause.message : '蒙版编辑器暂时无法打开') }
      },
      onLayerPsdApply: (nodeId, input, editorScope) => {
        assertLayerEditorScope(editorScope, { ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
        if (projectTransitionRef.current || running || startingRunsRef.current) throw new Error('工程正在切换或运行，请等待完成后再应用图层')
        const current = getGraphSnapshot()
        const applied = buildLayerPsdGraph(current.nodes, current.edges, nodeId, input, nextNodeId)
        execute({ type: 'replace-graph', nodes: applied.nodes.map(canvasNodeDocumentRecord), edges: applied.edges.map((edge) => ({ id: edge.id, source: edge.source, sourceHandle: edge.sourceHandle ?? '', target: edge.target, targetHandle: edge.targetHandle ?? '' })) })
        graphRef.current = getGraphSnapshot()
        setDirtyNodeIds(dirtyCanvasNodeIds(graphRef.current.nodes))
        void refreshAssets()
        setBanner(applied.importedCount ? `已应用图层并接入 ${applied.importedCount} 张图片素材，可一步撤销` : '已应用图层；撤销掉的导入图层未接入画布')
      },
      onDramaAction: (nodeId, action) => {
        const node = nodes.find((entry) => entry.id === nodeId)
        if (!node) return
        if (action === 'toggle-lock') {
          const locked = node.data.settings?.locked !== true
          markDirtyFrom(nodeId, { settings: { ...node.data.settings, locked } })
          return
        }
        if (action === 'compile-sheet' && isDramaAssetNodeType(node.type)) {
          const bible = nodes.find((entry) => entry.type === 'drama-bible')
          const asset = readDramaAsset(node.data.settings, dramaAssetKindForType(node.type), node.data.prompt)
          const sheetPrompt = compileAssetSheetPrompt(asset, bible ? readDramaBible(bible.data.settings, bible.data.prompt) : undefined)
          markDirtyFrom(nodeId, { prompt: sheetPrompt, settings: { ...dramaAssetSettings({ ...asset, sheetPrompt }), locked: asset.locked === true } })
          return
        }
        if (action === 'place-image' && isDramaAssetNodeType(node.type)) {
          const imageNode = createNode('image-generate', { x: node.position.x + 340, y: node.position.y }, {
            prompt: node.data.prompt,
            ...(node.type === 'drama-character' ? { size: '1536x1152' } : {}),
          })
          if (!imageNode) return
          execute({
            type: 'add-nodes',
            nodes: [canvasNodeDocumentRecord(imageNode)],
            edges: [{
              id: nextNodeId(),
              source: node.id,
              sourceHandle: 'out:text',
              target: imageNode.id,
              targetHandle: 'in:text',
            }],
          })
          return
        }
        if (action === 'compile-shot' && node.type === 'drama-shot') {
          const compiled = compileConnectedShotPrompt(nodes, edges, node)
          const resolved = resolveDramaShotGate(nodes, edges, node.id)
          markDirtyFrom(nodeId, {
            prompt: compiled,
            settings: {
              ...dramaShotSettings({ ...readDramaShot(node.data.settings, node.data.prompt), compiledImagePrompt: compiled, gate: resolved.gate }),
            },
          })
        }
      },
      onTextAction: textNodeAction,
      onSavePromptPreset: (nodeId) => void savePromptPreset(nodeId),
      onRunToNode: (nodeId) => void rerunNode(nodeId),
      onPlaceOutput: placeNodeOutput,
      onProcessAndPlaceOutput: (nodeId) => { requestNodeScopeRun(nodeId, 'to-node', true) },
      onRunFromNode: runFromNode,
      onDeleteNode: (nodeId) => deleteNodesBridging([nodeId]),
      onDownloadAsset: (nodeId) => void downloadNodeAsset(nodeId),
      onShowAssetMenu: (nodeId) => void showNodeAssetMenu(nodeId),
      onResumeTask: (nodeId) => void resumeTask(nodeId),
      onSelectCandidate: useCandidate,
      onShowCandidateMenu: (assetId) => void hostBridge().showAssetMenu(assetId),
      onBindAsset: (nodeId, assetId) => {
        const asset = assetPage.items.find((entry) => entry.assetId === assetId)
        if (asset) bindAssetToNode(nodeId, asset)
      },
      onPickAsset: (nodeId) => void pickAssetForNode(nodeId),
      onImportAssetFile: (nodeId, file) => void importAssetForNode(nodeId, file),
      onPreviewAsset: setPreviewAsset,
      onDisconnectIncoming: (edgeId) => execute({ type: 'disconnect', edgeIds: [edgeId] }),
      onMediaMetadata: (nodeId, assetId, width, height, durationSeconds) => {
        if (!mediaPreparationMountedRef.current || !draftActionsEnabledRef.current || projectTransitionRef.current) return
        // Decoded metadata enriches the asset; it is not a user edit. The
        // controller seeds this live graph before commands/undo/redo, so it
        // remains saved without adding or merging a separate history entry.
        setNodes((current) => {
          const target = current.find((node) => node.id === nodeId)
          if (target?.data.result?.assetId !== assetId || !['image', 'video', 'audio'].includes(target.data.result.kind)) return current
          const nextWidth = Number.isInteger(width) && width > 0 ? width : target.data.result.width
          const nextHeight = Number.isInteger(height) && height > 0 ? height : target.data.result.height
          const nextDuration = typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds > 0 && durationSeconds <= 86_400
            ? durationSeconds
            : target.data.result.durationSeconds ?? requestedClipDurationSeconds(target.data.seconds)
          const result = {
            ...target.data.result,
            ...(nextWidth ? { width: nextWidth } : {}),
            ...(nextHeight ? { height: nextHeight } : {}),
            ...(nextDuration ? { durationSeconds: nextDuration } : {}),
          }
          const dimensions = usesMediaBoundLayout(target.type ?? '', result.assetId)
            ? mediaAssetNodeDimensions(result, target.data.size)
            : null
          if (target.data.result.width === result.width && target.data.result.height === result.height
            && target.data.result.durationSeconds === result.durationSeconds
            && (!dimensions || (target.width === dimensions.width && target.height === dimensions.height))) return current
          return current.map((node) => node.id === nodeId
            ? {
                ...node,
                ...(dimensions ? {
                  width: dimensions.width,
                  height: dimensions.height,
                  style: { ...node.style, width: dimensions.width, height: dimensions.height },
                } : {}),
                data: { ...node.data, result },
              }
            : node)
        })
      },
      isPortCompatible: (connection) => isValidWorkflowConnection(connection, {
        nodeKindOf: (id) => (nodes.find((entry) => entry.id === id)?.type as NodeKind | undefined) ?? null,
        edges,
      }),
    }, hostEntryPoints))
  }, [nodes, edges, execute, getGraphSnapshot, running, refreshAssets, assetQuery, applyPromptDraft, markDirtyFrom, savePromptPreset, textNodeAction, rerunNode, runFromNode, deleteNodesBridging, downloadNodeAsset, showNodeAssetMenu, resumeTask, useCandidate, assetPage.items, bindAssetToNode, pickAssetForNode, importAssetForNode, changeTileSettings, downloadTileSource, placeNodeOutput, placeVideoCandidate, requestNodeScopeRun, openFrameSelection, changeNodeModelSource, changeVideoParameters, changeVideoCandidateCount, changeVideoReferenceOrder, removeVideoReference, openCommerceEdit, openInteriorEdit, openExteriorEdit, openStoryboardEdit, compareCommerceCandidates, hostEntryPoints.imageAnnotation, hostEntryPoints.videoFrames])

  const createNode = (type: string, position?: XYPosition, config: Record<string, unknown> = {}): CanvasNode | null => {
    const kind = type as NodeKind
    const definition = builtinNodeRegistry.resolve(type)
    const capabilities = canvasCapabilities()
    if (!definition || kind === 'unknown' || !canvasNodeKindAvailable(type, capabilities)) return null
    const preferredModel = preferredModelForNodeType(type, mediaGroups)
    const node: WorkflowNode = {
      id: nextNodeId(),
      kind,
      definitionVersion: definition.version,
      position: position ?? { x: 120 + Math.random() * 240, y: 120 + Math.random() * 160 },
      width: definition.dimensions.width,
      height: definition.dimensions.height,
      data: withoutHostDisabledDefaults(workflowNodeData(type, {
        ...imageOperationDefaults(type, imageModels, videoModels, preferredModel ? { model: preferredModel } : {}),
        ...((['image', 'image-generate', 'image-edit'].includes(type) && imageModels.length === 0) || (['video', 'video-generate'].includes(type) && videoModels.length === 0) ? { model: '' } : {}),
        ...config,
      }, true), capabilities),
    }
    return toCanvasNode(node)
  }

  const saveImageAnnotation = async (recipe: ImageLayerRecipe, mode: 'replace' | 'new' | 'download', signal: AbortSignal) => {
    const session = annotationSession
    function assertCurrent() {
      signal.throwIfAborted()
      if (!session || annotationSessionRef.current !== session) throw new Error('此次标注已关闭，请重新打开')
      assertLayerEditorScope(session.scope, { ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
      if (projectTransitionRef.current || activeRunsRef.current.size || startingRunsRef.current || pendingRunProjectionIdsRef.current.size) throw new Error('工程正在切换或运行，请等待完成后保存标注')
      assertAnnotationTarget(getGraphSnapshot().nodes, session.nodeId, session.asset.assetId)
    }
    assertCurrent()
    if (!session || annotationSavingRef.current) throw new Error('标注正在保存，请等待完成')
    const host = hostBridge()
    if (!host.renderImageAnnotation) throw new Error('当前宿主尚不支持图片标注')
    annotationSavingRef.current = true
    try {
      const output = await host.renderImageAnnotation({ sourceAssetId: session.asset.assetId, recipe }, signal)
      assertCurrent()
      if (mode === 'download') { downloadAnnotationPng(output.blob); return }
      const uploaded = importedAssetSummary(await host.importAssetFile(new File([output.blob], '星芒-图片标注.png', { type: 'image/png' }), { mediaType: 'image' }))
      assertCurrent()
      if (uploaded.mediaType !== 'image' || uploaded.mimeType !== 'image/png' || uploaded.deletedAt
        || !/^[A-Za-z0-9_-]{43}$/.test(uploaded.assetId) || uploaded.localUrl !== `xingmang-asset://image/${uploaded.assetId}`
        || (uploaded.width !== undefined && uploaded.width !== output.width) || (uploaded.height !== undefined && uploaded.height !== output.height)) throw new Error('保存的标注信息不一致，当前画布没有改变；请在素材库核对')
      // Generic uploads omit dimensions. These dimensions belong to the exact
      // PNG just decoded and rendered by the host, not to stale source metadata.
      const saved: CanvasImageAssetSummary = { ...uploaded, width: output.width, height: output.height }
      if (mode === 'replace') {
        const current = getGraphSnapshot()
        const updated = replaceAnnotatedImage(current.nodes, current.edges, session.nodeId, session.asset.assetId, saved)
        execute({ type: 'replace-nodes', nodes: updated.map(canvasNodeDocumentRecord) })
        graphRef.current = getGraphSnapshot()
        setNodes(updated)
        setDirtyNodeIds(dirtyCanvasNodeIds(updated))
      } else {
        const before = new Set(getGraphSnapshot().nodes.map((node) => node.id))
        createAssetNode(saved)
        const added = getGraphSnapshot().nodes.find((node) => !before.has(node.id))
        if (added) setNodes((current) => current.map((node) => ({ ...node, selected: node.id === added.id })))
      }
      void markCanvasAssetUsed(saved.assetId)
      void refreshAssets()
      setBanner(mode === 'replace' ? '标注已保存，可一步撤销；重新运行此节点会替换结果，继续使用标注请另存为独立图片' : '标注已另存为独立图片节点，可接入下游继续创作；一步撤销可移除节点')
    } finally { annotationSavingRef.current = false }
  }

  const saveImageMaskAsset = async (maskInput: ImageEditMask, png: ImageMaskAssetPng, signal: AbortSignal, mode: MaskAssetSaveMode = 'new') => {
    const session = imageMaskSession
    const receipts = imageMaskExportReceiptsRef.current
    const mask = parseImageEditMask(maskInput)
    function assertCurrent() {
      signal.throwIfAborted()
      if (!['new', 'linked', 'replace'].includes(mode)) throw new Error('蒙版保存方式无效，请重新选择')
      if (!session || imageMaskSessionRef.current !== session) throw new Error('此次蒙版编辑已结束，请重新打开')
      if (mode === 'replace' && session.from !== 'output') throw new Error('保存当前图片需要从当前结果重新打开蒙版编辑器；输入原图不会被替换')
      assertLayerEditorScope(session.scope, { ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
      if (!mediaPreparationMountedRef.current || !projectCanEditRef.current) throw new Error('当前工程已关闭或没有编辑权限；已保存素材可在素材库核对')
      if (projectTransitionRef.current || activeRunsRef.current.size || startingRunsRef.current || pendingRunProjectionIdsRef.current.size) throw new Error('工程正在切换或运行，请等待完成后另存蒙版')
      const current = getGraphSnapshot()
      assertMaskAssetSource(current.nodes, current.edges, session, mask)
    }
    assertCurrent()
    if (!session || imageMaskExportSavingRef.current) throw new Error('蒙版正在保存，请等待完成')
    imageMaskExportSavingRef.current = true
    try {
      await assertMaskAssetPng(mask, png, signal)
      assertCurrent()
      const key = JSON.stringify([session.scope, session.nodeId, session.from, session.source.sourceNodeId, mask])
      const previous = receipts.get(key)
      if (previous?.status === 'unknown') throw new Error('此次蒙版上传结果尚未确认，请先到素材库核对；相同蒙版不会自动再次上传')
      const host = hostBridge()
      let saved: CanvasImageAssetSummary
      if (previous?.status === 'saved') {
        if (!host.getAssetDetail) throw new Error('当前宿主无法核对已保存的蒙版，请到素材库查看')
        saved = parseMaskAssetUpload(await host.getAssetDetail(previous.asset.assetId, signal), png)
        if (saved.assetId !== previous.asset.assetId) throw new Error('已保存蒙版的身份无法确认，请到素材库核对')
      } else {
        // A generic upload has no idempotency lookup. Keep the unknown marker
        // until a validated receipt arrives; retries must not invent a new POST.
        for (const [receiptKey, receipt] of receipts) {
          if (receipts.size < 32) break
          if (receipt.status === 'saved') receipts.delete(receiptKey)
        }
        if (receipts.size >= 32) throw new Error('有多次蒙版保存结果待核对，请先在素材库核对后重新打开工程')
        receipts.set(key, { status: 'unknown' })
        try {
          const uploaded = importedAssetSummary(await host.importAssetFile(new File([png.blob], `星芒-黑白蒙版-${png.width}x${png.height}.png`, { type: 'image/png' }), { mediaType: 'image' }))
          saved = parseMaskAssetUpload(uploaded, png)
          receipts.set(key, { status: 'saved', asset: saved })
        } catch {
          throw new Error('蒙版上传结果尚未确认，请先到素材库核对；画布没有改变，系统不会自动再次上传')
        }
      }
      assertCurrent()
      const current = getGraphSnapshot()
      let command: CanvasCommand
      let savedNodeId: string
      let replacementData: CanvasNode['data'] | undefined
      if (mode === 'replace') {
        const updated = replaceMaskAssetNode(current.nodes, current.edges, session, saved)
        command = { type: 'replace-nodes', nodes: updated.map(canvasNodeDocumentRecord) }
        savedNodeId = session.nodeId
        replacementData = updated.find((node) => node.id === savedNodeId)!.data
      } else if (mode === 'linked') {
        const generated = createNode('image-generate')
        if (!generated) throw new Error('当前页面无法创建关联图像节点，请刷新后重试')
        const edgeId = nextNodeId()
        if (current.edges.some((edge) => edge.id === edgeId)) throw new Error('新蒙版连线编号已存在，请重试')
        command = buildLinkedMaskAssetNode(current.nodes, session, saved, generated.id, edgeId, generated.data)
        savedNodeId = generated.id
      } else {
        const added = buildMaskAssetNode(current.nodes, session, saved, nextNodeId())
        command = added
        savedNodeId = added.nodes[0].id
      }
      execute(command)
      const applied = getGraphSnapshot()
      const savedNode = applied.nodes.find((node) => node.id === savedNodeId)
      if (savedNode?.data.result?.assetId !== saved.assetId) throw new Error('蒙版素材已保存，但节点尚未加入画布或更新；请核对工程编辑权限后重试或从素材库添加')
      if (mode === 'linked' && command.type === 'add-nodes' && command.edges?.some((expected) => !applied.edges.some((edge) => edge.id === expected.id && edge.source === expected.source && edge.sourceHandle === expected.sourceHandle && edge.target === expected.target && edge.targetHandle === expected.targetHandle))) throw new Error('蒙版已保存，但原图关联尚未完成，请撤销本次添加后重新保存或从素材库复用')
      imageMaskSessionRef.current = null
      setImageMaskSession(null)
      // Candidate objects are runtime projections. The document command stores
      // their asset order; publish the manual replacement only after that
      // command is confirmed, without carrying the old model receipt forward.
      setNodes((entries) => entries.map((entry) => ({ ...entry, ...(entry.id === savedNodeId && replacementData ? { data: replacementData } : {}), selected: entry.id === savedNodeId })))
      graphRef.current = getGraphSnapshot()
      if (mode === 'replace') setDirtyNodeIds(dirtyCanvasNodeIds(graphRef.current.nodes))
      void markCanvasAssetUsed(saved.assetId)
      void refreshAssets()
      setBanner(mode === 'replace' ? '蒙版已保存至当前图片，可一步撤销；其他候选、输入与生成参数保留' : mode === 'linked' ? '蒙版已另存并关联原图，可一步撤销；后续生成需填写指令并另行确认，直接复用成品可另存独立图片' : '黑白蒙版已另存为图片素材和独立节点，可继续连接下游；一步撤销只移除节点，素材仍保留')
      if (mode !== 'replace') createdNodeFocusRef.current?.start(savedNodeId, { width: savedNode.width!, height: savedNode.height! }, (target) => {
        const scope = layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
        if (session.scope !== scope || projectTransitionRef.current) return
        const flow = currentReactFlowRef.current
        const bounds = document.querySelector('.canvas-flow')?.getBoundingClientRect()
        void flow.setCenter(target.x + target.width / 2, target.y + target.height / 2, { zoom: createdNodeFocusZoom(target, bounds, flow.getViewport().zoom), duration: 180 })
      })
    } finally { imageMaskExportSavingRef.current = false }
  }

  const applyImageMask = (maskInput: ImageEditMask) => {
    const session = imageMaskSession
    if (!session || imageMaskSessionRef.current !== session) throw new Error('此次蒙版编辑已结束，请重新打开')
    assertLayerEditorScope(session.scope, { ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
    if (projectTransitionRef.current || running || startingRunsRef.current) throw new Error('工程正在切换或运行，请等待完成后保存蒙版')
    const current = getGraphSnapshot()
    const target = current.nodes.find((node) => node.id === session.nodeId)
    if (!target || target.draggable === false) throw new Error('节点已锁定或删除，请重新打开蒙版编辑器')
    const latest = resolveImageMaskSource(current.nodes, current.edges, session.nodeId, session.from)
    if (latest.sourceNodeId !== session.source.sourceNodeId || latest.asset.assetId !== session.source.asset.assetId) throw new Error('原图已变化，请取消并重新打开蒙版编辑器核对')
    const mask = parseImageEditMask(maskInput)
    if (mask.sourceAssetId !== latest.asset.assetId) throw new Error('蒙版与当前原图不匹配，请重新确认适配')
    if (session.from === 'input') {
      imageMaskSessionRef.current = null
      markDirtyFrom(target.id, { settings: { ...target.data.settings, imageEditMask: mask } }, true)
      setBanner('蒙版已保存；填写修改指令后生成，原图会保留')
    } else {
      const absolute = reactFlow.getInternalNode(target.id)?.internals.positionAbsolute ?? target.position
      const definition = builtinNodeRegistry.require('image-edit')
      const position = findAvailableCanvasPosition(current.nodes, { x: absolute.x + (target.width ?? 280) + 220, y: absolute.y + 120 }, definition.dimensions)
      const preferred = imageEditMaskModelSupported(target.data.model) ? target.data.model : imageModels.find((model) => imageEditMaskModelSupported(model))
      const node = createNode('image-edit', position, { imageEditMask: mask, prompt: '', ...(preferred ? { model: preferred } : {}) })
      if (!node) throw new Error('无法创建局部修改节点')
      imageMaskSessionRef.current = null
      execute({ type: 'add-nodes', nodes: [canvasNodeDocumentRecord(node)], edges: [{ id: nextNodeId(), source: latest.sourceNodeId, sourceHandle: 'out:image', target: node.id, targetHandle: 'in:images' }] })
      graphRef.current = getGraphSnapshot()
      setNodes((entries) => entries.map((entry) => ({ ...entry, selected: entry.id === node.id })))
      setBanner('已创建局部修改节点并连接当前单图；填写修改指令后生成，可一次撤销')
      window.requestAnimationFrame(() => {
        const scope = layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
        if (session.scope === scope && !projectTransitionRef.current) void reactFlow.fitView({ nodes: [{ id: node.id }], padding: 0.3, duration: 180, maxZoom: 1 })
      })
    }
    setImageMaskSession(null)
  }

  const addNode = (type: string, position?: XYPosition, config: Record<string, unknown> = {}) => {
    if (!projectCanEditRef.current) { setBanner('当前项目只读，可平移、缩放、预览和导出'); return }
    const definition = builtinNodeRegistry.resolve(type)
    if (!definition) return
    const bounds = document.querySelector('.canvas-flow')?.getBoundingClientRect()
    const preferredCenter = bounds
      ? reactFlow.screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 })
      : { x: 420, y: 300 }
    // Ordinary quick creation keeps the requested top-left point when free.
    // Read the live graph: uploads and consecutive adds can precede a render.
    const insertionCenter = position ? { x: position.x + definition.dimensions.width / 2, y: position.y + definition.dimensions.height / 2 } : preferredCenter
    const resolvedPosition = findAvailableCanvasPosition(getGraphSnapshot().nodes.map((entry) => {
      const fallback = builtinNodeRegistry.resolve(entry.type ?? 'unknown')?.dimensions
      return { ...entry, width: entry.width ?? fallback?.width, height: entry.height ?? fallback?.height }
    }), insertionCenter, definition.dimensions)
    const node = createNode(type, resolvedPosition, config)
    if (!node) return
    execute({ type: 'add-nodes', nodes: [canvasNodeDocumentRecord(node)] })
    setNodes((current) => current.map((entry) => ({ ...entry, selected: entry.id === node.id })))
    createdNodeFocusRef.current?.start(node.id, definition.dimensions, (target) => {
      const viewportBounds = document.querySelector('.canvas-flow')?.getBoundingClientRect()
      const viewportTransform = reactFlow.getViewport()
      if (!viewportBounds || position && !createdNodeNeedsFocus(target, viewportBounds, viewportTransform)) return
      void reactFlow.setCenter(
        target.x + target.width / 2,
        target.y + target.height / 2,
        { zoom: createdNodeFocusZoom(target, viewportBounds, viewportTransform.zoom), duration: 180 },
      )
    })
  }

  const addConnectedNode = (
    type: string,
    position: XYPosition | undefined,
    pending: PendingCanvasConnection,
    insertedHandleId: string,
  ) => {
    const node = createNode(type, position)
    if (!node) return
    const connection = connectionForInsertedNode(pending, node.id, insertedHandleId)
    const prospectiveTypes = new Map<string, string>(nodes.map((entry) => [entry.id, entry.type ?? 'unknown']))
    prospectiveTypes.set(node.id, type as NodeKind)
    if (!isValidWorkflowConnection(connection, {
      nodeKindOf: (nodeId) => prospectiveTypes.get(nodeId) ?? null,
      edges,
    })) {
      setBanner('当前端口已无法连接，请重新拖动连线')
      return
    }
    execute({
      type: 'add-nodes',
      nodes: [canvasNodeDocumentRecord(node)],
      edges: [{
        id: nextNodeId(),
        source: connection.source,
        sourceHandle: connection.sourceHandle ?? '',
        target: connection.target,
        targetHandle: connection.targetHandle ?? '',
      }],
    })
    setNodes((current) => current.map((entry) => ({ ...entry, selected: entry.id === node.id })))
    window.requestAnimationFrame(() => { void reactFlow.fitView({ nodes: [{ id: pending.nodeId }, { id: node.id }], padding: 0.2, duration: 180, maxZoom: 1 }) })
    setBanner(`已创建并连接「${builtinNodeRegistry.require(type).title}」`)
  }

  const openBatchImageRelated = useCallback((sourceIds: readonly string[], scope = layerEditorScope, preferredCenter?: XYPosition) => {
    const currentScope = layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
    if (!mediaPreparationMountedRef.current || !draftActionsEnabledRef.current || projectTransitionRef.current || scope !== currentScope) return
    const current = getGraphSnapshot()
    const analysis = analyzeBatchImageRelatedSources(current.nodes.map(canvasNodeDocumentRecord), sourceIds)
    if (analysis.disabledReason) { setBanner(analysis.disabledReason); return }
    const session = { sources: analysis.sources, scope, preferredCenter }
    batchImageRelatedRef.current = session
    setBatchImageRelated(session)
    setBatchImageRelatedError(undefined)
    setQuickInsert(null)
    setContextMenu(null)
  }, [getGraphSnapshot, layerEditorScope])

  const confirmBatchImageRelated = useCallback((type: BatchImageRelatedTarget) => {
    const session = batchImageRelated
    const currentScope = layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
    if (!session || batchImageRelatedRef.current !== session || !mediaPreparationMountedRef.current || !draftActionsEnabledRef.current || projectTransitionRef.current || session.scope !== currentScope) return
    try {
      const current = getGraphSnapshot()
      const records = current.nodes.map(canvasNodeDocumentRecord)
      const latest = analyzeBatchImageRelatedSources(records, session.sources.map((source) => source.id))
      if (latest.disabledReason) throw new Error(latest.disabledReason)
      const definition = builtinNodeRegistry.require(type)
      const position = findAvailableCanvasPosition(current.nodes, session.preferredCenter ?? batchImageRelatedCenter(latest.sources), definition.dimensions)
      const node = createNode(type, position, batchImageRelatedConfig(type, session.sources.length))
      if (!node) throw new Error('无法创建关联图片工具')
      const command = buildBatchImageRelatedCommand({ nodes: records, edges: current.edges.map(toWorkflowEdge), sources: session.sources, target: canvasNodeDocumentRecord(node), edgeIds: session.sources.map(() => nextNodeId()) })
      // Consume this exact dialog before commit: a retained or double-clicked
      // callback cannot append a second node or target a reopened project.
      batchImageRelatedRef.current = null
      execute(command)
      graphRef.current = getGraphSnapshot()
      setNodes((entries) => entries.map((entry) => ({ ...entry, selected: entry.id === node.id })))
      setBatchImageRelated(null)
      setBatchImageRelatedError(undefined)
      setBanner(`已创建「${definition.title}」并连接 ${session.sources.length} 张单图；尚未运行，可一次撤销`)
      window.requestAnimationFrame(() => {
        const scope = layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
        if (mediaPreparationMountedRef.current && draftActionsEnabledRef.current && session.scope === scope && !projectTransitionRef.current) void reactFlow.fitView({ nodes: [{ id: node.id }], padding: 0.3, duration: 180, maxZoom: 1 })
      })
    } catch (error) { setBatchImageRelatedError(error instanceof Error ? error.message : '关联创建失败，当前画布未改变') }
  }, [batchImageRelated, getGraphSnapshot, createNode, execute, setNodes, reactFlow])

  const insertNodeOnEdge = (
    type: string,
    position: XYPosition | undefined,
    edgeId: string,
    handles: string,
  ) => {
    const [inputHandle, outputHandle] = handles.split('|')
    if (!inputHandle || !outputHandle) return
    const original = edges.find((edge) => edge.id === edgeId)
    const node = createNode(type, position)
    if (!original || !node) return
    const before = {
      id: nextNodeId(),
      source: original.source,
      sourceHandle: original.sourceHandle ?? '',
      target: node.id,
      targetHandle: inputHandle,
    }
    const after = {
      id: nextNodeId(),
      source: node.id,
      sourceHandle: outputHandle,
      target: original.target,
      targetHandle: original.targetHandle ?? '',
    }
    const prospectiveTypes = new Map(nodes.map((entry) => [entry.id, entry.type ?? 'unknown']))
    prospectiveTypes.set(node.id, type as NodeKind)
    const remainingEdges = edges.filter((edge) => edge.id !== edgeId)
    if (!isValidWorkflowConnection(before, { nodeKindOf: (nodeId) => prospectiveTypes.get(nodeId) ?? null, edges: remainingEdges })
      || !isValidWorkflowConnection(after, { nodeKindOf: (nodeId) => prospectiveTypes.get(nodeId) ?? null, edges: [...remainingEdges, before] })) {
      setBanner('该节点无法插入当前连线')
      return
    }
    execute({ type: 'insert-node-on-edge', node: canvasNodeDocumentRecord(node), edgeId, before, after })
    setBanner(`已在连线上插入「${builtinNodeRegistry.require(type).title}」`)
  }

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return
    execute({
      type: 'connect',
      edge: {
        id: nextNodeId(),
        source: connection.source,
        sourceHandle: connection.sourceHandle ?? '',
        target: connection.target,
        targetHandle: connection.targetHandle ?? '',
      },
    })
  }, [execute])

  const onCanvasNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    // ResizeObserver deliveries must not synchronously publish unrelated UI
    // state. The document controller schedules measurements and keeps explicit
    // resize gestures synchronous without going through drag snapping.
    if (changes.length > 0 && changes.every((change) => change.type === 'dimensions')) {
      onNodesChange(changes)
      return
    }
    if (altDragSessionRef.current && changes.some((change) => change.type === 'position')) {
      // Preview the copied gesture without recording movement for the originals.
      // The final frame is committed as one add-nodes history entry on drag stop.
      setNodes((current) => applyNodeChanges(changes, current))
      return
    }
    if (uiPreferences.snapEnabled === false) { setSnapGuides([]); onNodesChange(changes); return }
    // Snapping happens here rather than in onNodeDrag because this is the frame
    // the document records. Adjusting the view afterwards only moved the pixels.
    const boxes = reactFlow.getNodes().map(snapBoxOfCanvasNode)
    const groupIds = new Set(reactFlow.getNodes().filter((entry) => entry.type === 'group').map((entry) => entry.id))
    const snapped = snapDragPositionChanges(changes, {
      all: boxes,
      candidates: boxes.filter((entry) => !groupIds.has(entry.id)),
    })
    setSnapGuides(snapped.guides)
    onNodesChange(snapped.changes)
  }, [onNodesChange, reactFlow, setNodes, uiPreferences.snapEnabled])

  const onCanvasNodeDragStart = useCallback((event: MouseEvent | TouchEvent, node: CanvasNode, draggedNodes: CanvasNode[]) => {
    createdNodeFocusRef.current?.cancel()
    if (!('altKey' in event) || !event.altKey) return
    const sources = draggedNodes.length > 0 ? draggedNodes : [node]
    altDragSessionRef.current = {
      nodeIds: sources.map((entry) => entry.id),
      originalPositions: new Map(sources.map((entry) => [entry.id, { ...entry.position }])),
      preserveInputConnections: event.shiftKey,
    }
  }, [])

  // Endpoint coordinates for cutting wires and for dropping a node onto one.
  // The offsets come from the same module the handles are rendered from, so a
  // node with several ports is hit tested where its wires actually attach.
  const edgeEndpoints = useCallback(() => {
    if (uiPreferences.connectionsHidden) return []
    const byId = new Map(reactFlow.getNodes().map((entry) => [entry.id, entry]))
    return edges.flatMap((edge) => {
      const source = byId.get(edge.source)
      const target = byId.get(edge.target)
      if (!source || !target) return []
      const sourceBox = snapBoxOfCanvasNode(source)
      const targetBox = snapBoxOfCanvasNode(target)
      return [{
        id: edge.id,
        source: edge.source,
        sourceHandle: edge.sourceHandle,
        target: edge.target,
        targetHandle: edge.targetHandle,
        sourcePoint: {
          x: sourceBox.x + sourceBox.width,
          y: sourceBox.y + portOffsetY(portGeometryOfCanvasNode(source, sourceBox.height), 'output', edge.sourceHandle),
        },
        targetPoint: {
          x: targetBox.x,
          y: targetBox.y + portOffsetY(portGeometryOfCanvasNode(target, targetBox.height), 'input', edge.targetHandle),
        },
      }]
    })
  }, [edges, reactFlow, uiPreferences.connectionsHidden])

  // Ctrl-drag across wires to cut them. Tracked in flow coordinates so the
  // stroke stays aligned with the edges even if the canvas pans mid-gesture.
  const beginCutStroke = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return
    if (event.button !== 0) return
    if (!(event.target instanceof Element) || !event.target.classList.contains('react-flow__pane')) return
    event.preventDefault()
    event.stopPropagation()
    let stroke: Point[] = [reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY })]
    setCutStroke(stroke)

    const onMove = (moveEvent: PointerEvent) => {
      stroke = [...stroke, reactFlow.screenToFlowPosition({ x: moveEvent.clientX, y: moveEvent.clientY })]
      setCutStroke(stroke)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setCutStroke([])
      const cut = edgesCrossedByStroke(stroke, edgeEndpoints())
      if (cut.length === 0) return
      execute({ type: 'disconnect', edgeIds: cut })
      setBanner(`已剪断 ${cut.length} 条连线`)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [edgeEndpoints, execute, reactFlow])

  const spliceNodeOntoEdge = useCallback((nodeId: string, edgeId: string) => {
    const original = edges.find((entry) => entry.id === edgeId)
    const node = nodes.find((entry) => entry.id === nodeId)
    if (!original || !node) return
    const definition = builtinNodeRegistry.resolve(node.type ?? 'unknown')
    if (!definition) return
    const kind = handleKind(original.sourceHandle)
    const input = definition.ports.find((port) => port.direction === 'input' && port.kind === kind)
    const output = definition.ports.find((port) => port.direction === 'output' && port.kind === handleKind(original.targetHandle))
    if (!input || !output) {
      setBanner('该节点没有可以接上这条连线的端口')
      return
    }
    const before = { id: nextNodeId(), source: original.source, sourceHandle: original.sourceHandle ?? '', target: nodeId, targetHandle: input.id }
    const after = { id: nextNodeId(), source: nodeId, sourceHandle: output.id, target: original.target, targetHandle: original.targetHandle ?? '' }
    const remaining = edges.filter((entry) => entry.id !== edgeId)
    const view = { nodeKindOf: (id: string) => (nodes.find((entry) => entry.id === id)?.type as NodeKind | undefined) ?? null }
    if (!isValidWorkflowConnection(before, { ...view, edges: remaining })
      || !isValidWorkflowConnection(after, { ...view, edges: [...remaining, before] })) {
      setBanner('该节点无法插入这条连线')
      return
    }
    execute({ type: 'splice-node-on-edge', nodeId, edgeId, before, after })
    setBanner(`已把「${definition.title}」接入连线`)
  }, [edges, execute, nodes])

  // Where a dropped node would splice into a wire. The snapping itself happens
  // in onCanvasNodesChange, so this reads the committed position rather than the
  // raw pointer one and the highlight agrees with where the node will land.
  const onCanvasNodeDrag = useCallback((_event: MouseEvent | TouchEvent, node: CanvasNode, draggedNodes: CanvasNode[]) => {
    if (draggedNodes.length > 1 || altDragSessionRef.current) {
      if (edgeDropTargetId) setEdgeDropTargetId(null)
      return
    }
    const live = reactFlow.getNodes().find((entry) => entry.id === node.id) ?? node
    const target = findEdgeDropTarget(snapBoxOfCanvasNode(live), edgeEndpoints())
    setEdgeDropTargetId(target?.id ?? null)
  }, [edgeDropTargetId, edgeEndpoints, reactFlow])

  const onCanvasNodeDragStop = useCallback((_event: MouseEvent | TouchEvent, node: CanvasNode, draggedNodes: CanvasNode[]) => {
    setSnapGuides([])
    const dropTargetId = edgeDropTargetId
    setEdgeDropTargetId(null)
    if (dropTargetId && draggedNodes.length <= 1 && !altDragSessionRef.current) {
      spliceNodeOntoEdge(node.id, dropTargetId)
    }
    const session = altDragSessionRef.current
    if (!session) return
    altDragSessionRef.current = null

    // useReactFlow returns an empty array before the flow mounts, so an
    // emptiness check replaces the old null-instance fallback.
    const storeNodes = reactFlow.getNodes()
    const liveNodes = storeNodes.length > 0 ? storeNodes : (draggedNodes.length > 0 ? draggedNodes : [node])
    const liveById = new Map(liveNodes.map((entry) => [entry.id, entry]))
    const sourceRecords = nodes.map((entry) => {
      const live = liveById.get(entry.id)
      return canvasNodeDocumentRecord(live ?? entry)
    })
    const duplicated = duplicateCanvasNodesForAltDrag(sourceRecords, edges.map(toWorkflowEdge), {
      nodeIds: session.nodeIds,
      preserveInputConnections: session.preserveInputConnections,
      createNodeId: () => nextNodeId(),
      createEdgeId: () => nextNodeId(),
    })
    if (duplicated.nodes.length === 0) return

    // React Flow has already previewed movement on the original ids. Restore
    // them synchronously before the document command seeds its undo snapshot.
    flushSync(() => {
      setNodes((current) => current.map((entry) => {
        const original = session.originalPositions.get(entry.id)
        return original ? { ...entry, position: { ...original } } : entry
      }))
    })
    execute({ type: 'add-nodes', nodes: duplicated.nodes, edges: duplicated.edges })
    const duplicateIds = new Set(duplicated.nodes.map((entry) => entry.id))
    window.requestAnimationFrame(() => {
      setNodes((current) => current.map((entry) => ({ ...entry, selected: duplicateIds.has(entry.id) })))
    })
    setBanner(session.preserveInputConnections
      ? `已复制 ${duplicated.nodes.length} 个节点并保留输入连接`
      : `已复制 ${duplicated.nodes.length} 个节点`)
  }, [edges, execute, nodes, reactFlow, setNodes])

  const arrangeNodes = useCallback((mode: CanvasArrangeMode) => {
    if (!nodes.length || projectTransitionRef.current) return
    const selectedIds = nodes.filter((node) => node.selected).map((node) => node.id)
    try {
      const arranged = arrangeCanvasNodes(nodes.map((node) => {
        const live = reactFlow.getNode(node.id)
        const dimensions = builtinNodeRegistry.resolve(node.type ?? 'unknown')?.dimensions
        return { ...canvasNodeDocumentRecord(node), width: live?.measured?.width ?? node.measured?.width ?? node.width ?? dimensions?.width, height: live?.measured?.height ?? node.measured?.height ?? node.height ?? dimensions?.height }
      }), edges.map(toWorkflowEdge), mode, selectedIds)
      // Resizing the parent and moving its children is one transaction, so
      // React Flow never clamps arranged children to the previous extent.
      execute({ type: 'replace-nodes', nodes: arranged })
      setArrangeMenuOpen(false)
      if (!selectedIds.length) fitCanvas()
      setBanner(`已${mode === 'horizontal' ? '水平' : mode === 'vertical' ? '垂直' : '智能'}排列${selectedIds.length ? '选中节点，分组整体移动' : '顶层节点，保持组内布局'}，锁定位置保持不变，可撤销恢复`)
    } catch (error) { setBanner(error instanceof Error ? error.message : '节点排列失败，请重新选择') }
  }, [nodes, edges, execute, fitCanvas, reactFlow])

  const autoLayout = useCallback(() => arrangeNodes('smart'), [arrangeNodes])

  const organizeGroupContents = useCallback(() => {
    if (!nodes.length || projectTransitionRef.current || !draftActionsEnabledRef.current) return
    const selected = nodes.filter((node) => node.selected)
    const groupIds = selected.filter((node) => node.type === 'group').map((node) => node.id)
    if (selected.length && !groupIds.length) { setBanner('请先选择分组，或取消选择后整理所有分组内部'); return }
    try {
      const arranged = organizeCanvasGroupContents(nodes.map((node) => {
        const live = reactFlow.getNode(node.id)
        const dimensions = builtinNodeRegistry.resolve(node.type ?? 'unknown')?.dimensions
        return { ...canvasNodeDocumentRecord(node), width: live?.measured?.width ?? node.measured?.width ?? node.width ?? dimensions?.width, height: live?.measured?.height ?? node.measured?.height ?? node.height ?? dimensions?.height }
      }), edges.map(toWorkflowEdge), groupIds)
      execute({ type: 'replace-nodes', nodes: arranged })
      setArrangeMenuOpen(false)
      fitCanvas()
      setBanner(`已整理${groupIds.length ? '选中分组' : '所有分组'}内部及嵌套分组，扩展边界并避让同级节点，可一次撤销恢复`)
    } catch (error) { setBanner(error instanceof Error ? error.message : '分组内部整理失败，画布保持原样') }
  }, [nodes, edges, execute, fitCanvas, reactFlow])

  const workshopSelectionRequestRef = useRef(0)
  const saveWorkshopSelection = useCallback(async (nodeIds: readonly string[]) => {
    if (projectTransitionRef.current || !draftActionsEnabledRef.current || !projectCanEditRef.current) return
    const requestId = ++workshopSelectionRequestRef.current, scopeKey = currentWorkshopSetupScope()
    try {
      const graph = getGraphSnapshot(), targetId = readWorkshopEditTarget(new URLSearchParams(window.location.search), activeProjectIdRef.current)
      let workflow = buildWorkshopSelectionForSourceReview({ ...createEmptyWorkflow(activeProject?.name ?? '个人工坊'), nodes: graph.nodes.map(toWorkflowNode), edges: graph.edges.map(toWorkflowEdge) }, nodeIds)
      if (collectWorkflowColorLutSources(workflow).length) {
        const prepare = hostBridge().prepareWorkshopWorkflow
        if (!prepare) throw new Error('当前页面尚未接入完整调色配置保存，请刷新后重试')
        setBanner('正在准备属于本人账号的完整工坊调色配置…')
        workflow = await prepare(workflow)
      }
      if (requestId !== workshopSelectionRequestRef.current || scopeKey !== currentWorkshopSetupScope() || projectTransitionRef.current || !draftActionsEnabledRef.current || !projectCanEditRef.current) return
      setWorkshopSelection({ workflow, scopeKey, ...(targetId ? { targetId } : {}) })
    }
    catch (error) { if (requestId === workshopSelectionRequestRef.current && scopeKey === currentWorkshopSetupScope()) setBanner(error instanceof Error ? error.message : '无法保存当前选区') }
  }, [activeProject?.name, getGraphSnapshot, currentWorkshopSetupScope])

  const workshopProjectEpoch = projectEpochRef.current
  const insertWorkshopItem = useCallback(async (item: CanvasWorkshopItem, sourceType: 'workshop' | 'prompt' | 'builtin-prompt' = 'workshop') => {
    if (!draftActionsEnabledRef.current) throw new Error('账户连接已变化，请重新进入工作区后使用工坊')
    if (!projectCanEditRef.current) throw new Error('当前工程只读，无法插入工坊内容')
    if (projectEpochRef.current !== workshopProjectEpoch || activeProjectIdRef.current !== (activeProject?.id ?? null)) throw new Error('工程已变化，已获取的内容仍保存在账号中，请在当前工程重新选择插入')
    if (projectTransitionRef.current) throw new Error('工程正在切换，请稍后重试')
    const bridge = hostBridge()
    const route = new URL(window.location.href)
    const templateId = `${sourceType === 'prompt' ? 'prompt-preset' : sourceType}-${item.id}`
    const confirmed = templateCreatedProjectRef.current
    if (confirmed && !activeProject && confirmed.templateId === templateId && route.searchParams.get('project') === confirmed.projectId) {
      const setupRequest = { ...layerEditorOwnerRef.current, projectEpoch: projectEpochRef.current }
      if (!await openStoredProject(confirmed.projectId)) throw new Error('工坊工程已创建，请重试读取原工程；不会再次创建')
      if (draftOwnerId) {
        try {
          const saved = readSavedTemplateProjectSubmission(window.localStorage, draftOwnerId, confirmed.projectId)
          if (saved) clearSavedTemplateProjectSubmission(window.localStorage, saved)
        } catch (error) { setDraftStorageError(error instanceof Error ? error.message : '工坊工程已确认，但本地恢复记录暂未清除') }
      }
      templateCreatedProjectRef.current = null
      setWorkshopCatalog(null)
      openCreatedWorkshopSetup(confirmed.projectId, setupRequest)
      return
    }
    const operationId = !activeProject && bridge.createTemplateProject ? templateProjectOperationId(route.searchParams, () => crypto.randomUUID()) : null
    let issued = 0
    const build = () => {
      const roots = nodes.filter((node) => !node.parentId)
      const origin = roots.length ? { x: Math.min(...roots.map((node) => node.position.x)), y: Math.max(...roots.map((node) => node.position.y + (node.measured?.height ?? node.height ?? 240))) + 100 } : { x: 80, y: 80 }
      const instance = instantiateWorkshopGraph(item.workflow, operationId ? () => `${operationId}-${++issued}` : nextNodeId, origin)
      // Global defaults remain project-scoped. Owner-private node pins survive
      // instantiation and must pass current provider preflight before running.
      instance.mediaGroups = { ...mediaGroups }
      instance.name = `${item.name} · 画布`
      return instance
    }
    try {
      if (operationId && bridge.createTemplateProject) {
        if (!draftOwnerId) throw new Error('当前账户恢复空间尚未确认，请重新进入工作区')
        const submission = templateProjectSubmissionRef.current.prepare(operationId, JSON.stringify({ templateId, version: item.version }), () => serializeWorkflow(build()))
        const saved: SavedTemplateProjectSubmission = { ...submission, version: 1, ownerId: draftOwnerId, templateId }
        writeSavedTemplateProjectSubmission(window.localStorage, saved)
        for (const key of ['workshop', 'promptPreset', 'builtinPrompt']) route.searchParams.delete(key)
        route.searchParams.set(sourceType === 'prompt' ? 'promptPreset' : sourceType === 'builtin-prompt' ? 'builtinPrompt' : 'workshop', item.id)
        route.searchParams.set('templateOperation', operationId)
        route.searchParams.delete('template')
        route.searchParams.delete('project')
        window.history.replaceState(window.history.state, '', `${route.pathname}${route.search}${route.hash}`)
        await finishTemplateProjectCreation(saved)
        return
      }
      const instance = build()
      const navigation = execute({ type: 'add-nodes', nodes: instance.nodes.map((node) => canvasNodeDocumentRecord(toCanvasNode(node))), edges: instance.edges }, { insertionViewport: reactFlow.getViewport() })
      const insertedIds = new Set(instance.nodes.map((node) => node.id))
      setNodes((current) => current.map((node) => ({ ...node, selected: insertedIds.has(node.id) })))
      openWorkshopSetup({ kind: 'inserted', nodeIds: [...insertedIds] })
      setWorkshopCatalog(null)
      setBanner(`已插入「${item.name}」，可独立编辑，一次撤销可整体移除`)
      focusInsertedNodes(navigation, [...insertedIds])
    } finally { templateProjectSubmissionRef.current.settled() }
  }, [activeProject, workshopProjectEpoch, draftOwnerId, execute, finishTemplateProjectCreation, mediaGroups, nodes, reactFlow, setNodes, openStoredProject, openWorkshopSetup, openCreatedWorkshopSetup, focusInsertedNodes])

  const insertTemplate = useCallback(async (templateId: string, values?: Readonly<Record<string, unknown>>, draft = true) => {
    if (!draftActionsEnabledRef.current || projectTransitionRef.current) throw new Error('账户或工程正在切换，请稍后重新选择模板')
    if (!projectCanEditRef.current) throw new Error('当前工程只读，无法插入模板')
    if (projectEpochRef.current !== workshopProjectEpoch || activeProjectIdRef.current !== (activeProject?.id ?? null)) throw new Error('工程已变化，请在当前工程重新选择模板')
    const template = builtinCanvasTemplates.find((entry) => entry.id === templateId)
    if (!template) throw new Error('模板不存在，请重新选择')
    const bridge = hostBridge()
    const route = new URL(window.location.href)
    const newTemplateProject = !activeProject && Boolean(bridge.createTemplateProject)
    try {
      const recovery = templateCreatedProjectRef.current
      if (recovery && !activeProject && route.searchParams.get('project') === recovery.projectId && templateId === recovery.templateId) {
        const setupRequest = { ...layerEditorOwnerRef.current, projectEpoch: projectEpochRef.current }
        if (!await openStoredProject(recovery.projectId)) throw new Error('模板工程已创建，但读取尚未完成；请重试读取或在项目中心打开原工程')
        if (draftOwnerId) {
          try {
            const saved = readSavedTemplateProjectSubmission(window.localStorage, draftOwnerId, recovery.projectId)
            if (saved) clearSavedTemplateProjectSubmission(window.localStorage, saved)
          } catch (error) { setDraftStorageError(error instanceof Error ? error.message : '模板恢复记录清理失败；云端工程已确认') }
        }
        templateCreatedProjectRef.current = null
        setTemplateCatalog(null)
        openCreatedWorkshopSetup(recovery.projectId, setupRequest)
        return
      }
      templateCreatedProjectRef.current = null
      const operationId = newTemplateProject ? templateProjectOperationId(route.searchParams, () => crypto.randomUUID()) : null
      let issued = 0
      const buildInserted = () => {
        const instance = placeTemplateInstance(instantiateTemplate(template, {
          ...(values ? { values } : {}),
          availableNodeTypes: new Set(builtinNodeRegistry.list().filter((definition) => canvasNodeKindAvailable(definition.type, canvasCapabilities())).map((definition) => definition.type)),
          createId: operationId ? () => `${operationId}-${++issued}` : nextNodeId,
          draft,
        }), nodes.map((node) => ({ position: node.position, height: node.measured?.height ?? node.height })))
        const insertedNodes = instance.nodes.map((node) => {
          const definition = builtinNodeRegistry.require(node.type)
          const config = operationDefaultsForTemplateNode(node.type, imageModels, videoModels, node.config).config
          if ((['image', 'image-generate', 'image-edit'].includes(node.type) && imageModels.length === 0)
            || (['video', 'video-generate'].includes(node.type) && videoModels.length === 0)) config.model = ''
          return toCanvasNode({
            id: node.id,
            kind: node.type as NodeKind,
            definitionVersion: node.definitionVersion,
            position: node.position,
            width: definition.dimensions.width,
            height: definition.dimensions.height,
            data: workflowNodeData(node.type, config),
          })
        })
        return { instance, insertedNodes }
      }
      if (operationId && bridge.createTemplateProject) {
        const submission = templateProjectSubmissionRef.current.prepare(operationId, JSON.stringify({ templateId, values, draft }), () => {
          const { instance, insertedNodes } = buildInserted()
          return serializeWorkflow({ ...createEmptyWorkflow(`${template.name} · 画布`), mediaGroups: { ...mediaGroups }, nodes: insertedNodes.map(toWorkflowNode), edges: instance.edges.map((edge) => ({ ...edge })), viewport: { x: 0, y: 0, zoom: 1 } })
        })
        if (!draftOwnerId) throw new Error('当前账户的本地恢复空间尚未确认，模板未提交，请重新进入工作区')
        const saved: SavedTemplateProjectSubmission = { ...submission, version: 1, ownerId: draftOwnerId, templateId }
        route.searchParams.set('template', templateId)
        route.searchParams.set('templateOperation', operationId)
        route.searchParams.delete('project')
        window.history.replaceState(window.history.state, '', `${route.pathname}${route.search}${route.hash}`)
        writeSavedTemplateProjectSubmission(window.localStorage, saved)
        await finishTemplateProjectCreation(saved)
        return
      }
      const { instance, insertedNodes } = buildInserted()
      const navigation = execute({
        type: 'add-nodes',
        nodes: insertedNodes.map(canvasNodeDocumentRecord),
        edges: instance.edges.map((edge) => ({ ...edge })),
      }, { insertionViewport: reactFlow.getViewport() })
      setBanner(`已插入模板「${template.name}」`)
      openWorkshopSetup({ kind: 'inserted', nodeIds: insertedNodes.map((node) => node.id) })
      setTemplateCatalog(null)
      focusInsertedNodes(navigation, insertedNodes.map((node) => node.id))
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
      throw error
    } finally { templateProjectSubmissionRef.current.settled(); if (newTemplateProject) setProjectLoading(false) }
  }, [nodes, execute, imageModels, videoModels, activeProject, mediaGroups, openStoredProject, draftOwnerId, finishTemplateProjectCreation, workshopProjectEpoch, openWorkshopSetup, openCreatedWorkshopSetup, reactFlow, focusInsertedNodes])

  const readCanvasAssetDetail = useCallback((assetId: string, signal?: AbortSignal) => {
    const bridge = hostBridge()
    if (!bridge.getAssetDetail) throw new Error('当前宿主暂不支持完整素材资料，请更新后重新读取')
    return bridge.getAssetDetail(assetId, signal)
  }, [])

  const readCanvasAssetOrigin = useCallback(async (assetId: string, signal: AbortSignal): Promise<CanvasAssetOriginResult> => {
    const bridge = hostBridge(), read = bridge.readAssetOrigin
    if (!read) throw new Error('当前宿主暂不支持核对素材来源，请更新后重试；不会仅按节点编号定位。')
    const owner = { ...layerEditorOwnerRef.current }, epoch = projectEpochRef.current, projectId = activeProjectIdRef.current
    function current() {
      const active = layerEditorOwnerRef.current
      return agentMountedRef.current && draftActionsEnabledRef.current && !signal.aborted && !projectTransitionRef.current && owner.ownerId === active.ownerId && owner.accountId === active.accountId && epoch === projectEpochRef.current && projectId === activeProjectIdRef.current && !bridge.getProjectAccess?.()?.denied
    }
    if (!current()) throw new Error('账号、工程或访问状态已变化，请重新核对来源。')
    const result = await read(assetId, signal)
    if (!current()) throw new Error('账号、工程或访问状态已变化，旧来源核对已停止。')
    return result
  }, [])

  const commerceDimensionSourceIds = useMemo(() => {
    const byId = new Map(nodes.map((node) => [node.id, node])), byEdge = new Map(edges.map((edge) => [edge.id, edge])), ids = new Set<string>()
    for (const node of nodes) {
      const value = node.data.settings?.commerceTask
      if (!value || typeof value !== 'object' || Reflect.get(value, 'kind') !== 'material-b') continue
      try {
        parseNodeCommerceTask(node.type ?? '', value)
        const slot = parseNodeImageReferenceOrder(node.type ?? '', node.data.settings?.imageReferenceOrder).slots[0]
        const edge = 'edgeId' in slot ? byEdge.get(slot.edgeId) : undefined
        const source = edge?.target === node.id && edge.sourceHandle === 'out:image' ? byId.get(edge.source) : undefined
        const id = source?.data.result?.kind === 'image' ? source.data.result.assetId : undefined
        if (id) ids.add(id)
      } catch { /* Normal preflight explains invalid task or role settings. */ }
    }
    return [...ids].sort().join('|')
  }, [nodes, edges])
  useEffect(() => {
    if (!commerceDimensionSourceIds || !draftActionsEnabledRef.current || !hostBridge().getAssetDetail) return
    const scope = currentWorkshopSetupScope(), controller = new AbortController()
    const ids = commerceDimensionSourceIds.split('|').filter((id) => !imageAssetDimensions[id])
    let cursor = 0
    async function read() {
      while (cursor < ids.length && !controller.signal.aborted) {
        const id = ids[cursor++]
        try {
          const asset = await readCanvasAssetDetail(id, controller.signal)
          if (controller.signal.aborted || scope !== currentWorkshopSetupScope()) return
          if (asset.mediaType !== 'image' || asset.deletedAt || !Number.isSafeInteger(asset.width) || !Number.isSafeInteger(asset.height) || asset.width! <= 0 || asset.height! <= 0) throw new Error('原图尺寸暂不可读取')
          const dimensions = { width: asset.width!, height: asset.height! }
          setCommerceDimensions((previous) => ({ scope, values: { ...(previous.scope === scope ? previous.values : {}), [id]: dimensions } }))
          setAssetCatalog((previous) => [...previous.filter((entry) => entry.assetId !== id), asset])
        } catch {
          if (!controller.signal.aborted && scope === currentWorkshopSetupScope()) setBanner('材质任务原图尺寸尚未读完，请打开任务配置重新选择图片或重试；尚未发起生成')
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(4, ids.length) }, read))
    return () => controller.abort()
    // Metadata updates must not abort the other reads in this same batch.
  }, [commerceDimensionSourceIds, layerEditorScope, readCanvasAssetDetail, currentWorkshopSetupScope])

  const applyCommerceDraft = useCallback(async (draft: CommerceTaskDialogDraft) => {
    const session = commerceSessionRef.current
    if (!session || Boolean(session.nodeId) !== (draft.mode === 'edit')) throw new Error('创作配置会话已变化，请重新打开')
    function assertCurrent() { assertCommerceCurrent(session!.scope); if (commerceSessionRef.current !== session) throw new Error('创作配置已关闭，本次没有修改画布') }
    assertCurrent()
    const pendingOperation = !activeProject && draft.mode === 'create' ? new URLSearchParams(window.location.search).get('templateOperation') : null
    if (pendingOperation && draftOwnerId) {
      const saved = readSavedTemplateProjectSubmission(window.localStorage, draftOwnerId, pendingOperation)
      if (!saved || !saved.templateId.startsWith('commerce-') || saved.signature !== JSON.stringify(draft)) throw new Error('原创建结果尚未确认，请按原配置重试核对，或在项目中心查找原工程；不会换图重复创建')
      try {
        await finishTemplateProjectCreation(saved)
        if (commerceSessionRef.current === session) { commerceSessionRef.current = null; setCommerceSession(null) }
      } finally { templateProjectSubmissionRef.current.settled() }
      return
    }
    const host = hostBridge(), assets: CanvasImageAssetSummary[] = []
    if (!host.getAssetDetail) throw new Error('当前宿主无法核对原图与参考图')
    for (const reference of draft.references) {
      if (reference.binding.kind !== 'asset') continue
      const asset = await host.getAssetDetail(reference.binding.assetId)
      assertCurrent()
      if (!asset || asset.mediaType !== 'image' || !isTemplateImageAsset(asset)) throw new Error('图片已失效，请从素材库重新选择')
      assets.push(asset)
    }
    await host.refreshProjectAccess?.(); assertCurrent()
    const access = host.getProjectAccess?.()
    if (access?.denied || access?.access && !access.access.canEdit) throw new Error('当前工程不可编辑，本次没有修改画布')
    const current = getGraphSnapshot()
    setAssetCatalog((previous) => [...previous.filter((asset) => !assets.some((verified) => verified.assetId === asset.assetId)), ...assets])
    if (draft.mode === 'edit') {
      const node = current.nodes.find((entry) => entry.id === session.nodeId)
      const upstream = buildCanvasUpstreamReferences(current.nodes, current.edges, assetCatalog).get(session.nodeId!) ?? []
      if (!node || session.signature !== JSON.stringify([toWorkflowNode(node), current.edges.filter((edge) => edge.target === node.id).map(toWorkflowEdge), upstream])) throw new Error('节点、图片或连接已变化，请重新打开创作配置')
      const workflow = buildCommerceNodeEdit({ workflow: { ...createEmptyWorkflow(activeProject?.name ?? '商品创作'), nodes: current.nodes.map(toWorkflowNode), edges: current.edges.map(toWorkflowEdge) }, nodeId: node.id, task: draft.task, references: draft.references, currentReferences: upstream, assets, createId: nextNodeId })
      const updated = markNodeAndDescendantsDirty(workflow.nodes.map(toCanvasNode), workflow.edges, node.id)
      execute({ type: 'replace-graph', nodes: updated.map(canvasNodeDocumentRecord), edges: workflow.edges })
      graphRef.current = getGraphSnapshot(); setDirtyNodeIds(dirtyCanvasNodeIds(graphRef.current.nodes))
      commerceSessionRef.current = null; setCommerceSession(null)
      const privateAnalysis = workflow.nodes.some((entry) => entry.kind === 'text-generate' && !current.nodes.some((previous) => previous.id === entry.id))
      setBanner(privateAnalysis ? '已换图并为当前任务创建独立图片分析，其他任务保持原样，可一次撤销' : '已更新创作配置与图片角色，可一次撤销；运行前可继续编辑补充要求')
      return
    }
    const source = draft.references.find((entry) => entry.role === 'source'), reference = draft.references.find((entry) => entry.role === 'reference')
    if (source?.binding.kind !== 'asset' || reference && reference.binding.kind !== 'asset') throw new Error('新建任务请从素材库选择原图和参考图')
    const sourceAsset = assets.find((entry) => source.binding.kind === 'asset' && entry.assetId === source.binding.assetId)!
    const referenceAsset = reference?.binding.kind === 'asset' ? assets.find((entry) => reference.binding.kind === 'asset' && entry.assetId === reference.binding.assetId) : undefined
    const analysisModel = mediaGroupsRef.current.textModel || textModels[0]
    if (draft.autoAnalyze && !analysisModel) throw new Error('自动分析需要先在模型来源中配置可用的视觉文字模型')
    const route = new URL(window.location.href), operationId = !activeProject && host.createTemplateProject ? templateProjectOperationId(route.searchParams, () => crypto.randomUUID()) : null
    let issued = 0
    const build = () => {
      const workflow = buildCommerceWorkflow({ tasks: draft.tasks, source: { ...sourceAsset, label: sourceAsset.displayName || sourceAsset.fileName }, ...(referenceAsset ? { reference: { ...referenceAsset, label: referenceAsset.displayName || referenceAsset.fileName } } : {}), prompt: draft.prompt, model: draft.model,
        group: mediaGroupsRef.current.image, size: draft.size, quality: draft.quality, imageResolution: draft.imageResolution, candidateCount: draft.imageCandidateCount,
        ...(draft.autoAnalyze ? { analysis: { model: analysisModel!, group: mediaGroupsRef.current.text, prompt: '分析原图中的主体形状、颜色、标识和材质；若有第二张图片，另行描述其视觉风格。输出简洁的中文创作建议，明确保留主体身份，不虚构不可见细节。' } } : {}),
        createId: operationId ? () => `${operationId}-${++issued}` : nextNodeId })
      workflow.mediaGroups = { ...mediaGroupsRef.current }
      if (current.nodes.length && !operationId) {
        const offset = Math.max(...current.nodes.map((node) => node.position.x + (node.width ?? 320))) + 100
        workflow.nodes = workflow.nodes.map((node) => ({ ...node, position: { x: node.position.x + offset, y: node.position.y } }))
      }
      return workflow
    }
    try {
      if (operationId && host.createTemplateProject) {
        if (!draftOwnerId) throw new Error('当前账户的恢复空间尚未确认，请重新进入工作区')
        const templateId = `commerce-${draft.tasks[0].kind}`
        const submission = templateProjectSubmissionRef.current.prepare(operationId, JSON.stringify(draft), () => serializeWorkflow(build()))
        const saved: SavedTemplateProjectSubmission = { ...submission, version: 1, ownerId: draftOwnerId, templateId }
        writeSavedTemplateProjectSubmission(window.localStorage, saved)
        route.searchParams.set('commerceTask', draft.tasks[0].kind); route.searchParams.set('templateOperation', operationId); route.searchParams.delete('project')
        window.history.replaceState(window.history.state, '', `${route.pathname}${route.search}${route.hash}`)
        await finishTemplateProjectCreation(saved)
      } else {
        const workflow = build(); assertCurrent()
        execute({ type: 'add-nodes', nodes: workflow.nodes.map((node) => canvasNodeDocumentRecord(toCanvasNode(node))), edges: workflow.edges })
        setNodes((latest) => latest.map((node) => ({ ...node, selected: workflow.nodes.some((entry) => entry.id === node.id) })))
        setBanner('已创建商品创作流程，可一次撤销；核对参数后运行')
        void reactFlow.fitView({ nodes: workflow.nodes.map((node) => ({ id: node.id })), padding: .2, duration: 180, maxZoom: 1 })
      }
      if (commerceSessionRef.current === session) { commerceSessionRef.current = null; setCommerceSession(null) }
    } finally { templateProjectSubmissionRef.current.settled() }
  }, [assertCommerceCurrent, getGraphSnapshot, assetCatalog, activeProject, execute, textModels, draftOwnerId, finishTemplateProjectCreation, setNodes, reactFlow])

  const applyInteriorDraft = useCallback(async (draft: InteriorTaskDialogDraft) => {
    const session = interiorSessionRef.current
    if (!session || Boolean(session.nodeId) !== (draft.mode === 'edit')) throw new Error('室内配置会话已变化，请重新打开')
    function assertCurrent() {
      assertCommerceCurrent(session!.scope)
      if (interiorSessionRef.current !== session) throw new Error('室内配置已关闭，本次没有修改画布')
      if ((session!.group ?? '') !== (mediaGroupsRef.current.image ?? '')) throw new Error('生成来源已切换，当前配置已保留，请重新核对模型来源')
    }
    assertCurrent()
    const pendingOperation = !activeProject && draft.mode === 'create' ? new URLSearchParams(window.location.search).get('templateOperation') : null
    if (pendingOperation && draftOwnerId) {
      const saved = readSavedTemplateProjectSubmission(window.localStorage, draftOwnerId, pendingOperation)
      if (!saved || saved.templateId !== 'interior-render' || saved.signature !== JSON.stringify(draft)) throw new Error('原室内工程的创建结果尚未确认，请按原配置核对，或在项目中心查找；不会换图重复创建')
      try {
        await finishTemplateProjectCreation(saved)
        if (interiorSessionRef.current === session) { interiorSessionRef.current = null; setInteriorSession(null) }
      } finally { templateProjectSubmissionRef.current.settled() }
      return
    }
    const host = hostBridge(), assets: CanvasImageAssetSummary[] = []
    if (!host.getAssetDetail) throw new Error('当前宿主无法核对室内原图')
    const sourceAssetId = draft.source.binding.kind === 'asset' ? draft.source.binding.assetId : draft.source.binding.kind === 'existing' ? session.source.asset?.assetId : undefined
    if (sourceAssetId) {
      const asset = await host.getAssetDetail(sourceAssetId)
      assertCurrent()
      if (!asset || asset.assetId !== sourceAssetId || asset.mediaType !== 'image' || !isTemplateImageAsset(asset)) throw new Error('室内图片已失效，请从素材库重新选择')
      assets.push(asset)
    } else throw new Error('室内原图尚未核对，请重新选择')
    await host.refreshProjectAccess?.(); assertCurrent()
    const access = host.getProjectAccess?.()
    if (access?.denied || access?.access && !access.access.canEdit) throw new Error('当前工程不可编辑，本次没有修改画布')
    const current = getGraphSnapshot()
    setAssetCatalog((previous) => [...previous.filter((asset) => !assets.some((verified) => verified.assetId === asset.assetId)), ...assets])
    if (draft.mode === 'edit') {
      const node = current.nodes.find((entry) => entry.id === session.nodeId)
      const upstream = buildCanvasUpstreamReferences(current.nodes, current.edges, assetCatalog).get(session.nodeId!) ?? []
      if (!node || session.signature !== JSON.stringify([toWorkflowNode(node), current.edges.filter((edge) => edge.target === node.id).map(toWorkflowEdge), upstream])) throw new Error('室内节点、图片或连接已变化，请重新打开配置；尚未修改画布')
      const workflow = buildInteriorNodeEdit({ workflow: { ...createEmptyWorkflow(activeProject?.name ?? '室内创作'), nodes: current.nodes.map(toWorkflowNode), edges: current.edges.map(toWorkflowEdge) }, nodeId: node.id, draft, currentReferences: upstream, assets, createId: nextNodeId })
      const updated = markNodeAndDescendantsDirty(workflow.nodes.map(toCanvasNode), workflow.edges, node.id)
      execute({ type: 'replace-graph', nodes: updated.map(canvasNodeDocumentRecord), edges: workflow.edges })
      graphRef.current = getGraphSnapshot(); setDirtyNodeIds(dirtyCanvasNodeIds(graphRef.current.nodes))
      interiorSessionRef.current = null; setInteriorSession(null)
      setBanner('已更新室内配置与原图，可一次撤销；旧结果保留，核对后再运行')
      return
    }
    if (draft.source.binding.kind !== 'asset') throw new Error('新建室内任务请从素材库选择或上传原图')
    const sourceId = draft.source.binding.assetId
    const source = assets.find((entry) => entry.assetId === sourceId)
    if (!source) throw new Error('室内原图尚未核对，请重新选择')
    const route = new URL(window.location.href), operationId = !activeProject && host.createTemplateProject ? templateProjectOperationId(route.searchParams, () => crypto.randomUUID()) : null
    let issued = 0
    const build = () => {
      const workflow = buildInteriorWorkflow({ task: draft.task, source: { ...source, label: source.displayName || source.fileName }, prompt: draft.prompt, model: draft.model,
        size: draft.size, quality: draft.quality, imageResolution: draft.imageResolution, candidateCount: draft.imageCandidateCount,
        createId: operationId ? () => `${operationId}-${++issued}` : nextNodeId })
      workflow.mediaGroups = { ...mediaGroupsRef.current }
      if (current.nodes.length && !operationId) {
        const offset = Math.max(...current.nodes.map((node) => node.position.x + (node.width ?? 320))) + 100
        workflow.nodes = workflow.nodes.map((node) => ({ ...node, position: { x: node.position.x + offset, y: node.position.y } }))
      }
      return workflow
    }
    try {
      if (operationId && host.createTemplateProject) {
        if (!draftOwnerId) throw new Error('当前账户的恢复空间尚未确认，请重新进入工作区')
        const submission = templateProjectSubmissionRef.current.prepare(operationId, JSON.stringify(draft), () => serializeWorkflow(build()))
        const saved: SavedTemplateProjectSubmission = { ...submission, version: 1, ownerId: draftOwnerId, templateId: 'interior-render' }
        writeSavedTemplateProjectSubmission(window.localStorage, saved)
        route.searchParams.set('interiorTask', 'render'); route.searchParams.set('templateOperation', operationId); route.searchParams.delete('project')
        window.history.replaceState(window.history.state, '', `${route.pathname}${route.search}${route.hash}`)
        await finishTemplateProjectCreation(saved)
      } else {
        const workflow = build(); assertCurrent()
        execute({ type: 'add-nodes', nodes: workflow.nodes.map((node) => canvasNodeDocumentRecord(toCanvasNode(node))), edges: workflow.edges })
        setNodes((latest) => latest.map((node) => ({ ...node, selected: workflow.nodes.some((entry) => entry.id === node.id) })))
        setBanner('已创建室内渲染流程，可一次撤销；核对原图与参数后运行')
        void reactFlow.fitView({ nodes: workflow.nodes.map((node) => ({ id: node.id })), padding: .2, duration: 180, maxZoom: 1 })
      }
      if (interiorSessionRef.current === session) { interiorSessionRef.current = null; setInteriorSession(null) }
    } finally { templateProjectSubmissionRef.current.settled() }
  }, [assertCommerceCurrent, getGraphSnapshot, assetCatalog, activeProject, execute, draftOwnerId, finishTemplateProjectCreation, setNodes, reactFlow])

  const applyExteriorDraft = useCallback(async (draft: ExteriorTaskDialogDraft) => {
    const session = exteriorSessionRef.current
    if (!session || Boolean(session.nodeId) !== (draft.mode === 'edit')) throw new Error('室外配置会话已变化，请重新打开')
    const imageSource = exteriorTaskSourceSignature(groupsRef.current, mediaGroupsRef.current.image), textSource = exteriorTaskSourceSignature(groupsRef.current, mediaGroupsRef.current.text)
    function assertCurrent() {
      assertCommerceCurrent(session!.scope)
      if (exteriorSessionRef.current !== session) throw new Error('室外配置已关闭，本次没有修改画布')
      if (imageSource !== exteriorTaskSourceSignature(groupsRef.current, mediaGroupsRef.current.image)
        || exteriorTaskUsesAnalysis(draft.task) && textSource !== exteriorTaskSourceSignature(groupsRef.current, mediaGroupsRef.current.text)) throw new Error('生成来源已变化，当前配置已保留，请重新核对来源')
    }
    assertCurrent()
    const pendingOperation = !activeProject && draft.mode === 'create' ? new URLSearchParams(window.location.search).get('templateOperation') : null
    if (pendingOperation && draftOwnerId) {
      const saved = readSavedTemplateProjectSubmission(window.localStorage, draftOwnerId, pendingOperation)
      if (!saved || saved.templateId !== `exterior-${draft.task.kind}` || saved.signature !== JSON.stringify(draft)) throw new Error('原室外工程的创建结果尚未确认，请按原配置核对，或在项目中心查找；不会换图重复创建')
      try {
        await finishTemplateProjectCreation(saved)
        if (exteriorSessionRef.current === session) { exteriorSessionRef.current = null; setExteriorSession(null) }
      } finally { templateProjectSubmissionRef.current.settled() }
      return
    }
    // An initially unloaded catalog can settle before submission. Once work
    // starts, every asynchronous result is tied to the exact current source.
    if (!exteriorTaskInitialSourceCurrent(session.imageSource, imageSource, mediaGroupsRef.current.image)
      || exteriorTaskUsesAnalysis(draft.task) && !exteriorTaskInitialSourceCurrent(session.textSource, textSource, mediaGroupsRef.current.text)) throw new Error('生成来源已切换，请保留当前配置并重新核对来源')
    function assertModelsCurrent() {
      if (draft.model && !mediaModelsRef.current.image.includes(draft.model)) throw new Error('图像模型在当前来源不可用，请重新选择；当前配置已保留')
      if (exteriorTaskUsesAnalysis(draft.task)) {
        if (!draft.analysis || !mediaGroupsRef.current.text || !mediaModelsRef.current.text.includes(draft.analysis.model) || mediaPreparationErrorsRef.current.text) throw new Error('自动提示的文字来源或模型不可用，请重新选择，或关闭自动提示并填写要求')
        validateTextImageInputConfiguration(draft.analysis.model, 2)
      }
    }
    assertModelsCurrent()
    const host = hostBridge(), assets: CanvasImageAssetSummary[] = []
    if (!host.getAssetDetail) throw new Error('当前宿主无法核对室外原图与参考图')
    for (const reference of draft.references) {
      const assetId = reference.binding.kind === 'asset' ? reference.binding.assetId : reference.binding.kind === 'existing' ? session.references.find((entry) => entry.role === reference.role)?.asset?.assetId : undefined
      if (!assetId) throw new Error('原图或参考图尚未核对，请重新选择室外图片')
      const asset = await host.getAssetDetail(assetId)
      assertCurrent(); assertModelsCurrent()
      if (!asset || asset.assetId !== assetId || asset.mediaType !== 'image' || !isTemplateImageAsset(asset)) throw new Error('室外图片已失效，请从素材库重新选择')
      if (assets.some((entry) => entry.assetId === assetId)) throw new Error('原图与参考图必须使用不同的实际图片')
      assets.push(asset)
    }
    await host.refreshProjectAccess?.(); assertCurrent(); assertModelsCurrent()
    const access = host.getProjectAccess?.()
    if (access?.denied || access?.access && !access.access.canEdit) throw new Error('当前工程不可编辑，本次没有修改画布')
    const current = getGraphSnapshot()
    setAssetCatalog((previous) => [...previous.filter((asset) => !assets.some((verified) => verified.assetId === asset.assetId)), ...assets])
    if (draft.mode === 'edit') {
      const node = current.nodes.find((entry) => entry.id === session.nodeId)
      const upstream = buildCanvasUpstreamReferences(current.nodes, current.edges, assetCatalog).get(session.nodeId!) ?? []
      if (!node || session.signature !== exteriorTaskEditSignature(current.nodes.map(toWorkflowNode), current.edges.map(toWorkflowEdge), node.id, upstream)) throw new Error('室外节点、图片、分析或连接已变化，请重新打开配置；尚未修改画布')
      const workflow = buildExteriorNodeEdit({ workflow: { ...createEmptyWorkflow(activeProject?.name ?? '室外创作'), nodes: current.nodes.map(toWorkflowNode), edges: current.edges.map(toWorkflowEdge) }, nodeId: node.id, draft, currentReferences: upstream, assets, analysisGroup: mediaGroupsRef.current.text, createId: nextNodeId })
      const updated = markNodeAndDescendantsDirty(workflow.nodes.map(toCanvasNode), workflow.edges, node.id)
      execute({ type: 'replace-graph', nodes: updated.map(canvasNodeDocumentRecord), edges: workflow.edges })
      graphRef.current = getGraphSnapshot(); setDirtyNodeIds(dirtyCanvasNodeIds(graphRef.current.nodes))
      exteriorSessionRef.current = null; setExteriorSession(null)
      setBanner(exteriorTaskUsesAnalysis(draft.task) ? '已更新室外配置并同步图片分析，可一次撤销；旧结果保留，核对后运行' : '已更新室外配置与图片角色，可一次撤销；旧结果保留，核对后运行')
      return
    }
    const source = draft.references.find((entry) => entry.role === 'source'), reference = draft.references.find((entry) => entry.role === 'reference')
    if (source?.binding.kind !== 'asset' || reference && reference.binding.kind !== 'asset') throw new Error('新建室外任务请从素材库选择原图与参考图')
    const sourceAsset = assets.find((entry) => source.binding.kind === 'asset' && entry.assetId === source.binding.assetId)
    const referenceAsset = reference?.binding.kind === 'asset' ? assets.find((entry) => reference.binding.kind === 'asset' && entry.assetId === reference.binding.assetId) : undefined
    if (!sourceAsset || reference && !referenceAsset) throw new Error('室外图片尚未核对，请重新选择')
    const route = new URL(window.location.href), operationId = !activeProject && host.createTemplateProject ? templateProjectOperationId(route.searchParams, () => crypto.randomUUID()) : null
    let issued = 0
    const build = () => {
      const workflow = buildExteriorWorkflow({ task: draft.task, source: { ...sourceAsset, label: sourceAsset.displayName || sourceAsset.fileName }, ...(referenceAsset ? { reference: { ...referenceAsset, label: referenceAsset.displayName || referenceAsset.fileName } } : {}), prompt: draft.prompt, model: draft.model,
        group: mediaGroupsRef.current.image, size: draft.size, quality: draft.quality, imageResolution: draft.imageResolution, candidateCount: draft.imageCandidateCount,
        ...(exteriorTaskUsesAnalysis(draft.task) && draft.analysis ? { analysis: { model: draft.analysis.model, group: mediaGroupsRef.current.text } } : {}),
        createId: operationId ? () => `${operationId}-${++issued}` : nextNodeId })
      workflow.mediaGroups = { ...mediaGroupsRef.current }
      if (current.nodes.length && !operationId) {
        const offset = Math.max(...current.nodes.filter((node) => !node.parentId).map((node) => node.position.x + snapBoxOfCanvasNode(node).width), 0) + 100
        workflow.nodes = workflow.nodes.map((node) => ({ ...node, position: { x: node.position.x + offset, y: node.position.y } }))
      }
      return workflow
    }
    try {
      if (operationId && host.createTemplateProject) {
        if (!draftOwnerId) throw new Error('当前账户的恢复空间尚未确认，请重新进入工作区')
        const submission = templateProjectSubmissionRef.current.prepare(operationId, JSON.stringify(draft), () => serializeWorkflow(build()))
        const saved: SavedTemplateProjectSubmission = { ...submission, version: 1, ownerId: draftOwnerId, templateId: `exterior-${draft.task.kind}` }
        writeSavedTemplateProjectSubmission(window.localStorage, saved)
        route.searchParams.set('exteriorTask', draft.task.kind); route.searchParams.set('templateOperation', operationId); route.searchParams.delete('project')
        window.history.replaceState(window.history.state, '', `${route.pathname}${route.search}${route.hash}`)
        await finishTemplateProjectCreation(saved)
      } else {
        const workflow = build(); assertCurrent(); assertModelsCurrent()
        execute({ type: 'add-nodes', nodes: workflow.nodes.map((node) => canvasNodeDocumentRecord(toCanvasNode(node))), edges: workflow.edges })
        setNodes((latest) => latest.map((node) => ({ ...node, selected: workflow.nodes.some((entry) => entry.id === node.id) })))
        setBanner('已创建室外创作流程，可一次撤销；核对图片角色、模型与参数后运行')
        void reactFlow.fitView({ nodes: workflow.nodes.map((node) => ({ id: node.id })), padding: .2, duration: 180, maxZoom: 1 })
      }
      if (exteriorSessionRef.current === session) { exteriorSessionRef.current = null; setExteriorSession(null) }
    } finally { templateProjectSubmissionRef.current.settled() }
  }, [assertCommerceCurrent, getGraphSnapshot, assetCatalog, activeProject, execute, draftOwnerId, finishTemplateProjectCreation, setNodes, reactFlow])

  const applyStoryboardDraft = useCallback(async (draft: StoryboardTaskDialogDraft) => {
    const session = storyboardSessionRef.current
    if (!session || Boolean(session.nodeId) !== (draft.mode === 'edit')) throw new Error('故事板配置会话已变化，请重新打开')
    const imageSource = storyboardTaskSourceSignature(groupsRef.current, mediaGroupsRef.current.image), textSource = storyboardTaskSourceSignature(groupsRef.current, mediaGroupsRef.current.text)
    function assertCurrent() {
      assertCommerceCurrent(session!.scope)
      if (storyboardSessionRef.current !== session) throw new Error('故事板配置已关闭，本次没有修改画布')
      if (imageSource !== storyboardTaskSourceSignature(groupsRef.current, mediaGroupsRef.current.image)
        || storyboardTaskUsesAnalysis(draft.task) && textSource !== storyboardTaskSourceSignature(groupsRef.current, mediaGroupsRef.current.text)) throw new Error('生成来源已变化，当前配置已保留，请重新核对来源')
    }
    assertCurrent()
    const pendingOperation = !activeProject && draft.mode === 'create' ? new URLSearchParams(window.location.search).get('templateOperation') : null
    if (pendingOperation && draftOwnerId) {
      const saved = readSavedTemplateProjectSubmission(window.localStorage, draftOwnerId, pendingOperation)
      if (!saved || saved.templateId !== 'storyboard-creation' || saved.signature !== JSON.stringify(draft)) throw new Error('原故事板工程的创建结果尚未确认，请按原配置核对，或在项目中心查找；不会换图重复创建')
      try {
        await finishTemplateProjectCreation(saved)
        if (storyboardSessionRef.current === session) { storyboardSessionRef.current = null; setStoryboardSession(null) }
      } finally { templateProjectSubmissionRef.current.settled() }
      return
    }
    // An initially unloaded catalog can settle before submission. Once work
    // starts, every asynchronous result is tied to the exact current source.
    if (!storyboardTaskInitialSourceCurrent(session.imageSource, imageSource, mediaGroupsRef.current.image)
      || storyboardTaskUsesAnalysis(draft.task) && !storyboardTaskInitialSourceCurrent(session.textSource, textSource, mediaGroupsRef.current.text)) throw new Error('生成来源已切换，请保留当前配置并重新核对来源')
    function assertModelsCurrent() {
      if (draft.model && !mediaModelsRef.current.image.includes(draft.model)) throw new Error('图像模型在当前来源不可用，请重新选择；当前配置已保留')
      if (storyboardTaskUsesAnalysis(draft.task)) {
        if (!draft.analysis || !mediaGroupsRef.current.text || !mediaModelsRef.current.text.includes(draft.analysis.model) || mediaPreparationErrorsRef.current.text) throw new Error('自动剧情的文字来源或模型不可用，请重新选择，或关闭自动剧情并填写要求')
        validateTextImageInputConfiguration(draft.analysis.model, draft.references.length)
      }
    }
    assertModelsCurrent()
    const host = hostBridge(), assets: CanvasImageAssetSummary[] = []
    if (!host.getAssetDetail) throw new Error('当前宿主无法核对故事板原图与参考图')
    for (const reference of draft.references) {
      const assetId = reference.binding.kind === 'asset' ? reference.binding.assetId : reference.binding.kind === 'existing' ? session.references.find((entry) => entry.binding.kind === 'existing' && reference.binding.kind === 'existing' && entry.binding.edgeId === reference.binding.edgeId && entry.binding.outputIndex === reference.binding.outputIndex)?.asset?.assetId : undefined
      if (!assetId) throw new Error('原图或参考图尚未核对，请重新选择故事板图片')
      const asset = await host.getAssetDetail(assetId)
      assertCurrent(); assertModelsCurrent()
      if (!asset || asset.assetId !== assetId || asset.mediaType !== 'image' || !isTemplateImageAsset(asset)) throw new Error('故事板图片已失效，请从素材库重新选择')
      if (assets.some((entry) => entry.assetId === assetId)) throw new Error('原图与参考图必须使用不同的实际图片')
      assets.push(asset)
    }
    await host.refreshProjectAccess?.(); assertCurrent(); assertModelsCurrent()
    const access = host.getProjectAccess?.()
    if (access?.denied || access?.access && !access.access.canEdit) throw new Error('当前工程不可编辑，本次没有修改画布')
    const current = getGraphSnapshot()
    setAssetCatalog((previous) => [...previous.filter((asset) => !assets.some((verified) => verified.assetId === asset.assetId)), ...assets])
    if (draft.mode === 'edit') {
      const node = current.nodes.find((entry) => entry.id === session.nodeId)
      const upstream = buildCanvasUpstreamReferences(current.nodes, current.edges, assetCatalog).get(session.nodeId!) ?? []
      if (!node || session.signature !== storyboardTaskEditSignature(current.nodes.map(toWorkflowNode), current.edges.map(toWorkflowEdge), node.id, upstream)) throw new Error('故事板节点、图片、分析或连接已变化，请重新打开配置；尚未修改画布')
      const workflow = buildStoryboardNodeEdit({ workflow: { ...createEmptyWorkflow(activeProject?.name ?? '故事板创作'), nodes: current.nodes.map(toWorkflowNode), edges: current.edges.map(toWorkflowEdge) }, nodeId: node.id, draft, currentReferences: upstream, assets, analysisGroup: mediaGroupsRef.current.text, createId: nextNodeId })
      const updated = markNodeAndDescendantsDirty(workflow.nodes.map(toCanvasNode), workflow.edges, node.id)
      execute({ type: 'replace-graph', nodes: updated.map(canvasNodeDocumentRecord), edges: workflow.edges })
      graphRef.current = getGraphSnapshot(); setDirtyNodeIds(dirtyCanvasNodeIds(graphRef.current.nodes))
      storyboardSessionRef.current = null; setStoryboardSession(null)
      setBanner(storyboardTaskUsesAnalysis(draft.task) ? '已更新故事板配置并同步图片分析，可一次撤销；旧结果保留，核对后运行' : '已更新故事板配置与图片角色，可一次撤销；旧结果保留，核对后运行')
      return
    }
    const sources = draft.references.map((reference) => {
      if (reference.binding.kind !== 'asset') throw new Error('新建故事板请从素材库选择每张输入图片')
      const asset = assets.find((entry) => reference.binding.kind === 'asset' && entry.assetId === reference.binding.assetId)
      if (!asset) throw new Error('故事板输入图片尚未核对，请重新选择')
      return { ...asset, label: asset.displayName || asset.fileName }
    })
    const route = new URL(window.location.href), operationId = !activeProject && host.createTemplateProject ? templateProjectOperationId(route.searchParams, () => crypto.randomUUID()) : null
    let issued = 0
    const build = () => {
      const workflow = buildStoryboardWorkflow({ task: draft.task, sources, prompt: draft.prompt, model: draft.model,
        group: mediaGroupsRef.current.image, size: draft.size, quality: draft.quality, imageResolution: draft.imageResolution, candidateCount: draft.imageCandidateCount,
        ...(storyboardTaskUsesAnalysis(draft.task) && draft.analysis ? { analysis: { model: draft.analysis.model, group: mediaGroupsRef.current.text } } : {}),
        createId: operationId ? () => `${operationId}-${++issued}` : nextNodeId })
      workflow.mediaGroups = { ...mediaGroupsRef.current }
      if (current.nodes.length && !operationId) {
        const offset = Math.max(...current.nodes.filter((node) => !node.parentId).map((node) => node.position.x + snapBoxOfCanvasNode(node).width), 0) + 100
        workflow.nodes = workflow.nodes.map((node) => ({ ...node, position: { x: node.position.x + offset, y: node.position.y } }))
      }
      return workflow
    }
    try {
      if (operationId && host.createTemplateProject) {
        if (!draftOwnerId) throw new Error('当前账户的恢复空间尚未确认，请重新进入工作区')
        const submission = templateProjectSubmissionRef.current.prepare(operationId, JSON.stringify(draft), () => serializeWorkflow(build()))
        const saved: SavedTemplateProjectSubmission = { ...submission, version: 1, ownerId: draftOwnerId, templateId: 'storyboard-creation' }
        writeSavedTemplateProjectSubmission(window.localStorage, saved)
        route.searchParams.set('storyboardTask', draft.task.kind); route.searchParams.set('templateOperation', operationId); route.searchParams.delete('project')
        window.history.replaceState(window.history.state, '', `${route.pathname}${route.search}${route.hash}`)
        await finishTemplateProjectCreation(saved)
      } else {
        const workflow = build(); assertCurrent(); assertModelsCurrent()
        execute({ type: 'add-nodes', nodes: workflow.nodes.map((node) => canvasNodeDocumentRecord(toCanvasNode(node))), edges: workflow.edges })
        setNodes((latest) => latest.map((node) => ({ ...node, selected: workflow.nodes.some((entry) => entry.id === node.id) })))
        setBanner('已创建故事板流程，可一次撤销；宫格数为单张图片布局，核对模型与请求数后运行')
        void reactFlow.fitView({ nodes: workflow.nodes.map((node) => ({ id: node.id })), padding: .2, duration: 180, maxZoom: 1 })
      }
      if (storyboardSessionRef.current === session) { storyboardSessionRef.current = null; setStoryboardSession(null) }
    } finally { templateProjectSubmissionRef.current.settled() }
  }, [assertCommerceCurrent, getGraphSnapshot, assetCatalog, activeProject, execute, draftOwnerId, finishTemplateProjectCreation, setNodes, reactFlow])

  const openTemplateCatalog = useCallback((templateId?: string) => {
    setQuickInsert(null)
    setTemplateCatalog(templateId ? { initialTemplateId: templateId } : {})
  }, [])

  const addAssetNode = useCallback((assetId: string, position?: { x: number; y: number }) => {
    const asset = assetPage.items.find((entry) => entry.assetId === assetId)
    if (!asset) return
    createAssetNode(asset, position)
    void markCanvasAssetUsed(assetId)
  }, [assetPage.items, createAssetNode, markCanvasAssetUsed])

  const assetBatchAddingRef = useRef(false)
  const addAssetNodes = useCallback(async (assetIds: readonly string[], position?: XYPosition) => {
    if (assetBatchAddingRef.current) throw new Error('素材正在加入画布，请稍候')
    const ids = validateAssetBatchIds(assetIds)
    const epoch = projectEpochRef.current, projectId = activeProjectIdRef.current
    function assertCurrent() {
      if (!mediaPreparationMountedRef.current || !draftActionsEnabledRef.current || !projectCanEditRef.current || projectTransitionRef.current || epoch !== projectEpochRef.current || projectId !== activeProjectIdRef.current) throw new Error('工程或编辑权限已变化，本次没有添加素材，请重新选择')
    }
    assertCurrent()
    assetBatchAddingRef.current = true
    const host = hostBridge()
    try {
      if (!host.getAssetDetail) throw new Error('当前宿主暂不支持批量素材，请更新后重试')
      const assets = []
      for (const id of ids) {
        const asset = await host.getAssetDetail(id)
        assertCurrent(); assertBatchAssetAvailable(asset)
        assets.push(asset)
      }
      await host.refreshProjectAccess?.()
      assertCurrent()
      const access = host.getProjectAccess?.()
      if (access?.denied || access?.access && !access.access.canEdit) throw new Error('当前项目不可编辑，本次没有添加素材')
      const bounds = document.querySelector('.canvas-flow')?.getBoundingClientRect()
      const center = position ?? (bounds ? currentReactFlowRef.current.screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }) : { x: 420, y: 300 })
      const current = getGraphSnapshot()
      const command = buildAssetBatchNodes(current.nodes.map((node) => ({ ...canvasNodeDocumentRecord(node), width: node.measured?.width ?? node.width, height: node.measured?.height ?? node.height })), assets, assets.map(() => nextNodeId()), center)
      execute(command)
      const added = new Set(command.nodes.map((node) => node.id))
      setNodes((latest) => latest.map((node) => ({ ...node, selected: added.has(node.id) })))
      for (const asset of assets) void markCanvasAssetUsed(asset.assetId)
      if (!position) void currentReactFlowRef.current.fitView({ nodes: command.nodes.map((node) => ({ id: node.id })), padding: .2, duration: 180, maxZoom: 1 })
      setBanner(`已将 ${assets.length} 项素材加入画布，可一次撤销`)
    } finally { assetBatchAddingRef.current = false }
  }, [execute, getGraphSnapshot, markCanvasAssetUsed, setNodes])

  const downloadAssetNodes = useCallback(async (assetIds: readonly string[]) => {
    const host = hostBridge()
    if (!host.downloadAssets) throw new Error('当前宿主暂不支持批量下载，请更新后重试')
    await host.downloadAssets(assetIds)
  }, [])

  function assertRunResultCollectionCurrent(session: RunResultCollectionSession) {
    const currentScope = layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
    if (runResultCollectionSessionRef.current !== session || !agentMountedRef.current || !draftActionsEnabledRef.current || !projectCanRunRef.current || projectTransitionRef.current || session.runtimeScope !== currentScope || session.scope.accountId !== layerEditorOwnerRef.current.accountId || session.scope.projectId !== activeProjectIdRef.current) throw new Error('账号、工程或访问权限已变化，请重新打开运行素材收集')
  }

  const openRunResultCollection = useCallback(() => {
    const host = hostBridge()
    const projectId = activeProjectIdRef.current
    if (!creationOwnerId || creationOwnerId !== layerEditorOwnerRef.current.accountId || !projectId || !projectCanRunRef.current || !draftActionsEnabledRef.current || projectTransitionRef.current) { setBanner('请在本人已打开的项目中收集运行素材'); return }
    if (!host.listRunHistory || !host.readRunHistory || !host.getAssetDetail) { setBanner('当前宿主暂不支持完整运行历史收集，请更新后重新打开'); return }
    const runtimeScope = layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId, projectEpoch: projectEpochRef.current, enabled: draftActionsEnabledRef.current })
    const session: RunResultCollectionSession = { scope: { accountId: creationOwnerId, projectId }, runtimeScope, ...(selectedRunId ? { initialRunId: selectedRunId } : {}) }
    runResultCollectionSessionRef.current = session
    setRunResultCollectionSession(session)
  }, [creationOwnerId, layerEditorScope, selectedRunId])

  const listRunResultCollectionHistory = useCallback(async (session: RunResultCollectionSession, query: Omit<CanvasRunSummaryQuery, 'projectId'>, signal: AbortSignal) => {
    assertRunResultCollectionCurrent(session)
    const read = hostBridge().listRunHistory
    if (!read) throw new Error('当前宿主暂不支持分页运行历史')
    const result = await read(query, signal)
    assertRunResultCollectionCurrent(session)
    return result
  }, [])

  const readRunResultCollectionHistory = useCallback(async (session: RunResultCollectionSession, runId: string, signal: AbortSignal) => {
    assertRunResultCollectionCurrent(session)
    const read = hostBridge().readRunHistory
    if (!read) throw new Error('当前宿主暂不支持读取原运行候选')
    const result = await read(runId, signal)
    assertRunResultCollectionCurrent(session)
    return result
  }, [])

  const readRunResultCollectionAsset = useCallback(async (session: RunResultCollectionSession, assetId: string, signal: AbortSignal) => {
    assertRunResultCollectionCurrent(session)
    const result = await readCanvasAssetDetail(assetId, signal)
    assertRunResultCollectionCurrent(session)
    return result
  }, [readCanvasAssetDetail])

  const applyRunResultCollection = useCallback(async (session: RunResultCollectionSession, kind: 'add' | 'download', assetIds: readonly string[]) => {
    assertRunResultCollectionCurrent(session)
    const ids = [...assetIds]
    if (kind === 'add') await addAssetNodes(ids)
    else await downloadAssetNodes(ids)
    assertRunResultCollectionCurrent(session)
  }, [addAssetNodes, downloadAssetNodes])

  function closeRunResultCollection(session: RunResultCollectionSession) {
    if (runResultCollectionSessionRef.current !== session) return
    runResultCollectionSessionRef.current = null
    setRunResultCollectionSession(null)
  }

  const buildSelectionClipboard = useCallback((nodeIds: readonly string[]) => {
    const selected = new Set(nodes.filter((node) => nodeIds.includes(node.id)).map((node) => node.id))
    if (selected.size === 0) return null
    return buildCanvasClipboardPayload(
      nodes.map((node) => ({
        id: node.id,
        type: node.type ?? 'unknown',
        definitionVersion: node.definitionVersion,
        position: { ...node.position },
        data: structuredClone(node.data),
        ...(node.disabled ? { disabled: true } : {}),
        ...(node.unknownKind ? { unknownKind: node.unknownKind } : {}),
        ...(node.parentId ? { parentId: node.parentId } : {}),
        ...((node.measured?.width ?? node.width) ? { width: node.measured?.width ?? node.width } : {}),
        ...((node.measured?.height ?? node.height) ? { height: node.measured?.height ?? node.height } : {}),
        ...(node.draggable === false ? { locked: true } : {}),
      })),
      edges.map(toWorkflowEdge),
      selected,
    )
  }, [nodes, edges])

  const currentClipboardScope = useCallback(() => agentMountedRef.current && draftActionsEnabledRef.current && !projectTransitionRef.current && !draftRecoveryPendingRef.current && !closeBusyRef.current
    ? layerEditorScopeToken({ ...layerEditorOwnerRef.current, projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current, enabled: true }) : null, [])

  const copyNodes = useCallback(async (nodeIds: readonly string[], event?: ClipboardEvent) => {
    const scope = currentClipboardScope()
    if (!scope) return false
    clipboardRef.current.controller?.abort(); clipboardRef.current.controller = null
    const revision = ++clipboardRef.current.revision
    try {
      const payload = buildSelectionClipboard(nodeIds)
      if (!payload) { setBanner('请先选择需要复制的节点'); return false }
      const text = buildCanvasClipboardTransfer(payload, { ownerId: canvasClipboardOwnerId(layerEditorOwnerRef.current.accountId, canvasCapabilities().host, clipboardIdentityRef.current.workspaceId), projectId: activeProjectIdRef.current })
      if (event) {
        if (!writeCanvasClipboardEvent(event.clipboardData, text)) throw new Error('浏览器未写入剪贴板，请保持选区并按 Ctrl/Cmd+C 重试')
        event.preventDefault()
      } else {
        if (!navigator.clipboard?.writeText) throw new Error('浏览器不允许菜单复制，请保持选区，回到画布后按 Ctrl/Cmd+C；创建副本仍可使用')
        await navigator.clipboard.writeText(text)
      }
      clipboardIdentityRef.current.copied = text
      if (currentClipboardScope() !== scope || clipboardRef.current.revision !== revision) return false
      setBanner(`已复制 ${payload.nodes.length} 个节点到系统剪贴板，可在同一账号的其他画布或新标签页粘贴（含分组子项与内部连线，不恢复原生成任务）`)
      return true
    } catch (cause) {
      if (currentClipboardScope() === scope && clipboardRef.current.revision === revision) setBanner(cause instanceof Error && cause.name !== 'NotAllowedError' ? cause.message : '浏览器拒绝菜单复制，请保持选区，回到画布后按 Ctrl/Cmd+C；创建副本仍可使用')
      return false
    }
  }, [buildSelectionClipboard, currentClipboardScope])

  const copySelection = useCallback((event?: ClipboardEvent) => copyNodes(nodes.filter((node) => node.selected).map((node) => node.id), event), [copyNodes, nodes])

  const applyClipboardPayload = useCallback((clipboard: CanvasClipboardPayload) => {
    if (!currentClipboardScope() || !projectCanEditRef.current) throw new Error('当前画布只读或正在切换，选区尚未粘贴')
    const pasted = pasteCanvasClipboard(clipboard, {
      offset: { x: 32, y: 32 },
      createNodeId: () => nextNodeId(),
      createEdgeId: () => nextNodeId(),
    })
    const pastedNodes = pasted.nodes.map((node) => toCanvasNode({
        id: node.id,
        kind: node.type as NodeKind,
        definitionVersion: node.definitionVersion,
        position: node.position,
        data: node.data as unknown as WorkflowNode['data'],
        ...(node.parentId ? { parentId: node.parentId } : {}),
        ...(node.width ? { width: node.width } : {}),
        ...(node.height ? { height: node.height } : {}),
        ...(node.locked ? { locked: true } : {}),
        ...(node.disabled ? { disabled: true } : {}),
        ...(node.unknownKind ? { unknownKind: node.unknownKind } : {}),
      }))
    const graph = getGraphSnapshot()
    const combined = { ...createEmptyWorkflow(activeProject?.name ?? '未命名工作流'), mediaGroups: { ...mediaGroupsRef.current }, nodes: [...graph.nodes.map(toWorkflowNode), ...pastedNodes.map(toWorkflowNode)], edges: [...graph.edges.map(toWorkflowEdge), ...pasted.edges] }
    if (combined.nodes.length > maximumProjectNodes || combined.edges.length > maximumProjectEdges || utf8ByteLength(serializeWorkflow(combined)) > maximumProjectContentBytes) throw new Error('粘贴后会超过单个云端工程容量，请新建空白画布后粘贴，或拆分选区；当前没有插入任何节点')
    execute({ type: 'add-nodes', nodes: pastedNodes.map(canvasNodeDocumentRecord), edges: pasted.edges })
    // Selection is a renderer concern and is intentionally omitted from the
    // persisted node record. Restore it after the history command so paste and
    // duplicate leave the newly created nodes selected, matching the clipboard
    // contract and preventing the old overlapping node from being grabbed by
    // the next pointer gesture.
    const pastedIds = new Set(pastedNodes.map((node) => node.id))
    setNodes((current) => current.map((node) => ({ ...node, selected: pastedIds.has(node.id) })))
    setBanner(`已粘贴 ${pastedNodes.length} 个节点和 ${pasted.edges.length} 条内部连线，可一步撤销；原素材与模型来源保持独立引用`)
  }, [currentClipboardScope, execute, setNodes, getGraphSnapshot, activeProject?.name])

  const pasteSelection = useCallback(async (content?: string) => {
    const scope = currentClipboardScope()
    if (!scope || !projectCanEditRef.current) return
    clipboardRef.current.controller?.abort()
    const controller = new AbortController(), revision = ++clipboardRef.current.revision, cloudBridge = window.xingmangCanvasHost, bridge = cloudBridge ?? hostBridge()
    clipboardRef.current.controller = controller
    const current = () => !controller.signal.aborted && clipboardRef.current.revision === revision && currentClipboardScope() === scope && projectCanEditRef.current && cloudBridge === window.xingmangCanvasHost
    try {
      setBanner('正在读取剪贴板并核对选区素材…')
      await runCanvasClipboardPaste({ ownerId: canvasClipboardOwnerId(layerEditorOwnerRef.current.accountId, canvasCapabilities().host, clipboardIdentityRef.current.workspaceId), current,
        async read() {
          if (content !== undefined) return content
          if (!navigator.clipboard?.readText) throw new Error('浏览器不允许菜单读取剪贴板，请回到画布后按 Ctrl/Cmd+V；当前没有粘贴')
          return navigator.clipboard.readText()
        },
        async inspect(payload, text) {
          // The desktop has no inspection channel; it pastes back only what this
          // workspace copied, as the old in-window desktop clipboard did.
          if (!bridge.inspectClipboardWorkflow && canvasClipboardCopiedHere(text, clipboardIdentityRef.current.copied)) return
          if (!bridge.inspectClipboardWorkflow) throw new Error('这些节点带着素材或固定的模型来源，当前客户端核对不了，没有粘贴；可以用「创建副本」')
          await bridge.inspectClipboardWorkflow(canvasClipboardWorkflow(payload), controller.signal)
        }, apply: applyClipboardPayload,
      })
    } catch (cause) {
      if (current()) setBanner(cause instanceof Error && cause.name !== 'NotAllowedError' ? cause.message : '浏览器拒绝菜单读取剪贴板，请回到画布后按 Ctrl/Cmd+V；当前没有粘贴')
    } finally { if (clipboardRef.current.controller === controller) clipboardRef.current.controller = null }
  }, [currentClipboardScope, applyClipboardPayload])

  const duplicateNodes = useCallback((nodeIds: readonly string[]) => {
    if (!currentClipboardScope() || !projectCanEditRef.current) return
    try {
      const payload = buildSelectionClipboard(nodeIds)
      if (!payload) return
      const canonical = parseCanvasClipboard(serializeCanvasClipboard(payload))
      if (!canonical) throw new Error('选区配置无法创建副本，请检查原节点')
      applyClipboardPayload(canonical)
    } catch (cause) { setBanner(cause instanceof Error ? cause.message : '创建副本未完成') }
  }, [currentClipboardScope, buildSelectionClipboard, applyClipboardPayload])

  useEffect(() => {
    function available(event: ClipboardEvent) {
      return Boolean(currentClipboardScope() && !runPreflight && !closeBusyRef.current && !draftActionBusy && canvasClipboardEventAllowed(event, canvasModalOpen()))
    }
    function onCopy(event: ClipboardEvent) {
      if (!available(event) || window.getSelection()?.isCollapsed === false) return
      void copySelection(event)
    }
    function onPaste(event: ClipboardEvent) {
      if (!available(event) || !projectCanEditRef.current || !event.clipboardData) return
      const text = event.clipboardData.getData(canvasClipboardMime) || event.clipboardData.getData('text/plain')
      if (!text) return
      event.preventDefault(); void pasteSelection(text)
    }
    window.addEventListener('copy', onCopy); window.addEventListener('paste', onPaste)
    return () => { window.removeEventListener('copy', onCopy); window.removeEventListener('paste', onPaste) }
  }, [currentClipboardScope, copySelection, pasteSelection, runPreflight, draftActionBusy])

  const groupNodes = useCallback((nodeIds: readonly string[]) => {
    const selected = new Set(resourceGroupSelectionIds(nodes, nodeIds))
    if (selected.size < 2) { setBanner('请选择至少两个同级资源；已选分组会包含其子项'); return }
    const editorNodes = nodes.map((node) => ({
      id: node.id,
      type: node.type ?? 'unknown',
      definitionVersion: node.definitionVersion,
      position: { ...node.position },
      data: structuredClone(node.data),
      ...(node.disabled ? { disabled: true } : {}),
      ...(node.unknownKind ? { unknownKind: node.unknownKind } : {}),
      ...(node.parentId ? { parentId: node.parentId } : {}),
      width: reactFlow.getNode(node.id)?.measured?.width ?? node.measured?.width ?? node.width ?? builtinNodeRegistry.resolve(node.type ?? 'unknown')?.dimensions.width,
      height: reactFlow.getNode(node.id)?.measured?.height ?? node.measured?.height ?? node.height ?? builtinNodeRegistry.resolve(node.type ?? 'unknown')?.dimensions.height,
      ...(node.draggable === false ? { locked: true } : {}),
    }))
    const groupId = nextNodeId()
    let grouped: EditorNodeRecord[] | null
    try { grouped = groupCanvasNodes(editorNodes, selected, { groupId, title: '创作分组' }) }
    catch (error) { setBanner(error instanceof Error ? error.message : '编组失败，画布保持原样'); return }
    if (!grouped || !validateParentGraph(grouped)) { setBanner('无法编组，请检查分组层级是否超过 8 层'); return }
    const updated = grouped.map((node) => toCanvasNode({
      id: node.id,
      kind: node.type as NodeKind,
      definitionVersion: node.definitionVersion,
      position: node.position,
      data: node.id === groupId
        ? workflowNodeData('group', node.data)
        : node.data as unknown as WorkflowNode['data'],
      ...(node.parentId ? { parentId: node.parentId } : {}),
      ...(node.width ? { width: node.width } : {}),
      ...(node.height ? { height: node.height } : {}),
      ...(node.locked ? { locked: true } : {}),
      ...(node.disabled ? { disabled: true } : {}),
      ...(node.unknownKind ? { unknownKind: node.unknownKind } : {}),
    }))
    const updatedById = new Map(updated.map((node) => [node.id, node]))
    const parentFirst = buildResourceTree(updated).rows.map((row) => canvasNodeDocumentRecord(updatedById.get(row.id)!))
    execute({ type: 'replace-nodes', nodes: parentFirst })
    setNodes((current) => current.map((node) => ({ ...node, selected: node.id === groupId })))
    setBanner('已编组；整组已选中，可重命名、移动或保存到工坊')
  }, [nodes, execute, setNodes, reactFlow])

  const groupSelection = useCallback(() => groupNodes(nodes.filter((node) => node.selected).map((node) => node.id)), [groupNodes, nodes])

  const ungroupNodes = useCallback((nodeIds: readonly string[]) => {
    const groups = nodes.filter((node) => nodeIds.includes(node.id) && node.type === 'group')
    if (groups.length === 0) return
    let ungrouped: EditorNodeRecord[] = nodes.map((node) => ({
      id: node.id,
      type: node.type ?? 'unknown',
      definitionVersion: node.definitionVersion,
      position: { ...node.position },
      data: structuredClone(node.data),
      ...(node.disabled ? { disabled: true } : {}),
      ...(node.unknownKind ? { unknownKind: node.unknownKind } : {}),
      ...(node.parentId ? { parentId: node.parentId } : {}),
      width: reactFlow.getNode(node.id)?.measured?.width ?? node.measured?.width ?? node.width ?? builtinNodeRegistry.resolve(node.type ?? 'unknown')?.dimensions.width,
      height: reactFlow.getNode(node.id)?.measured?.height ?? node.measured?.height ?? node.height ?? builtinNodeRegistry.resolve(node.type ?? 'unknown')?.dimensions.height,
      ...(node.draggable === false ? { locked: true } : {}),
    }))
    for (const group of groups) ungrouped = ungroupCanvasNode(ungrouped, group.id) ?? ungrouped
    const updated = ungrouped.map((node) => toCanvasNode({
      id: node.id,
      kind: node.type as NodeKind,
      definitionVersion: node.definitionVersion,
      position: node.position,
      data: node.data as unknown as WorkflowNode['data'],
      ...(node.parentId ? { parentId: node.parentId } : {}),
      ...(node.width ? { width: node.width } : {}),
      ...(node.height ? { height: node.height } : {}),
      ...(node.locked ? { locked: true } : {}),
      ...(node.disabled ? { disabled: true } : {}),
      ...(node.unknownKind ? { unknownKind: node.unknownKind } : {}),
    }))
    execute({ type: 'replace-nodes', nodes: updated.map(canvasNodeDocumentRecord) })
  }, [nodes, execute])

  const ungroupSelection = useCallback(() => ungroupNodes(nodes.filter((node) => node.selected).map((node) => node.id)), [ungroupNodes, nodes])

  // React Flow keeps measured size on node.measured; the definition size is the
  // fallback for a node that has not been laid out yet.
  const layoutSelection = useCallback((operation: CanvasSelectionLayout) => {
    try {
      const measured = nodes.map((node) => {
        const live = reactFlow.getNode(node.id) ?? node
        const fallback = builtinNodeRegistry.resolve(node.type ?? 'unknown')?.dimensions
        return { ...canvasNodeDocumentRecord(node), width: live.measured?.width ?? node.width ?? fallback?.width ?? 240, height: live.measured?.height ?? node.height ?? fallback?.height ?? 180 }
      })
      const result = layoutCanvasSelection(measured, nodes.filter((node) => node.selected).map((node) => node.id), operation)
      if (result.changed) {
        execute({ type: 'replace-nodes', nodes: result.nodes })
        setBanner(`已${operation.kind === 'align' ? '对齐' : '均匀分布'}选中节点，锁定位置保持不变，可一次撤销恢复`)
      } else if (result.selectedRootIds.length < (operation.kind === 'align' ? 2 : 3)) {
        setBanner(`请至少选择 ${operation.kind === 'align' ? 2 : 3} 个独立节点${operation.kind === 'align' ? '进行对齐' : '进行均匀分布'}；分组与其子节点同时选中时按一个整体计算，本次未改变位置`)
      } else if (result.lockedRootCount > 0) {
        setBanner('本次未改变位置：选区中有节点受自身、父组或子节点锁定保护，其余节点在此方向无需移动；可解锁相关节点或分组后重试')
      } else {
        setBanner(operation.kind === 'align' ? '选中节点已经满足此方向的对齐，本次未改变位置' : '选中节点已在此方向均匀分布，本次未改变位置')
      }
    } catch (error) { setBanner(error instanceof Error ? error.message : '节点对齐失败，原位置仍保留') }
  }, [execute, nodes, reactFlow])

  const alignSelection = useCallback((mode: CanvasAlignMode) => layoutSelection({ kind: 'align', mode }), [layoutSelection])
  const distributeSelection = useCallback((axis: CanvasDistributeAxis) => layoutSelection({ kind: 'distribute', axis }), [layoutSelection])

  const openContextMenuFor = useCallback((event: { clientX: number; clientY: number; preventDefault(): void }, node: CanvasNode) => {
    event.preventDefault()
    const bounds = document.querySelector('.canvas-flow')?.getBoundingClientRect()
    if (!bounds) return
    // Right-clicking an unselected node acts on that node alone; right-clicking
    // inside an existing selection acts on the whole selection. This is the
    // file-manager convention and users rely on it for batch actions.
    const nodeIds = canvasContextNodeIds(nodes, node.id)
    const scope = nodes.filter((entry) => nodeIds.includes(entry.id))
    if (scope.length === 0) return
    const disableEligible = scope.filter((entry) => entry.type !== 'unknown')
    setQuickInsert(null)
    setContextMenu({
      nodeId: node.id,
      nodeIds,
      scope: layerEditorScope,
      x: Math.max(8, Math.min(bounds.width - 190, event.clientX - bounds.left)),
      y: Math.max(8, Math.min(bounds.height - Math.min(500, bounds.height * 0.7) - 8, event.clientY - bounds.top)),
      target: scope.length > 1 ? 'selection' : 'node',
      selectionCount: scope.length,
      executable: builtinNodeRegistry.resolve(node.type ?? 'unknown')?.executable === true,
      running: node.data.status === 'running' || node.data.status === 'queued',
      hasGroup: scope.some((entry) => entry.type === 'group'),
      allLocked: scope.every((entry) => entry.draggable === false),
      allDisabled: disableEligible.length > 0 && disableEligible.every((entry) => entry.disabled === true),
      canDisable: disableEligible.length > 0,
      canSaveWorkshop: Boolean(SaveCanvasWorkshopDialog && hostBridge().createWorkshopItem),
      relatedOptions: scope.length === 1 ? relatedNodeOptions(node.id, nodes.map(canvasNodeDocumentRecord), edges.map(toWorkflowEdge), canvasCapabilities()) : [],
      ...(scope.length > 1 && canvasCapabilities().features.imageTools ? { batchImages: { disabledReason: analyzeBatchImageRelatedSources(nodes.map(canvasNodeDocumentRecord), nodeIds).disabledReason } } : {}),
    })
  }, [nodes, edges, layerEditorScope, SaveCanvasWorkshopDialog])

  const deleteSelection = useCallback(() => {
    const nodeIds = nodes.filter((node) => node.selected).map((node) => node.id)
    if (nodeIds.length === 0) return
    deleteNodesBridging(nodeIds)
  }, [deleteNodesBridging, nodes])

  const isValidConnection = useCallback((connection: Connection | Edge) => (
    isValidWorkflowConnection(connection as Connection, {
      nodeKindOf: (nodeId) => {
        const node = nodes.find((entry) => entry.id === nodeId)
        return (node?.type as NodeKind | undefined) ?? null
      },
      edges,
    })
  ), [nodes, edges])

  // Retargeting an existing connection. Without it, moving where a wire lands
  // means delete plus redraw, which is two undo steps for one intention.
  const onReconnect = useCallback((edge: Edge, connection: Connection) => {
    if (!connection.source || !connection.target) return
    // Validate against the graph *without* this edge. Leaving it in makes a
    // single-capacity target reject the very wire that already occupies it.
    const valid = isValidWorkflowConnection(connection, {
      nodeKindOf: (nodeId) => {
        const node = nodes.find((entry) => entry.id === nodeId)
        return (node?.type as NodeKind | undefined) ?? null
      },
      edges: edges.filter((entry) => entry.id !== edge.id),
    })
    if (!valid) {
      setBanner('该端口不接受这条连线')
      return
    }
    execute({
      type: 'reconnect-edge',
      edgeId: edge.id,
      edge: {
        id: edge.id,
        source: connection.source,
        sourceHandle: connection.sourceHandle ?? '',
        target: connection.target,
        targetHandle: connection.targetHandle ?? '',
      },
    })
  }, [edges, execute, nodes])

  const openQuickInsertAt = useCallback((client: { x: number; y: number }, connection?: PendingCanvasConnection) => {
    const bounds = document.querySelector('.canvas-flow')?.getBoundingClientRect()
    if (!bounds) return
    let compatibleHandles: Record<string, string> | undefined
    if (connection) {
      const graph = {
        nodeKindOf: (nodeId: string) => nodes.find((entry) => entry.id === nodeId)?.type ?? null,
        edges,
      }
      compatibleHandles = Object.fromEntries(builtinNodeRegistry.list().flatMap((definition) => {
        if (!canvasNodeKindAvailable(definition.type, canvasCapabilities())) return []
        const handleId = compatibleInsertionHandle(definition.type, connection, graph)
        return handleId ? [[definition.type, handleId]] : []
      }))
      if (Object.keys(compatibleHandles).length === 0) {
        setBanner('没有可连接到该端口的节点')
        return
      }
    }
    setRunMenuOpen(false)
    setMoreActionsOpen(false)
    setMediaConfigOpen(false)
    setNodeSearchOpen(false)
    setQuickInsert({
      anchor: {
        x: Math.max(12, Math.min(bounds.width - 372, client.x - bounds.left - 180)),
        y: Math.max(12, Math.min(bounds.height - 430, client.y - bounds.top - 70)),
      },
      flowPosition: reactFlow.screenToFlowPosition(client),
      ...(connection ? { connection, compatibleHandles } : {}),
      ...(!connection ? { batchSourceIds: nodes.filter((node) => node.selected).map((node) => node.id), scope: layerEditorScope } : {}),
    })
  }, [edges, nodes, reactFlow, layerEditorScope])

  const openEdgeQuickInsertAt = useCallback((client: { x: number; y: number }, edge: Edge) => {
    const bounds = document.querySelector('.canvas-flow')?.getBoundingClientRect()
    if (!bounds) return
    const remainingEdges = edges.filter((entry) => entry.id !== edge.id)
    const graph = {
      nodeKindOf: (nodeId: string) => nodes.find((entry) => entry.id === nodeId)?.type ?? null,
      edges: remainingEdges,
    }
    const sourceConnection: PendingCanvasConnection = { nodeId: edge.source, handleId: edge.sourceHandle ?? '', handleType: 'source' }
    const targetConnection: PendingCanvasConnection = { nodeId: edge.target, handleId: edge.targetHandle ?? '', handleType: 'target' }
    const compatibleHandles = Object.fromEntries(builtinNodeRegistry.list().flatMap((definition) => {
      if (!canvasNodeKindAvailable(definition.type, canvasCapabilities())) return []
      const inputHandle = compatibleInsertionHandle(definition.type, sourceConnection, graph)
      const outputHandle = compatibleInsertionHandle(definition.type, targetConnection, graph)
      return inputHandle && outputHandle ? [[definition.type, `${inputHandle}|${outputHandle}`]] : []
    }))
    if (Object.keys(compatibleHandles).length === 0) {
      setBanner('没有可插入当前连线的节点')
      return
    }
    setRunMenuOpen(false)
    setMoreActionsOpen(false)
    setMediaConfigOpen(false)
    setQuickInsert({
      anchor: {
        x: Math.max(12, Math.min(bounds.width - 372, client.x - bounds.left - 180)),
        y: Math.max(12, Math.min(bounds.height - 430, client.y - bounds.top - 70)),
      },
      flowPosition: reactFlow.screenToFlowPosition(client),
      edgeId: edge.id,
      compatibleHandles,
    })
  }, [edges, nodes, reactFlow])

  const runContextAction = useCallback((action: CanvasContextAction, nodeId: string) => {
    const scopeIds = contextMenu?.nodeIds ?? [nodeId]
    const disableEligible = nodes
      .filter((node) => scopeIds.includes(node.id) && node.type !== 'unknown')
      .map((node) => node.id)
    if (action === 'rename') {
      const node = nodes.find((entry) => entry.id === nodeId)
      if (node) setRenamingNode({ id: nodeId, name: typeof node.data.settings?.title === 'string' ? node.data.settings.title : builtinNodeRegistry.resolve(node.type ?? 'unknown')?.title ?? '节点' })
      return
    }
    if (action === 'save-workshop') { saveWorkshopSelection(scopeIds); return }
    if (action === 'batch-images') { openBatchImageRelated(scopeIds, contextMenu?.scope); return }
    if (action.startsWith('related:')) {
      const source = nodes.find((entry) => entry.id === nodeId)
      const option = relatedNodeOptions(nodeId, nodes.map(canvasNodeDocumentRecord), edges.map(toWorkflowEdge), canvasCapabilities()).find((entry) => entry.id === action.slice(8))
      if (!source || !option) { setBanner('这个节点没有匹配的输出端口，请重新选择'); return }
      const absolute = reactFlow.getInternalNode(nodeId)?.internals.positionAbsolute ?? source.position
      const center = { x: absolute.x + (source.measured?.width ?? source.width ?? 280) + 220, y: absolute.y + 120 }
      const position = findAvailableCanvasPosition(nodes, center, builtinNodeRegistry.require(option.type).dimensions)
      addConnectedNode(option.type, position, option.pending, option.inputHandle)
      return
    }
    if (action === 'run') { void rerunNode(nodeId); return }
    if (action === 'locate') { locateNode(nodeId); return }
    if (action === 'copy') { void copyNodes(scopeIds); return }
    if (action === 'duplicate') { duplicateNodes(scopeIds); return }
    if (action === 'group') { groupNodes(scopeIds); return }
    if (action === 'ungroup') { ungroupNodes(scopeIds); return }
    if (action === 'lock' || action === 'unlock') { setNodeFlags([...scopeIds], 'locked', action === 'lock'); return }
    if (action === 'disable' || action === 'enable') { setNodeFlags(disableEligible, 'disabled', action === 'disable'); return }
    if (action === 'delete') deleteNodesBridging([...scopeIds])
  }, [contextMenu, copyNodes, duplicateNodes, deleteNodesBridging, groupNodes, locateNode, nodes, edges, rerunNode, setNodeFlags, ungroupNodes, saveWorkshopSelection, reactFlow, addConnectedNode, openBatchImageRelated])

  // Handed to the custom edge through context rather than through edge data, so
  // the callbacks are not serialized into the document on every render.
  const edgeHandlers = useMemo(() => ({
    onDisconnect: (edgeId: string) => execute({ type: 'disconnect', edgeIds: [edgeId] }),
    onInsertNode: (edgeId: string, client: { x: number; y: number }) => {
      const edge = edges.find((entry) => entry.id === edgeId)
      if (edge) openEdgeQuickInsertAt(client, edge)
    },
  }), [edges, execute, openEdgeQuickInsertAt])

  const onConnectStart = useCallback((_event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
    setUiPreferences((current) => current.connectionsHidden ? { ...current, connectionsHidden: false } : current)
    connectionStartRef.current = params.nodeId && params.handleId && (params.handleType === 'source' || params.handleType === 'target')
      ? { nodeId: params.nodeId, handleId: params.handleId, handleType: params.handleType }
      : null
  }, [])

  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    const pending = connectionStartRef.current
    connectionStartRef.current = null
    if (!pending || state.isValid === true) return
    const point = connectionEventPoint(event)
    if (!point) return
    // A node can re-measure while a connection preview is active (for example
    // when upstream references expand). Accept the nearest compatible target
    // handle within a small radius before falling back to the quick insert
    // palette, so a valid drop is not lost on a moving handle.
    const expectedType = pending.handleType === 'source' ? 'target' : 'source'
    let nearest: { distance: number; connection: Connection } | null = null
    for (const element of document.querySelectorAll<HTMLElement>('.react-flow__handle')) {
      if (element.dataset.nodeid === pending.nodeId || !element.classList.contains(`react-flow__handle-${expectedType}`)) continue
      const rect = element.getBoundingClientRect()
      const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      const distance = Math.hypot(center.x - point.x, center.y - point.y)
      if (distance > 80) continue
      const nodeId = element.dataset.nodeid
      const handleId = element.dataset.handleid
      if (!nodeId || !handleId) continue
      const candidate: Connection = pending.handleType === 'source'
        ? { source: pending.nodeId, sourceHandle: pending.handleId, target: nodeId, targetHandle: handleId }
        : { source: nodeId, sourceHandle: handleId, target: pending.nodeId, targetHandle: pending.handleId }
      if (!isValidConnection(candidate)) continue
      if (!nearest || distance < nearest.distance) nearest = { distance, connection: candidate }
    }
    if (nearest) {
      onConnect(nearest.connection)
      return
    }
    openQuickInsertAt(point, pending)
  }, [isValidConnection, onConnect, openQuickInsertAt])

  const selectedNodes = nodes.filter((node) => node.selected)
  const selectedNodeIds = selectedNodes.map((node) => node.id)
  const renderedEdges = useMemo(() => {
    const selected = new Set(selectedNodeIds)
    return edges.map((edge) => {
      const flowing = canvasEdgeTouchesSelection(edge, selected)
      const className = canvasEdgeClassName({
        dropTarget: edge.id === edgeDropTargetId,
        flowing,
      })
      const currentFlowing = canvasEdgeIsFlowing(edge.data)
      const hidden = uiPreferences.connectionsHidden === true
      if (className === edge.className && currentFlowing === flowing && edge.hidden === hidden) return edge
      return {
        ...edge,
        hidden,
        className,
        data: { ...(edge.data && typeof edge.data === 'object' ? edge.data : {}), flowing },
      }
    })
  }, [edgeDropTargetId, edges, selectedNodeIds, uiPreferences.connectionsHidden])
  const allSelectedLocked = selectedNodes.length > 0 && selectedNodes.every((node) => node.draggable === false)
  const selectedDisableEligibleNodes = selectedNodes.filter(isCanvasGraphNode)
  const selectedDisableEligibleIds = selectedDisableEligibleNodes.map((node) => node.id)
  const allSelectedDisabled = selectedDisableEligibleNodes.length > 0 && selectedDisableEligibleNodes.every((node) => node.disabled)
  const selectedRunnableCount = nodes.filter((node) => node.selected && isCanvasRunnableTarget(node)).length
  const runScopeLabel = runScopeKind === 'all'
    ? '运行全部'
    : runScopeKind === 'dirty'
      ? `运行变更${dirtyNodeIds.size ? ` (${dirtyNodeIds.size})` : ''}`
      : runScopeKind === 'selection'
        ? `运行选中${selectedRunnableCount ? ` (${selectedRunnableCount})` : ''}`
        : runScopeKind === 'from-node'
          ? '从此向后'
          : '运行到此'
  const runScopeOptions: ReadonlyArray<{
    kind: CanvasRunScope['kind']
    label: string
    description: string
    disabled: boolean
  }> = [
    { kind: 'all', label: '运行全部', description: '执行当前工作流中的全部可运行节点', disabled: nodes.length === 0 },
    { kind: 'dirty', label: `仅运行变更 (${dirtyNodeIds.size})`, description: '重新执行输入或结果发生变化的链路', disabled: dirtyNodeIds.size === 0 },
    { kind: 'selection', label: `运行选中链路 (${selectedRunnableCount})`, description: '执行选中节点及其上游依赖', disabled: selectedRunnableCount === 0 },
    { kind: 'to-node', label: '运行到选中节点', description: '需要且只能选择一个可运行节点', disabled: selectedRunnableCount !== 1 },
    { kind: 'from-node', label: '从选中节点向后运行', description: '执行下游链路并补齐必要依赖', disabled: selectedRunnableCount !== 1 },
  ]
  const activeRunOption = runScopeOptions.find((option) => option.kind === runScopeKind) ?? runScopeOptions[0]

  const currentRunScope = useCallback((): CanvasRunScope => {
    const runnableIds = new Set(nodes.filter(isCanvasRunnableTarget).map((node) => node.id))
    if (runScopeKind === 'all') return { kind: 'all' }
    if (runScopeKind === 'dirty') {
      const nodeIds = nodes.map((node) => node.id).filter((id) => runnableIds.has(id) && dirtyNodeIds.has(id))
      if (nodeIds.length === 0) throw new Error('当前没有需要重新运行的节点')
      return { kind: 'dirty', nodeIds }
    }
    if (runScopeKind === 'selection') {
      const nodeIds = selectedNodeIds.filter((id) => runnableIds.has(id))
      if (nodeIds.length === 0) throw new Error('请先选择可运行的节点')
      return { kind: 'selection', nodeIds }
    }
    const nodeIds = selectedNodeIds.filter((id) => runnableIds.has(id))
    if (nodeIds.length !== 1) throw new Error('该运行范围需要且只能选择一个可运行节点')
    return { kind: runScopeKind === 'from-node' ? 'from-node' : 'to-node', nodeId: nodeIds[0] }
  }, [runScopeKind, nodes, dirtyNodeIds, selectedNodeIds])

  const saveBeforeRunRef = useRef<(graph: CanvasRunGraph) => Promise<void>>(async () => {})
  const inspectPendingAgentExecution = useCallback((pending: NonNullable<typeof pendingCanvasRun>): CanvasAgentExecutionOrigin | undefined => {
    const captured = pending.agentExecution
    if (!captured) return undefined
    if (!agentScope?.active() || captured.scopeKey !== currentWorkshopSetupScope() || !projectCanRunRef.current || projectTransitionRef.current || saveConflictRef.current || draftRecoveryPendingRef.current) throw new Error('Agent 的账号、工程或访问权限已变化，请回到原需求重新检查运行')
    const current = getGraphSnapshot()
    if (pending.scope.kind !== 'selection' || !pending.scope.nodeIds.length || pending.scope.nodeIds.some((id) => !current.nodes.some((node) => node.id === id && isCanvasRunnableTarget(node)))) throw new Error('原提案的运行节点已删除、停用或发生变化，请重新检查当前画布')
    return { ...captured.origin }
  }, [agentScope, currentWorkshopSetupScope, getGraphSnapshot])
  const confirmCanvasRun = useCallback(async () => {
    if (!projectCanRunRef.current) { setPendingCanvasRun(null); setRunPreflight(null); setBanner('项目运行权限已变化，未提交执行'); return }
    const pending = pendingCanvasRun
    if (!pending) return
    if (projectTransitionRef.current || startingRunsRef.current > 0) return
    let submitting = false
    let outputToken: OutputImagePlacementToken | null = null
    try {
      inspectPendingAgentExecution(pending)
      if (pending.outputPlacement && pending.outputPlacement.editorScope !== outputPlacementAdapterRef.current?.scope()) {
        setPendingCanvasRun(null); setRunPreflight(null); setBanner('工程会话已变化，请重新选择处理并放置'); return
      }
      const currentGraph = toCanvasRunGraph(nodes, edges, { image: imageGroup ?? '', video: videoGroup ?? '', videoProtocol, text: textGroup ?? '', imageModel: mediaGroups.imageModel, videoModel: mediaGroups.videoModel, textModel: mediaGroups.textModel }, nodeSourceCatalogRef.current)
      const currentPreflight = buildCanvasRunPreflight({ capabilities: canvasCapabilities(), sourceCatalog: nodeSourceCatalogRef.current,
        imageAssetDimensions,
        graph: currentGraph,
        scope: pending.scope,
        cachedNodeIds: cachedNodeIdsForPreflight(nodes, pending.scope),
        imageGroup: imageGroup ?? undefined,
        videoGroup: videoGroup ?? undefined,
        videoProtocol,
        imageModels: mediaModelsRef.current.image,
        videoModels: mediaModelsRef.current.video,
        textGroup: textGroup ?? undefined,
        textModels: mediaModelsRef.current.text,
        nodeBlockReasons: dramaPreflightBlockReasons(nodes, edges),
      })
      if (rejectPendingMedia(currentPreflight) || rejectUnavailableGroups(currentPreflight)) { setPendingCanvasRun(null); setRunPreflight(null); return }
      if (!sameCanvasRunGraphSnapshot(pending.graph, currentGraph)) {
        setRunPreflight(currentPreflight)
        setPendingCanvasRun(currentPreflight.canStart ? { ...pending, graph: currentGraph } : null)
        setBanner(currentPreflight.canStart
          ? '工作流在确认期间发生变化，请核对新的运行范围后再次确认'
          : '工作流在确认期间发生变化，请先修复新的阻塞项')
        return
      }
      if (!currentPreflight.canStart) {
        setRunPreflight(currentPreflight)
        setPendingCanvasRun(null)
        setBanner('当前运行范围出现新的阻塞项，请先修复后重新运行')
        return
      }
      if (pending.outputPlacement) {
        outputToken = outputPlacementCoordinator.begin(pending.outputPlacement.nodeId, 'current', currentGraph)
        if (!outputToken) return
      }
      setRunPreflight(null)
      setPendingCanvasRun(null)
      submitting = true
      startingRunsRef.current += 1
      setStartingRuns(startingRunsRef.current)
      await saveBeforeRunRef.current(currentGraph)
      if (!projectCanRunRef.current) throw new Error('项目权限已变化，尚未开始运行')
      const agentExecution = inspectPendingAgentExecution(pending)
      const started = await hostBridge().startRun(canvasRunInputForHost({ graph: currentGraph, scope: pending.scope, ...(agentExecution ? { agentExecution } : {}) }, canvasCapabilities()))
      if (agentExecution) inspectPendingAgentExecution(pending)
      if (outputToken) outputPlacementCoordinator.attach(outputToken, started)
      rememberActiveRun({ ...started, projectId: activeProjectIdRef.current ?? undefined, scope: pending.scope, graph: currentGraph })
      if (!agentExecution) openInspectorTab('runs')
      setBanner(agentExecution ? '已关联到 Agent 原需求，可在原消息查看这次运行和候选结果' : activeRunsRef.current.size > 1 ? `已开始第 ${activeRunsRef.current.size} 路生成` : '工作流已交由安全运行服务')
      // 缓存命中的工作流可能在 startRun IPC 返回前已发出终态事件。
      // 立即读取持久记录可补回该事件，避免运行按钮永久停在“取消”。
      void refreshRuns(started.runId)
    } catch (error) {
      if (outputToken) outputPlacementCoordinator.cancel(outputToken)
      if (pending.agentExecution && (!agentMountedRef.current || pending.agentExecution.scopeKey !== currentWorkshopSetupScope())) return
      if (pending.agentExecution) { setRunPreflight(null); setPendingCanvasRun(null) }
      setBanner(error instanceof Error ? error.message : String(error))
    } finally {
      if (pending.agentExecution && submitting && agentMountedRef.current && pending.agentExecution.scopeKey === currentWorkshopSetupScope()) setAgentExecutionRefreshKey((value) => value + 1)
      if (submitting) {
        startingRunsRef.current -= 1
        setStartingRuns(startingRunsRef.current)
      }
    }
  }, [imageAssetDimensions, edges, imageGroup, nodes, openInspectorTab, pendingCanvasRun, refreshRuns, rememberActiveRun, videoGroup, textGroup, mediaGroups.imageModel, mediaGroups.videoModel, mediaGroups.textModel, rejectPendingMedia, rejectUnavailableGroups, outputPlacementCoordinator, inspectPendingAgentExecution, currentWorkshopSetupScope])

  const run = async (requestedScope?: CanvasRunScope, agentExecution?: NonNullable<typeof pendingCanvasRun>['agentExecution']) => {
    if (!projectCanRunRef.current) { setBanner('协作项目当前仅支持查看、编辑与导出；共享执行及本人模型来源接入尚未开放'); return }
    if (projectTransitionRef.current || startingRunsRef.current > 0) {
      setBanner('正在保存工程或提交任务，请稍候再运行')
      return
    }
    if (resumingTaskIdsRef.current.size > 0) {
      setBanner('请等待视频任务续查完成后再运行工作流')
      return
    }
    setBanner(null)
    if (window.xingmangCanvasHost) {
      try {
        const graph = toCanvasRunGraph(nodes, edges, { image: imageGroup ?? '', video: videoGroup ?? '', videoProtocol, text: textGroup ?? '', imageModel: mediaGroups.imageModel, videoModel: mediaGroups.videoModel, textModel: mediaGroups.textModel }, nodeSourceCatalogRef.current)
        const scope = requestedScope ?? currentRunScope()
        const preflight = buildCanvasRunPreflight({ capabilities: canvasCapabilities(), sourceCatalog: nodeSourceCatalogRef.current,
          imageAssetDimensions,
          graph,
          scope,
          cachedNodeIds: cachedNodeIdsForPreflight(nodes, scope),
          imageGroup: imageGroup ?? undefined,
          videoGroup: videoGroup ?? undefined,
          videoProtocol,
          imageModels: mediaModelsRef.current.image,
          videoModels: mediaModelsRef.current.video,
          textGroup: textGroup ?? undefined,
          textModels: mediaModelsRef.current.text,
          nodeBlockReasons: dramaPreflightBlockReasons(nodes, edges),
        })
        if (rejectPendingMedia(preflight) || rejectUnavailableGroups(preflight)) return
        setRunPreflight(preflight)
        if (!preflight.canStart) {
          setBanner(preflight.warnings.filter((entry) => entry.includes('：')).join('；') || '当前运行范围无法执行')
          return
        }
        const pending = { graph, scope, ...(agentExecution ? { agentExecution } : {}) }
        inspectPendingAgentExecution(pending)
        setPendingCanvasRun(pending)
        setBanner('请确认运行范围和本次额度风险')
        return
      } catch (error) {
        setBanner(error instanceof Error ? error.message : String(error))
        return
      }
    }
    if (running) return
    setRunning(true)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const outcome = await runWorkflow(
        nodes.map(toWorkflowNode),
        edges.map(toWorkflowEdge),
        buildExecutors(),
        { onNodeUpdate: patchNodeData },
        controller.signal,
      )
      setBanner(`运行结束:成功 ${outcome.succeeded.length} / 失败 ${outcome.failed.length} / 跳过 ${outcome.skipped.length}`)
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
    } finally {
      abortRef.current = null
      setRunning(false)
    }
  }

  const readWorkshopSetup = useCallback((): { setup: WorkshopSetup; graph: CanvasRunGraph | null } | null => {
    const session = workshopSetupSessionRef.current
    if (!session || session.scopeKey !== currentWorkshopSetupScope() || !agentMountedRef.current || !draftActionsEnabledRef.current || projectTransitionRef.current) return null
    try {
      const current = getGraphSnapshot(), configuration = confirmedRunGroups()
      const graph = toCanvasRunGraph(current.nodes, current.edges, configuration, nodeSourceCatalogRef.current)
      // Reuse this account's already loaded catalog. Opening the checklist must
      // not refetch account state or perform a per-node network scan.
      const assetStates: Record<string, WorkshopSetupAssetState> = {}
      for (const asset of assetCatalog) assetStates[asset.assetId] = { state: 'available' }
      Object.assign(assetStates, workshopSetupAssets)
      const scope: CanvasRunScope = session.scope.kind === 'all' ? { kind: 'all' } : { kind: 'selection', nodeIds: [...session.scope.nodeIds] }
      const setup = buildWorkshopSetup({ nodes: current.nodes.map(toWorkflowNode), graph, scope: session.scope, assetStates,
        configuration: { capabilities: canvasCapabilities(), imageAssetDimensions, cachedNodeIds: cachedNodeIdsForPreflight(current.nodes, scope), imageGroup: configuration.image, videoGroup: configuration.video, videoProtocol: configuration.videoProtocol, textGroup: configuration.text,
          sourceCatalog: nodeSourceCatalogRef.current, imageModels: mediaModelsRef.current.image, videoModels: mediaModelsRef.current.video, textModels: mediaModelsRef.current.text, nodeBlockReasons: dramaPreflightBlockReasons(current.nodes, current.edges) } })
      return { setup, graph }
    } catch (error) {
      // Imported node recipes can be invalid. A preparation panel must never
      // turn that recoverable document issue into a canvas render failure.
      return { graph: null, setup: { scope: session.scope,
        scopeLabel: session.scope.kind === 'all' ? '整张画布' : session.scope.kind === 'inserted' ? '本次插入' : '当前选区',
        scopeNodeIds: [], nodeIds: [], missingNodeIds: [], items: [], blockingCount: 0, noticeCount: 0,
        readyNodeCount: 0, skippedNodeCount: 0, canReviewRun: false,
        error: error instanceof Error ? error.message : '当前画布参数暂时无法检查，请检查节点配置后重试' } }
    }
  }, [getGraphSnapshot, confirmedRunGroups, currentWorkshopSetupScope, assetCatalog, workshopSetupAssets, imageAssetDimensions])
  const workshopSetup = useMemo(() => workshopSetupOpen && workshopSetupSession?.scopeKey === layerEditorScope ? readWorkshopSetup()?.setup ?? null : null,
    [readWorkshopSetup, workshopSetupOpen, workshopSetupSession, layerEditorScope, nodes, edges, mediaGroups, imageModels, videoModels, textModels, projectTransition])
  const inspectWorkshopModelMapping = useCallback(() => {
    const session = workshopModelMappingSessionRef.current
    if (!session || session.scopeKey !== currentWorkshopSetupScope() || workshopSetupSessionRef.current !== session.setupSession || !agentMountedRef.current || !draftActionsEnabledRef.current || !projectCanEditRef.current || !projectCanRunRef.current || projectTransitionRef.current || draftRecoveryPendingRef.current || saveConflictRef.current) throw new Error('工程、准备范围或编辑权限已变化，请重新打开批量配置')
    if (activeRunsRef.current.size || startingRunsRef.current || pendingRunProjectionIdsRef.current.size || resumingTaskIdsRef.current.size) throw new Error('请先完成当前任务和结果回填，再批量配置模型')
    const current = getGraphSnapshot()
    if (workshopModelMappingGraphSignature(current.nodes, current.edges) !== session.graphSignature) throw new Error('画布内容已变化，未应用任何模型修改；请重新打开批量配置')
    if (session.sourceSignature && workshopModelMappingSourceSignature(groupsRef.current) !== session.sourceSignature) throw new Error('模型来源目录已变化，未应用修改；请重新打开后核对')
    return { session, current }
  }, [currentWorkshopSetupScope, getGraphSnapshot])
  const closeWorkshopModelMapping = useCallback(() => {
    workshopModelMappingRevisionRef.current++; workshopModelMappingSessionRef.current = null; setWorkshopModelMappingSession(null)
    workshopModelMappingBusyRef.current = false; setWorkshopModelMappingBusy(false)
    workshopModelMappingCatalogRef.current = {}; setWorkshopModelMappingCatalog({})
    workshopModelMappingReviewRef.current = null; setWorkshopModelMappingReview(null)
    if (workshopSetupSessionRef.current?.scopeKey === currentWorkshopSetupScope()) setWorkshopSetupOpen(true)
  }, [currentWorkshopSetupScope])
  const openWorkshopModelMapping = useCallback(async () => {
    if (workshopModelMappingBusyRef.current) return
    const setupSession = workshopSetupSessionRef.current, ready = readWorkshopSetup()
    if (!setupSession || !ready || !projectCanEditRef.current || !projectCanRunRef.current || !draftActionsEnabledRef.current || projectTransitionRef.current || draftRecoveryPendingRef.current || saveConflictRef.current) { setWorkshopSetupError('请在拥有运行与编辑权限的工程中配置模型'); return }
    if (activeRunsRef.current.size || startingRunsRef.current || pendingRunProjectionIdsRef.current.size || resumingTaskIdsRef.current.size) { setWorkshopSetupError('请先完成当前任务和结果回填，再批量配置模型'); return }
    const current = getGraphSnapshot(), token = ++workshopModelMappingRevisionRef.current
    const session = { token, scopeKey: setupSession.scopeKey, setupSession, nodeIds: [...ready.setup.scopeNodeIds], graphSignature: workshopModelMappingGraphSignature(current.nodes, current.edges), sourceSignature: '', groups: [] as CanvasGroupSummary[] }
    workshopModelMappingSessionRef.current = session; setWorkshopModelMappingSession(session)
    workshopModelMappingCatalogRef.current = {}; setWorkshopModelMappingCatalog({})
    workshopModelMappingChoicesRef.current = []; setWorkshopModelMappingChoices([])
    workshopModelMappingReviewRef.current = null; setWorkshopModelMappingReview(null)
    workshopModelMappingBusyRef.current = true; setWorkshopModelMappingBusy(true); setWorkshopModelMappingError(undefined); setWorkshopSetupOpen(false)
    function active() {
      if (workshopModelMappingSessionRef.current?.token !== token) return false
      try { inspectWorkshopModelMapping(); return true } catch { return false }
    }
    try {
      const listed = await readGroupCatalog()
      if (!active()) throw new Error('工程或范围已变化，本次没有修改节点')
      const preparedSession = { ...session, groups: [...listed], sourceSignature: workshopModelMappingSourceSignature(listed) }
      workshopModelMappingSessionRef.current = preparedSession; setWorkshopModelMappingSession(preparedSession)
      // Read saved catalogs once per source, using the existing bounded helper.
      // This neither probes provider APIs nor submits any generation request.
      await prepareCanvasNodeSources({ names: listed.map((source) => source.name), groups: listed, prepare: (name) => hostBridge().prepareGroup(name), isCurrent: active,
        onChange(catalog) { if (active()) { workshopModelMappingCatalogRef.current = catalog; setWorkshopModelMappingCatalog(catalog) } } })
      if (!active()) throw new Error('画布或模型目录已变化，请重新打开批量配置')
      const failed = Object.values(workshopModelMappingCatalogRef.current).filter((source) => source.state === 'error').length
      if (failed) setWorkshopModelMappingError(`${failed} 个来源未能读取已保存的模型目录。可选择其他可用来源，或返回账户设置核对后重试。`)
    } catch (cause) {
      if (workshopModelMappingSessionRef.current?.token === token) setWorkshopModelMappingError(cause instanceof Error ? cause.message : '模型目录读取失败，请返回后重试')
    } finally {
      if (workshopModelMappingSessionRef.current?.token === token) { workshopModelMappingBusyRef.current = false; setWorkshopModelMappingBusy(false) }
    }
  }, [readWorkshopSetup, getGraphSnapshot, readGroupCatalog, inspectWorkshopModelMapping])
  const workshopModelMapping = useMemo(() => {
    if (!workshopModelMappingSession || workshopModelMappingSession.scopeKey !== layerEditorScope) return { rows: [], sources: [] }
    try { return buildWorkshopModelMapping({ nodes: workshopModelMappingNodes(nodes), nodeIds: workshopModelMappingSession.nodeIds, groups: workshopModelMappingSession.groups, catalog: workshopModelMappingCatalog }) }
    catch { return { rows: [], sources: [] } }
  }, [workshopModelMappingSession, workshopModelMappingCatalog, nodes, layerEditorScope])
  const workshopModelMappingChangedCount = useMemo(() => {
    if (!workshopModelMappingSession) return 0
    try { return planWorkshopModelMapping({ nodes: workshopModelMappingNodes(nodes), nodeIds: workshopModelMappingSession.nodeIds, groups: workshopModelMappingSession.groups, catalog: workshopModelMappingCatalog, choices: workshopModelMappingChoices }).changedNodeIds.length }
    catch { return 0 }
  }, [workshopModelMappingSession, workshopModelMappingCatalog, workshopModelMappingChoices, nodes])
  const changeWorkshopModelMapping = useCallback((choices: WorkshopModelMappingChoice[]) => {
    if (workshopModelMappingBusyRef.current) return
    workshopModelMappingChoicesRef.current = choices.map((choice) => ({ ...choice })); setWorkshopModelMappingChoices(workshopModelMappingChoicesRef.current)
    workshopModelMappingReviewRef.current = null; setWorkshopModelMappingReview(null); setWorkshopModelMappingError(undefined)
  }, [])
  const reviewWorkshopModelMapping = useCallback(() => {
    if (workshopModelMappingBusyRef.current) return
    try {
      const { session, current } = inspectWorkshopModelMapping(), choices = workshopModelMappingChoicesRef.current
      const plan = planWorkshopModelMapping({ nodes: workshopModelMappingNodes(current.nodes), nodeIds: session.nodeIds, groups: session.groups, catalog: workshopModelMappingCatalogRef.current, choices })
      if (!plan.changedNodeIds.length) throw new Error('所选来源和模型与原配置相同，没有需要应用的修改')
      const changes = new Map(plan.changes.map((change) => [change.nodeId, change]))
      const projected = current.nodes.map((node) => { const change = changes.get(node.id); return change ? { ...node, data: { ...node.data, group: change.group, model: change.model } } : node })
      const configuration = confirmedRunGroups(), graph = toCanvasRunGraph(projected, current.edges, configuration, workshopModelMappingCatalogRef.current)
      const scope: CanvasRunScope = session.setupSession.scope.kind === 'all' ? { kind: 'all' } : { kind: 'selection', nodeIds: session.nodeIds.filter((id) => graph.nodes.some((node) => node.id === id)) }
      const preflight = buildCanvasRunPreflight({ capabilities: canvasCapabilities(), graph, scope, sourceCatalog: workshopModelMappingCatalogRef.current, imageGroup: configuration.image, videoGroup: configuration.video, videoProtocol: configuration.videoProtocol, textGroup: configuration.text, imageModels: mediaModelsRef.current.image, videoModels: mediaModelsRef.current.video, textModels: mediaModelsRef.current.text, imageAssetDimensions, nodeBlockReasons: dramaPreflightBlockReasons(projected, current.edges) })
      const issues = preflight.items.filter((item) => item.action === 'blocked').map((item) => ({ nodeId: item.nodeId, message: `${projected.find((node) => node.id === item.nodeId)?.data.settings?.title || item.nodeId}：${item.reason || '仍需准备此节点'}`, blocking: false }))
      const review = { choicesSignature: JSON.stringify(choices), issues }
      workshopModelMappingReviewRef.current = review; setWorkshopModelMappingReview(review); setWorkshopModelMappingError(undefined)
    } catch (cause) { setWorkshopModelMappingError(cause instanceof Error ? cause.message : '无法核对模型修改，请重新选择') }
  }, [inspectWorkshopModelMapping, confirmedRunGroups, imageAssetDimensions])
  const applyWorkshopModelMapping = useCallback(async () => {
    if (workshopModelMappingBusyRef.current) return
    const review = workshopModelMappingReviewRef.current, token = workshopModelMappingSessionRef.current?.token
    if (!review || review.choicesSignature !== JSON.stringify(workshopModelMappingChoicesRef.current)) { setWorkshopModelMappingError('请先预览当前模型修改，再明确应用'); return }
    workshopModelMappingBusyRef.current = true; setWorkshopModelMappingBusy(true); setWorkshopModelMappingError(undefined)
    function active() { if (workshopModelMappingSessionRef.current?.token !== token) return false; try { inspectWorkshopModelMapping(); return true } catch { return false } }
    try {
      inspectWorkshopModelMapping()
      const bridge = hostBridge()
      await bridge.refreshProjectAccess?.()
      const access = bridge.getProjectAccess?.()
      if (!active() || access?.denied || access?.access?.canEdit === false || access?.access?.canRun === false || access && access.projectId !== activeProjectIdRef.current) throw new Error('工程或模型配置权限已变化，本次没有应用修改')
      const listed = await readGroupCatalog(true)
      const { session } = inspectWorkshopModelMapping()
      if (session.token !== token || workshopModelMappingSourceSignature(listed) !== session.sourceSignature) throw new Error('模型来源已变化，请返回后重新核对；原画布保持不变')
      const choices = workshopModelMappingChoicesRef.current.map((choice) => ({ ...choice })), catalog = workshopModelMappingCatalogRef.current
      let checked: CanvasNodeSourceCatalog = {}
      await prepareCanvasNodeSources({ names: [...new Set(choices.map((choice) => choice.group))], groups: listed, prepare: (name) => bridge.prepareGroup(name), isCurrent: active, onChange(next) { checked = next } })
      if (!active() || review !== workshopModelMappingReviewRef.current || review.choicesSignature !== JSON.stringify(workshopModelMappingChoicesRef.current)) throw new Error('模型修改范围已变化，本次没有应用')
      for (const group of new Set(choices.map((choice) => choice.group))) if (checked[group]?.state !== 'ready' || JSON.stringify(checked[group]) !== JSON.stringify(catalog[group])) throw new Error('所选模型目录已变化，请重新打开后选择；原画布保持不变')
      const latest = inspectWorkshopModelMapping()
      const plan = planWorkshopModelMapping({ nodes: workshopModelMappingNodes(latest.current.nodes), nodeIds: session.nodeIds, groups: listed, catalog: { ...catalog, ...checked }, choices })
      if (!plan.changedNodeIds.length) throw new Error('没有需要应用的模型修改')
      let updated = latest.current.nodes
      const dirty = new Set<string>()
      for (const change of plan.changes) {
        updated = markNodeAndDescendantsDirty(updated, latest.current.edges, change.nodeId, { group: change.group, model: change.model })
        dirty.add(change.nodeId); for (const id of downstreamNodeIds([change.nodeId], latest.current.edges)) dirty.add(id)
      }
      graphRef.current = { nodes: updated, edges: latest.current.edges }
      execute({ type: 'replace-nodes', nodes: updated.map(canvasNodeDocumentRecord) })
      setDirtyNodeIds((current) => new Set([...current, ...dirty]))
      closeWorkshopModelMapping()
      setBanner(`已批量更新 ${plan.changedNodeIds.length} 个节点的来源与模型，可一次撤销。原参数和旧结果保留，请按准备清单核对后运行。`)
    } catch (cause) {
      if (workshopModelMappingSessionRef.current?.token === token) setWorkshopModelMappingError(cause instanceof Error ? cause.message : '模型修改未应用，请核对后重试')
    } finally { if (workshopModelMappingSessionRef.current?.token === token) { workshopModelMappingBusyRef.current = false; setWorkshopModelMappingBusy(false) } }
  }, [inspectWorkshopModelMapping, readGroupCatalog, execute, closeWorkshopModelMapping])
  const closeWorkshopSetup = useCallback(() => {
    workshopSetupActionRevisionRef.current++; workshopSetupActionBusyRef.current = false
    workshopSetupAssetCheckRef.current?.abort(); workshopSetupAssetCheckRef.current = null
    setWorkshopSetupOpen(false); setWorkshopSetupBusy(false); setWorkshopSetupError(undefined)
  }, [])
  const changeWorkshopSetupScope = useCallback((kind: WorkshopSetupScope['kind']) => {
    const session = workshopSetupSessionRef.current
    if (!session || session.scopeKey !== currentWorkshopSetupScope()) return
    if (kind === 'all') openWorkshopSetup({ kind: 'all' })
    else if (kind === 'inserted' && session.insertedNodeIds) openWorkshopSetup({ kind: 'inserted', nodeIds: session.insertedNodeIds })
    else if (kind === 'selection') openWorkshopSetup({ kind: 'selection', nodeIds: getGraphSnapshot().nodes.filter((node) => node.selected).map((node) => node.id) })
  }, [currentWorkshopSetupScope, getGraphSnapshot, openWorkshopSetup])
  const locateWorkshopSetupNode = useCallback((nodeId: string) => {
    const current = readWorkshopSetup()
    if (!current || ![...current.setup.nodeIds, ...current.setup.scopeNodeIds].includes(nodeId) || !getGraphSnapshot().nodes.some((node) => node.id === nodeId)) return
    closeWorkshopSetup(); setAgentOpen(false); locateNode(nodeId)
  }, [readWorkshopSetup, getGraphSnapshot, closeWorkshopSetup, locateNode])
  const actOnWorkshopSetup = useCallback(async (item: WorkshopSetupItem, fromLibrary = false) => {
    const session = workshopSetupSessionRef.current, revision = workshopSetupActionRevisionRef.current
    if (!session || workshopSetupActionBusyRef.current) return
    const initial = getGraphSnapshot().nodes.find((node) => node.id === item.nodeId)
    const originalAssetId = initial?.data.result?.assetId
    const changesDocument = ['pick-asset', 'edit-prompt', 'configure-model'].includes(item.action)
    function current(): boolean {
      if (workshopSetupSessionRef.current !== session || workshopSetupActionRevisionRef.current !== revision || session!.scopeKey !== currentWorkshopSetupScope() || !agentMountedRef.current || !draftActionsEnabledRef.current || projectTransitionRef.current) return false
      if (changesDocument && (!projectCanEditRef.current || draftRecoveryPendingRef.current || saveConflictRef.current || activeRunsRef.current.size || startingRunsRef.current || pendingRunProjectionIdsRef.current.size || resumingTaskIdsRef.current.size)) return false
      const latest = getGraphSnapshot(), target = latest.nodes.find((node) => node.id === item.nodeId)
      if (!target || target.type !== initial?.type || target.data.result?.assetId !== originalAssetId) return false
      const seen = new Set<string>(); let ancestor: CanvasNode | undefined = target
      while (ancestor) {
        if (seen.has(ancestor.id) || changesDocument && (ancestor.draggable === false || ancestor.disabled || ancestor.data.__canvasLocked || ancestor.data.__canvasDisabled || ancestor.data.status === 'running' || ancestor.data.status === 'queued')) return false
        seen.add(ancestor.id); ancestor = ancestor.parentId ? latest.nodes.find((node) => node.id === ancestor!.parentId) : undefined
      }
      return true
    }
    const liveItem = readWorkshopSetup()?.setup.items.find((candidate) => candidate.id === item.id && candidate.nodeId === item.nodeId && candidate.action === item.action && candidate.assetId === item.assetId && candidate.mediaType === item.mediaType)
    if (!current() || !liveItem) { setWorkshopSetupError('节点、素材或编辑权限已变化，请按最新清单继续'); return }
    setWorkshopSetupError(undefined)
    if (item.action === 'configure-model') {
      if (!projectCanRunRef.current) { setWorkshopSetupError('共享项目暂未开放本人模型来源接入，请由项目拥有者配置'); return }
      closeWorkshopSetup(); setMediaConfigOpen(true); setRunMenuOpen(false); setMoreActionsOpen(false); return
    }
    if (item.action === 'edit-prompt' || item.action === 'inspect-node') { locateWorkshopSetupNode(item.nodeId); return }
    if (item.action === 'pick-asset') {
      if (fromLibrary) {
        const mediaType = initial?.type === 'image-input' ? 'image' : initial?.type === 'video-input' ? 'video' : initial?.type === 'audio-input' ? 'audio' : null
        if (!mediaType || mediaType !== liveItem.mediaType) { setWorkshopSetupError('素材类型与当前节点不匹配，请按最新清单选择'); return }
        const picker: NonNullable<typeof workshopAssetPicker> = { scopeKey: session.scopeKey, nodeId: item.nodeId, title: item.nodeTitle, mediaType, current }
        workshopAssetPickerRef.current = picker; setWorkshopAssetPicker(picker); setWorkshopSetupOpen(false)
        return
      }
      workshopSetupActionBusyRef.current = true; setWorkshopSetupBusy(true)
      try { await pickAssetForNode(item.nodeId, current) }
      finally { if (workshopSetupSessionRef.current === session && workshopSetupActionRevisionRef.current === revision) { workshopSetupActionBusyRef.current = false; setWorkshopSetupBusy(false) } }
      return
    }
    if (!item.assetId || !hostBridge().getAssetDetail) { setWorkshopSetupError('当前宿主暂不支持素材核对，运行时会再次确认可读性'); return }
    const controller = new AbortController(); workshopSetupAssetCheckRef.current = controller; workshopSetupActionBusyRef.current = true; setWorkshopSetupBusy(true)
    setWorkshopSetupAssets((previous) => ({ ...previous, [item.assetId!]: { state: 'checking' } }))
    try {
      const asset = await hostBridge().getAssetDetail!(item.assetId, controller.signal)
      if (!current() || controller.signal.aborted) return
      const available = asset?.assetId === item.assetId && (!item.mediaType || asset.mediaType === item.mediaType)
      setWorkshopSetupAssets((previous) => ({ ...previous, [item.assetId!]: available ? { state: 'available' } : { state: 'missing', message: '当前账号已无法读取这个素材，请重新选择' } }))
    } catch (error) {
      if (current() && !controller.signal.aborted) setWorkshopSetupAssets((previous) => ({ ...previous, [item.assetId!]: { state: 'failed', message: error instanceof Error ? error.message : '素材暂时无法核对，请稍后重试' } }))
    } finally { if (workshopSetupAssetCheckRef.current === controller) { workshopSetupAssetCheckRef.current = null; workshopSetupActionBusyRef.current = false; setWorkshopSetupBusy(false)
      setWorkshopSetupAssets((previous) => previous[item.assetId!]?.state === 'checking' ? Object.fromEntries(Object.entries(previous).filter(([id]) => id !== item.assetId)) : previous)
    } }
  }, [currentWorkshopSetupScope, getGraphSnapshot, readWorkshopSetup, closeWorkshopSetup, locateWorkshopSetupNode, pickAssetForNode])
  const closeWorkshopAssetPicker = useCallback(() => {
    workshopAssetPickerRef.current = null; setWorkshopAssetPicker(null)
    if (workshopSetupSessionRef.current?.scopeKey === currentWorkshopSetupScope()) setWorkshopSetupOpen(true)
  }, [currentWorkshopSetupScope])
  const chooseWorkshopAsset = useCallback(async (asset: CanvasAssetSummary) => {
    const picker = workshopAssetPickerRef.current
    if (!picker || !picker.current()) throw new Error('节点、账号或权限已变化，请重新打开准备清单')
    if (!isWorkshopLibraryAsset(asset, picker.mediaType)) throw new Error('素材类型或信息不匹配，请重新选择当前类型的本人素材')
    const bridge = hostBridge()
    if (!bridge.getAssetDetail) throw new Error('当前宿主不支持核对素材，请更新后重试')
    function assertCurrentProjectAccess() {
      if (!bridge.getProjectAccess) return
      const snapshot = bridge.getProjectAccess(), projectId = activeProjectIdRef.current
      if (!snapshot || snapshot.projectId !== projectId || snapshot.denied || snapshot.access?.projectId !== projectId || snapshot.access.canEdit !== true) throw new Error('工程或编辑权限已变化，本次没有绑定素材')
    }
    await bridge.refreshProjectAccess?.()
    if (workshopAssetPickerRef.current !== picker || !picker.current()) throw new Error('工程或编辑权限已变化，本次没有绑定素材')
    assertCurrentProjectAccess()
    const confirmed = await bridge.getAssetDetail(asset.assetId)
    if (workshopAssetPickerRef.current !== picker || !picker.current()) throw new Error('素材选择范围已变化；本人副本仍在素材库')
    assertCurrentProjectAccess()
    if (!isWorkshopLibraryAsset(confirmed, picker.mediaType) || confirmed.assetId !== asset.assetId) throw new Error('素材已回收、类型不匹配或不可读取，请重新选择')
    const current = getGraphSnapshot(), binding = buildCanvasMediaAssetBinding(current.nodes, current.edges, picker.nodeId, confirmed)
    if (binding.status !== 'bound') throw new Error('目标节点或素材类型已变化，本次没有绑定素材')
    const records = binding.nodes.map(canvasNodeDocumentRecord)
    execute({ type: 'replace-nodes', nodes: records })
    // Compare the same canonical projection on both sides: the renderer
    // intentionally omits defaults such as dirty:false. A refused command
    // must never be bypassed by a runtime-only graph update.
    const committed = getGraphSnapshot()
    const expectedRecords = records.map((record) => canvasNodeDocumentRecord(editorNodeToCanvasNode(record)))
    if (JSON.stringify(committed.nodes.map(canvasNodeDocumentRecord)) !== JSON.stringify(expectedRecords) || JSON.stringify(committed.edges.map(toWorkflowEdge)) !== JSON.stringify(current.edges.map(toWorkflowEdge))) throw new Error('素材尚未绑定到节点，请重试；原画布保持不变')
    graphRef.current = committed
    setDirtyNodeIds((previous) => new Set([...previous].filter((id) => id !== picker.nodeId).concat(binding.downstreamNodeIds)))
    setAssetCatalog((previous) => [...previous.filter((item) => item.assetId !== confirmed.assetId), confirmed])
    setWorkshopSetupAssets((previous) => ({ ...previous, [confirmed.assetId]: { state: 'available' } }))
    void markCanvasAssetUsed(confirmed.assetId)
    setBanner('素材已从素材库绑定；可一次撤销，下游节点等待重新运行')
    closeWorkshopAssetPicker()
  }, [getGraphSnapshot, execute, markCanvasAssetUsed, closeWorkshopAssetPicker])
  const reviewWorkshopSetupRun = useCallback(() => {
    if (!projectCanRunRef.current || !window.xingmangCanvasHost) { setWorkshopSetupError('当前工程暂不支持运行确认，请由项目拥有者在已连接的工作区运行'); return }
    if (projectTransitionRef.current || activeRunsRef.current.size || startingRunsRef.current || pendingRunProjectionIdsRef.current.size || resumingTaskIdsRef.current.size) { setWorkshopSetupError('请等待当前保存或任务完成，再检查运行'); return }
    const current = readWorkshopSetup(), preflight = current?.setup.preflight
    if (!current?.graph || !current.setup.canReviewRun || !preflight) { setWorkshopSetupError('准备条件已变化，请按最新清单补充后重试'); return }
    if (rejectPendingMedia(preflight) || rejectUnavailableGroups(preflight)) { closeWorkshopSetup(); return }
    closeWorkshopSetup(); setRunPreflight(preflight); setPendingCanvasRun({ graph: current.graph, scope: preflight.scope }); setBanner('请确认运行范围和本次额度风险')
  }, [readWorkshopSetup, rejectPendingMedia, rejectUnavailableGroups, closeWorkshopSetup])

  const cancel = () => {
    const runIds = [...activeRunsRef.current.keys()]
    if (runIds.length > 0) {
      for (const runId of runIds) {
        void hostBridge().cancelRun(runId).then((accepted) => {
          if (!accepted) setBanner('取消请求未被接受，请刷新运行历史确认状态')
        }).catch((error) => setBanner(`取消请求失败：${error instanceof Error ? error.message : String(error)}`))
      }
      return
    }
    abortRef.current?.abort()
  }

  const workflowSnapshot = (): WorkflowFile => ({
    ...createEmptyWorkflow(activeProject?.name ?? '画布工作流'),
    mediaGroups: { ...mediaGroups },
    nodes: nodes.map(toWorkflowNode),
    edges: edges.map(toWorkflowEdge),
    viewport: { ...viewport },
  })

  const workflowSerialization = useMemo(() => inspectCanvasWorkflowSnapshot(workflowSnapshot(), canvasCapabilities().project), [activeProject?.id, activeProject?.name, nodes, edges, viewport, mediaGroups])
  const serializationErrorRef = useRef<string | null>(null)
  const latestBrowserSnapshotRef = useRef<({ project: CanvasStoredProjectSummary } & CanvasWorkflowSnapshot) | null>(null)
  latestBrowserSnapshotRef.current = activeProject ? { project: activeProject, ...workflowSerialization } : null

  const collaboration = useProjectCollaboration({
    ownerId: creationOwnerId, projectId: activeProject?.id, scopeKey: collaborationScopeKey, shared: collaborationShared,
    enabled: storageMode === 'cloud' && draftActionsEnabled && !projectAccessState?.denied && Boolean(activeProject), client: window.xingmangCanvasHost?.projectCollaboration,
    controllerRef: collaborationRef,
    active: () => agentMountedRef.current && draftActionsEnabledRef.current && activeProjectIdRef.current === activeProject?.id && projectEpochRef.current === currentDraftProjectEpoch && !hostBridge().getProjectAccess?.()?.denied,
    getContent: () => {
      const project = latestBrowserSnapshotRef.current?.project
      if (!project || project.id !== activeProjectIdRef.current) throw new Error('当前协作工程尚未核对。')
      const graph = getGraphSnapshot()
      return serializeWorkflow({ ...createEmptyWorkflow(project.name), mediaGroups: { ...mediaGroupsRef.current }, nodes: graph.nodes.map(toWorkflowNode), edges: graph.edges.map(toWorkflowEdge), viewport: { ...currentReactFlowRef.current.getViewport() } })
    },
    selectedNodeIds: () => getGraphSnapshot().nodes.filter((node) => node.selected).map((node) => node.id),
    onState: (state) => {
      setCollaborationUi({ key: collaborationScopeKey, state })
      const access = hostBridge().getProjectAccess?.()
      const canEdit = draftActionsEnabledRef.current && !access?.denied && access?.access?.canEdit !== false && (collaborationRef.current?.canEdit() ?? false)
      projectCanEditRef.current = canEdit
      projectCanRunRef.current = canEdit && access?.access?.canRun !== false && state.phase !== 'busy'
    },
    onSnapshot: (snapshot, content, graphChanged) => {
      const workflow = parseWorkflowFile(content), confirmed = parseWorkflowFile(snapshot.content)
      if (!workflow || !confirmed) throw new Error('协作快照无法读取，当前图仍保留。')
      const localViewport = { ...currentReactFlowRef.current.getViewport() }
      const projected = serializeWorkflow({ ...workflow, viewport: localViewport })
      const actual = serializeWorkflow({ ...confirmed, viewport: localViewport })
      if (graphChanged) {
        cancelInsertionViewportFocus()
        createdNodeFocusRef.current?.cancel()
        documentController.applyRemoteDocument(workflowDocument(workflow))
        setDirtyNodeIds(dirtyCanvasNodeIds(workflow.nodes))
      }
      graphRef.current = getGraphSnapshot()
      lastConfirmedContentRef.current = actual
      draftBaseVersionRef.current = snapshot.project.version
      browserUnsavedRef.current = projected !== actual
      latestBrowserSnapshotRef.current = { project: snapshot.project, content: projected, errorMessage: null }
      setActiveProject(snapshot.project)
      setProjects((current) => [snapshot.project, ...current.filter((entry) => entry.id !== snapshot.projectId)])
      setAutoSaveState(projected !== actual ? 'pending' : 'saved')
    },
  })

  useLayoutEffect(() => {
    const snapshot = latestBrowserSnapshotRef.current
    if (!snapshot || draftRecoveryPendingRef.current || !projectPermissionCanEdit) return
    if (snapshot.content === null) {
      browserUnsavedRef.current = true
      autoSaveRevisionRef.current += 1
      serializationErrorRef.current = snapshot.errorMessage
      setAutoSaveState('failed')
      setBanner(canvasAutosaveErrorMessage(snapshot.errorMessage))
      return
    }
    const recoveredSerialization = serializationErrorRef.current !== null
    if (serializationErrorRef.current) {
      const previousError = canvasAutosaveErrorMessage(serializationErrorRef.current)
      serializationErrorRef.current = null
      setBanner((current) => current === previousError ? null : current)
    }
    if (!draftOwnerId || projectHydrationRef.current) return
    const dirty = canvasWorkflowSnapshotNeedsSave(snapshot, lastConfirmedContentRef.current)
    browserUnsavedRef.current = dirty || saveConflictRef.current
    if (recoveredSerialization && !dirty && !saveConflictRef.current) setAutoSaveState('saved')
    if (dirty) {
      persistBrowserDraft(snapshot.project, snapshot.content)
      if (!saveConflictRef.current) setAutoSaveState('pending')
    } else if (browserDraftRef.current?.projectId === snapshot.project.id) {
      try {
        clearCanvasBrowserDraft(window.localStorage, browserDraftRef.current)
        browserDraftRef.current = null
      } catch (error) { setDraftStorageError(error instanceof Error ? error.message : '本地草稿清理失败，已保留原草稿') }
    }
  }, [activeProject, draftOwnerId, workflowSerialization, persistBrowserDraft, draftRecovery, saveConflict, projectPermissionCanEdit])

  const previousProjectCanEditRef = useRef(projectPermissionCanEdit)
  useEffect(() => {
    const wasEditable = previousProjectCanEditRef.current
    previousProjectCanEditRef.current = projectPermissionCanEdit
    if (!wasEditable || projectPermissionCanEdit) return
    const snapshot = latestBrowserSnapshotRef.current
    if (snapshot?.content && canvasWorkflowSnapshotNeedsSave(snapshot, lastConfirmedContentRef.current)) {
      browserUnsavedRef.current = true
      persistBrowserDraft(snapshot.project, snapshot.content)
    }
    if (autosaveTimerRef.current !== null) { window.clearTimeout(autosaveTimerRef.current); autosaveTimerRef.current = null }
    setPendingCanvasRun(null); setRunPreflight(null); setQuickInsert(null); setAssetTrayOpen(false); setAgentOpen(false)
  }, [projectPermissionCanEdit, persistBrowserDraft])

  useEffect(() => {
    if (!draftOwnerId) return
    const retainLatest = () => {
      const snapshot = latestBrowserSnapshotRef.current
      if (snapshot && snapshot.content !== null && browserUnsavedRef.current) persistBrowserDraft(snapshot.project, snapshot.content)
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!browserUnsavedRef.current && !saveConflictRef.current) return
      retainLatest()
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    window.addEventListener('pagehide', retainLatest)
    return () => {
      retainLatest()
      window.removeEventListener('beforeunload', beforeUnload)
      window.removeEventListener('pagehide', retainLatest)
    }
  }, [draftOwnerId, persistBrowserDraft])

  const queueProjectSave = useCallback((project: CanvasStoredProjectSummary, content: string, revision: number, options?: { retainRevisionId?: string }) => {
    const epoch = projectEpochRef.current
    const collaborationAtStart = collaborationRef.current
    const savedDraft = browserDraftRef.current?.projectId === project.id && browserDraftRef.current.content === content ? browserDraftRef.current : null
    const sourceDraft = restoredDraftRef.current?.projectId === project.id ? restoredDraftRef.current : null
    const operation = projectSaveChainRef.current.then(async () => {
      if (!projectCanEditRef.current) throw new Error('当前项目不可保存；未提交编辑已保留，可下载工作流后重新核对权限')
      if (projectEpochRef.current !== epoch) throw new Error('工程已经重新读取，旧的保存请求已停止；原编辑草稿仍保留')
      if (saveConflictRef.current || draftRecoveryPendingRef.current) throw new Error('请先处理保存冲突或选择本地草稿恢复方式')
      let saved: CanvasStoredProjectSummary
      let acknowledgedContent = content
      try {
        if (collaborationRequired && !collaborationAtStart) throw new Error('协作状态尚未核对，原编辑保留；不会改用普通整图保存。')
        if (collaborationAtStart?.needsOperationSave()) {
          if (options?.retainRevisionId) throw new Error('实时协作期间不能整图恢复历史版本，请先保留本地稿并明确结束协作。')
          if (collaborationRef.current !== collaborationAtStart) throw new Error('协作连接已切换，原编辑保留。')
          const actual = await collaborationAtStart.flush(content)
          if (collaborationRef.current !== collaborationAtStart || projectEpochRef.current !== epoch || activeProjectIdRef.current !== project.id || !draftActionsEnabledRef.current) throw new Error('原协作已确认，但当前账号或工程已切换；当前图未采用旧回执。')
          saved = actual.project
          acknowledgedContent = actual.content
        } else saved = await hostBridge().saveProject(project.id, content, options)
      }
      catch (error) {
        if (!collaborationAtStart?.needsOperationSave() && error !== null && typeof error === 'object' && 'code' in error && error.code === 'COLLABORATION_ACTIVE' && collaborationAtStart) {
          browserUnsavedRef.current = true
          void collaborationAtStart.initialize()
        }
        if (!collaborationAtStart?.needsOperationSave() && error instanceof Error && /工程已.*(?:另一个|更新)|重新打开后再保存/.test(error.message)) {
          saveConflictRef.current = true
          browserUnsavedRef.current = true
          setSaveConflict(error.message)
          setAutoSaveState('failed')
        }
        throw error
      }
      if (projectEpochRef.current !== epoch) throw new Error('原工程的保存已提交，但工程已切换或重新打开；当前画布和本地草稿仍保留，请重新核对')
      const latestAtConfirmation = latestBrowserSnapshotRef.current
      const currentInvalid = latestAtConfirmation?.project.id === project.id && latestAtConfirmation.content === null
      try {
        if (savedDraft && !currentInvalid) clearCanvasBrowserDraft(window.localStorage, savedDraft)
        if (sourceDraft && savedDraft && !currentInvalid) {
          clearCanvasBrowserDraft(window.localStorage, sourceDraft)
          if (isSameCanvasBrowserDraftIdentity(restoredDraftRef.current, sourceDraft)) restoredDraftRef.current = null
        }
      } catch (error) { setDraftStorageError(error instanceof Error ? error.message : '云端已保存，本地草稿暂未清理') }
      if (activeProjectIdRef.current === project.id) {
        const normalized = parseWorkflowFile(acknowledgedContent)
        lastConfirmedContentRef.current = normalized ? serializeWorkflow({ ...normalized, name: saved.name, ...(collaborationAtStart?.needsOperationSave() ? { viewport: { ...currentReactFlowRef.current.getViewport() } } : {}) }) : acknowledgedContent
        draftBaseVersionRef.current = saved.version ?? draftBaseVersionRef.current
        const latest = latestBrowserSnapshotRef.current
        browserUnsavedRef.current = Boolean(latest && canvasWorkflowSnapshotNeedsSave(latest, lastConfirmedContentRef.current))
        if (browserUnsavedRef.current && latest && latest.content !== null) persistBrowserDraft(saved, latest.content, saved.version ?? draftBaseVersionRef.current)
        else if (!currentInvalid && isSameCanvasBrowserDraftIdentity(browserDraftRef.current, savedDraft)) browserDraftRef.current = null
      }
      if (autoSaveRevisionRef.current !== revision) return saved
      if (currentInvalid) { setAutoSaveState('failed'); return saved }
      setActiveProject(saved)
      setProjects((current) => [saved, ...current.filter((entry) => entry.id !== saved.id)])
      setAutoSaveState('saved')
      return saved
    })
    projectSaveChainRef.current = operation.then(() => undefined, () => undefined)
    return operation
  }, [persistBrowserDraft, collaborationRequired])

  saveBeforeRunRef.current = async (graph) => {
    const snapshot = latestBrowserSnapshotRef.current
    if (!snapshot || snapshot.content === null || !projectCanRunRef.current) throw new Error('当前工程不能保存，尚未开始运行；原编辑保留')
    const epoch = projectEpochRef.current, id = snapshot.project.id
    const current = getGraphSnapshot()
    if (!sameCanvasRunGraphSnapshot(graph, toCanvasRunGraph(current.nodes, current.edges, confirmedRunGroups(), nodeSourceCatalogRef.current))) throw new Error('运行内容已变化，请重新预检；尚未开始运行')
    await queueProjectSave(snapshot.project, snapshot.content, ++autoSaveRevisionRef.current)
    const after = getGraphSnapshot()
    if (epoch !== projectEpochRef.current || id !== activeProjectIdRef.current || !projectCanRunRef.current || !sameCanvasRunGraphSnapshot(graph, toCanvasRunGraph(after.nodes, after.edges, confirmedRunGroups(), nodeSourceCatalogRef.current))) throw new Error('保存期间工程或权限已变化，请重新预检；尚未开始运行')
  }

  function captureAgentWorkflow(): WorkflowFile {
    const snapshot = latestBrowserSnapshotRef.current
    if (!snapshot || snapshot.content === null || snapshot.project.id !== activeProjectIdRef.current) throw new Error(snapshot?.errorMessage ?? '当前工程无法保存，请先处理画布格式问题')
    const graph = getGraphSnapshot()
    return { ...createEmptyWorkflow(snapshot.project.name), mediaGroups: { ...mediaGroupsRef.current }, nodes: graph.nodes.map(toWorkflowNode), edges: graph.edges.map(toWorkflowEdge), viewport: { ...reactFlow.getViewport() } }
  }

  async function withAgentProjectTransaction<T>(action: () => Promise<T>): Promise<T> {
    if (!projectCanRunRef.current) throw new Error('协作项目暂不开放 Agent 运行；当前内容可编辑和导出')
    const scope = agentScope
    if (!scope?.active() || !activeProject || projectTransitionRef.current || closeBusyRef.current || saveConflictRef.current || draftRecoveryPendingRef.current || draftActionBusy || draftLocalActionGuard.current.busy()) throw new Error('请先完成工程保存或草稿恢复，再使用 Agent')
    if (activeRunsRef.current.size || startingRunsRef.current || resumingTaskIdsRef.current.size || pendingRunProjectionIdsRef.current.size || running) throw new Error('请等待当前运行及结果回填结束，再规划或应用提案')
    projectTransitionRef.current = true
    setProjectTransition(true)
    if (autosaveTimerRef.current !== null) { window.clearTimeout(autosaveTimerRef.current); autosaveTimerRef.current = null }
    try {
      await projectSaveChainRef.current
      if (!scope.active()) throw new Error('工程或账号已切换，请重新打开 Agent')
      return await action()
    } finally {
      if (scope.active()) { projectTransitionRef.current = false; setProjectTransition(false) }
    }
  }

  async function saveAgentWorkflow(workflow: WorkflowFile): Promise<number> {
    const snapshot = latestBrowserSnapshotRef.current, content = serializeWorkflow(workflow)
    if (!agentScope?.active() || !snapshot || snapshot.project.id !== agentScope.projectId) throw new Error('工程或账号已切换，原操作已停止')
    if (content !== lastConfirmedContentRef.current) {
      setAutoSaveState('saving')
      await queueProjectSave(snapshot.project, content, ++autoSaveRevisionRef.current)
    }
    if (!agentScope.active() || !Number.isSafeInteger(draftBaseVersionRef.current) || draftBaseVersionRef.current < 1) throw new Error('工程版本尚未确认，请保存后重试')
    if (latestBrowserSnapshotRef.current?.content === content) {
      const parts = { mediaGroups: workflow.mediaGroups ?? {}, nodes: workflow.nodes, edges: workflow.edges }
      lastAutosaveSignatureRef.current = JSON.stringify([canvasAutosaveSignature(parts), workflow.viewport])
      lastAutosaveGraphSignatureRef.current = canvasAutosaveGraphSignature(parts)
      setAutoSaveState('saved')
    }
    return draftBaseVersionRef.current
  }

  const listAgentImageAssets = useCallback(async (query: CanvasAssetQuery): Promise<CanvasAssetPage> => {
    const scope = agentScope
    if (!scope?.active() || !projectCanRunRef.current) throw new Error('工程或账号已变化，请重新打开 Agent')
    const page = await hostBridge().listAssets({ ...query, mediaType: 'image', view: query.view === 'recent' ? 'recent' : 'all' })
    if (!scope.active() || !projectCanRunRef.current) throw new Error('工程或账号已变化，旧素材列表已取消')
    return page
  }, [agentScope])
  const readAgentImageAsset = useCallback(async (assetId: string, signal?: AbortSignal): Promise<CanvasImageAssetSummary> => {
    const scope = agentScope, bridge = hostBridge()
    if (!scope?.active() || !projectCanRunRef.current || !bridge.getAssetDetail || signal?.aborted) throw new Error('当前不能核对本人图片，请重新打开 Agent')
    const asset = await bridge.getAssetDetail(assetId, signal)
    if (!scope.active() || !projectCanRunRef.current || signal?.aborted) throw new Error('工程或账号已变化，图片没有加入需求')
    if (!isTemplateImageAsset(asset) || asset.assetId !== assetId) throw new Error('本人图片已回收或不可读取，请移除后重新选择')
    return asset
  }, [agentScope])
  const readAgentExecutionAsset = useCallback(async (assetId: string, signal?: AbortSignal): Promise<CanvasAssetSummary> => {
    const scope = agentScope, scopeKey = currentWorkshopSetupScope()
    if (!scope?.active() || !projectCanRunRef.current || signal?.aborted) throw new Error('请在原账号和工程中核对这次运行素材')
    const asset = await readCanvasAssetDetail(assetId, signal)
    if (!scope.active() || scopeKey !== currentWorkshopSetupScope() || !projectCanRunRef.current || signal?.aborted) throw new Error('账号或工程已变化，原素材没有加入当前需求')
    if (asset.assetId !== assetId) throw new Error('原运行素材编号不一致，请重新核对')
    assertBatchAssetAvailable(asset)
    return asset
  }, [agentScope, currentWorkshopSetupScope, readCanvasAssetDetail])
  const previewAgentExecutionAsset = useCallback(async (candidate: CanvasRunCandidate['asset']): Promise<void> => {
    const asset = await readAgentExecutionAsset(candidate.assetId)
    if (asset.mediaType !== candidate.kind) throw new Error('原候选素材类型已变化，请重新核对')
    setPreviewAsset(mediaAssetRef(asset))
  }, [readAgentExecutionAsset])
  const downloadAgentExecutionAsset = useCallback(async (assetId: string): Promise<void> => {
    await readAgentExecutionAsset(assetId)
    await downloadAssetNodes([assetId])
  }, [readAgentExecutionAsset, downloadAssetNodes])
  const controlAgentExecution = useCallback(async (execution: CanvasAgentExecution, action: 'resume' | 'cancel'): Promise<boolean> => {
    const scope = agentScope, scopeKey = currentWorkshopSetupScope()
    function current() { return Boolean(scope?.active() && execution.projectId === scope.projectId && scopeKey === currentWorkshopSetupScope() && projectCanRunRef.current && !projectTransitionRef.current) }
    if (!current()) throw new Error('请回到原账号和工程核对这次运行')
    const original = await agentClient.request('readExecution', { projectId: execution.projectId, sessionId: execution.origin.sessionId, turnId: execution.origin.turnId, executionId: execution.id })
    if (!current() || original.execution.id !== execution.id || !original.record || original.execution.runId !== original.record.runId || original.record.projectId !== execution.projectId || execution.runId && execution.runId !== original.record.runId) throw new Error('原运行尚未完整核对，没有创建或继续其他运行')
    if (original.record.status !== 'running' || action === 'resume' && original.record.cancelRequested) return false
    const bridge = hostBridge()
    await bridge.refreshProjectAccess?.()
    if (!current() || bridge.getProjectAccess?.()?.denied || bridge.getProjectAccess?.()?.access?.canRun === false) throw new Error('工程权限已变化，原运行没有继续')
    const operate = action === 'resume' ? bridge.resumeRun : bridge.cancelRun
    if (!operate) throw new Error('当前宿主暂不支持继续原运行，请更新后核对')
    const accepted = await operate.call(bridge, original.record.runId)
    if (!current()) throw new Error('账号或工程已变化，请回到原消息核对刚才的运行操作')
    setAgentExecutionRefreshKey((value) => value + 1)
    return accepted
  }, [agentClient, agentScope, currentWorkshopSetupScope])
  const prepareAgentExecutionResume = useCallback(async (execution: CanvasAgentExecution): Promise<CanvasRunPreflight> => {
    const scope = agentScope, scopeKey = currentWorkshopSetupScope()
    function current() { return Boolean(scope?.active() && execution.projectId === scope.projectId && scopeKey === currentWorkshopSetupScope() && projectCanRunRef.current && !projectTransitionRef.current) }
    if (!current()) throw new Error('请回到原账号和工程检查原运行')
    const original = await agentClient.request('readExecution', { projectId: execution.projectId, sessionId: execution.origin.sessionId, turnId: execution.origin.turnId, executionId: execution.id })
    if (!current() || original.execution.id !== execution.id || !original.record || original.record.status !== 'running' || original.record.cancelRequested || original.execution.runId !== original.record.runId || original.record.projectId !== execution.projectId || execution.runId && execution.runId !== original.record.runId) throw new Error('原运行状态已变化，请刷新原消息；没有继续运行')
    const bridge = hostBridge()
    if (!bridge.getRunInputGraph || !bridge.resumeRun) throw new Error('当前宿主不能核对原运行输入，请更新后重试；没有继续运行')
    const graph = await bridge.getRunInputGraph(original.record.runId)
    if (!current()) throw new Error('账号或工程已变化，原运行检查已取消')
    await bridge.refreshProjectAccess?.()
    if (!current() || bridge.getProjectAccess?.()?.denied || bridge.getProjectAccess?.()?.access?.canRun === false) throw new Error('工程权限已变化，原运行没有继续')
    const listed = await readGroupCatalog(true)
    if (!current()) throw new Error('账号或工程已变化，原来源检查已取消')
    const selected = selectCanvasRunNodeIds(graph, original.record.scope)
    const terminal = new Set(original.record.nodes.filter((node) => ['succeeded', 'cached', 'failed', 'skipped', 'cancelled', 'interrupted'].includes(node.state)).map((node) => node.nodeId))
    const names = fixedCanvasNodeSourceNames(graph.nodes.filter((node) => selected.has(node.id) && !terminal.has(node.id)).map((node) => ({ type: node.kind, data: node.data })))
    let originalCatalog: CanvasNodeSourceCatalog = {}
    await prepareCanvasNodeSources({ names, groups: listed, prepare: (name) => bridge.prepareGroup(name), isCurrent: current, onChange(value) { if (current()) originalCatalog = value } })
    if (!current() || bridge.getProjectAccess?.()?.denied || bridge.getProjectAccess?.()?.access?.canRun === false) throw new Error('账号、工程或访问权限已变化，原来源检查已取消')
    return buildAgentExecutionResumePreflight({ capabilities: canvasCapabilities(), graph, scope: original.record.scope, sourceCatalog: originalCatalog, imageModels: mediaModelsRef.current.image, videoModels: mediaModelsRef.current.video, textModels: mediaModelsRef.current.text, imageAssetDimensions }, original.record)
  }, [agentClient, agentScope, currentWorkshopSetupScope, imageAssetDimensions, readGroupCatalog])
  const importAgentImage = useCallback(async (): Promise<CanvasImageAssetSummary | null> => {
    const scope = agentScope
    if (!scope?.active() || !projectCanRunRef.current) throw new Error('工程或账号已变化，请重新打开 Agent')
    const imported = await hostBridge().pickAsset({ mediaType: 'image' })
    if (!scope.active() || !projectCanRunRef.current) throw new Error('会话范围已变化；已上传图片保存在本人素材库，没有改动画布')
    if (!imported) return null
    const confirmed = await readAgentImageAsset(imported.assetId)
    if (!scope.active()) throw new Error('工程或账号已变化，图片没有加入需求')
    setAssetCatalog((previous) => [...previous.filter((asset) => asset.assetId !== confirmed.assetId), confirmed])
    return confirmed
  }, [agentScope, readAgentImageAsset])

  async function prepareAgentTurn(imageReferences: readonly CanvasAgentImageReference[] = []): Promise<{ projectId: string; expectedProjectVersion: number }> {
    return withAgentProjectTransaction(async () => {
      const workflow = captureAgentWorkflow(), before = canvasAgentGraphSnapshot(workflow)
      resolveCanvasAgentImageReferences(workflow, imageReferences.flatMap((image) => 'nodeId' in image ? [image.nodeId] : []), imageReferences)
      for (const image of imageReferences) if (!('nodeId' in image)) await readAgentImageAsset(image.assetId)
      const expectedProjectVersion = await saveAgentWorkflow(workflow)
      if (canvasAgentGraphSnapshot(captureAgentWorkflow()) !== before) throw new Error('画布在保存期间发生变化，请重新发送；需求草稿仍保留')
      return { projectId: agentScope!.projectId, expectedProjectVersion }
    })
  }

  function sendSelectionToAgent() {
    if (!agentScope?.active()) return
    let workflow: WorkflowFile
    try { workflow = captureAgentWorkflow() } catch (cause) { setBanner(cause instanceof Error ? cause.message : '当前画布尚未就绪，请重新打开 Agent'); return }
    const selected = workflow.nodes.filter((node) => selectedNodeIds.includes(node.id))
    if (!selected.length || selected.length > 40) { setBanner('请选择 1–40 个节点加入 Agent'); return }
    const unavailableImage = selected.find((node) => node.data.result?.kind === 'image' && canvasAgentNodeImageUnavailableReason(node))
    if (unavailableImage) { setBanner(`${canvasAgentNodeImageUnavailableReason(unavailableImage)}。如只需文字与配置，请在 Agent 面板使用“加入选中节点文字”。`); return }
    const imageReferences = selected.flatMap((node) => { const assetId = resolveCanvasAgentNodeImageAssetId(node); return assetId ? [{ nodeId: node.id, assetId }] : [] })
    if (imageReferences.length > 4) { setBanner('一次最多向 Agent 发送 4 张图片，请减少选区，或在 Agent 中单独选择图片'); return }
    setAgentContextRequest({ id: ++agentContextSequence.current, scopeKey: agentScope.key, nodeIds: selected.map((node) => node.id), imageReferences })
    setAgentOpen(true); setFocusMode(false); setMediaConfigOpen(false); setMoreActionsOpen(false)
  }

  function focusAgentPlan(nodeIds: string[]) {
    const scope = agentScope
    if (!scope?.active()) return
    cancelInsertionViewportNavigation()
    createdNodeFocusRef.current?.cancel(); viewportRestorationRef.current?.cancel()
    function focus(attempt = 0) {
      if (!scope?.active()) return
      const current = getGraphSnapshot().nodes.filter((node) => nodeIds.includes(node.id))
      if (!current.length) return
      const surface = document.querySelector('.canvas-flow')?.getBoundingClientRect()
      if (!surface) return
      const panel = document.querySelector('.canvas-agent-panel:not([hidden])')?.getBoundingClientRect()
      const bounds = reactFlow.getNodesBounds(current)
      const viewport = agentPlanFocusViewport(bounds, surface, panel)
      if (!viewport && attempt === 0) {
        setAgentOpen(false); setAssetTrayOpen(false); setRunInspectorOpen(false); setNodeInspectorOpen(false)
        window.requestAnimationFrame(() => focus(1)); return
      }
      if (viewport) void reactFlow.setViewport(viewport, { duration: 180 })
    }
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => focus()))
  }

  function approvedAgentAction(turn: CanvasAgentTurn, approval: CanvasAgentApprovalReference, parent: AbortSignal) {
    const scope = agentScope, revision = agentEditorApproval.current.revision(), signal = agentEditorApproval.current.signal(parent)
    function assert() {
      if (signal.aborted || !scope?.active() || !projectCanRunRef.current || agentEditorApproval.current.revision() !== revision || turn.projectId !== scope.projectId || turn.approval?.grantId !== approval.grantId || turn.approval.rootTurnId !== approval.rootTurnId || turn.supersededBy) throw new Error('画布、账号或本条授权已变化，自动执行已暂停；请核对原消息')
    }
    assert()
    return { signal, assert }
  }

  async function applyAgentTurn(turn: CanvasAgentTurn, authorization?: ReturnType<typeof approvedAgentAction>): Promise<CanvasAgentTurn> {
    const scope = agentScope
    authorization?.assert()
    const applied = await withAgentProjectTransaction(() => applyCanvasAgentTurn(turn, {
      projectId: agentScope!.projectId, pendingSaves: projectSaveChainRef.current,
      current: () => Boolean(agentScope?.active()), capture: captureAgentWorkflow,
      beforeCommit: authorization?.assert,
      completeSavedReceipt: Boolean(authorization),
      commit: (workflow) => {
        const project = latestBrowserSnapshotRef.current!.project
        if (!persistBrowserDraft(project, serializeWorkflow(workflow))) throw new Error('提案尚未安全保留到本地，请释放浏览器存储空间后重试；画布未修改')
        const commit = () => flushSync(() => execute({ type: 'replace-document', document: workflowDocument(workflow) }))
        if (authorization) agentEditorApproval.current.commit(commit)
        else commit()
      },
      save: saveAgentWorkflow,
      mark: (input) => agentClient.request('markApplied', input),
      validate: (input) => { authorization?.assert(); return agentClient.request('validateApplication', input, authorization?.signal) },
    }))
    if (scope?.active() && applied.proposal) focusAgentPlan([...applied.proposal.nodes.map((node) => node.id), ...applied.proposal.updates.map((node) => node.nodeId)])
    return applied
  }

  async function applyApprovedAgentTurn(turn: CanvasAgentTurn, approval: CanvasAgentApprovalReference, signal: AbortSignal): Promise<CanvasAgentTurn> {
    return applyAgentTurn(turn, approvedAgentAction(turn, approval, signal))
  }

  async function continueApprovedAgentTurn(turn: CanvasAgentTurn, approval: CanvasAgentApprovalReference, signal: AbortSignal): Promise<CanvasAgentTurn> {
    const authorization = approvedAgentAction(turn, approval, signal)
    return withAgentProjectTransaction(async () => {
      authorization.assert()
      const workflow = captureAgentWorkflow(), before = canvasAgentGraphSnapshot(workflow)
      const baseProjectVersion = await saveAgentWorkflow(workflow)
      authorization.assert()
      if (canvasAgentGraphSnapshot(captureAgentWorkflow()) !== before) throw new Error('画布在保存期间已变化，自动续规划已暂停；原工具结果仍保留')
      const operationId = await canvasAgentApprovedContinuationOperationId(turn.id, approval.grantId)
      authorization.assert()
      return agentClient.request('continueApprovedTurn', { projectId: turn.projectId, sessionId: turn.sessionId, turnId: turn.id, grantId: approval.grantId, operationId, baseProjectVersion }, authorization.signal)
    })
  }

  async function runApprovedAgentTurn(turn: CanvasAgentTurn, approval: CanvasAgentApprovalReference, signal: AbortSignal): Promise<CanvasAgentExecution | null> {
    const authorization = approvedAgentAction(turn, approval, signal)
    return withAgentProjectTransaction(async () => {
      authorization.assert()
      if (turn.state !== 'applied' || !turn.proposal) throw new Error('请先核对原提案的应用回执；没有开始其他运行')
      const current = getGraphSnapshot(), ids = canvasAgentProposalTargetNodeIds(turn.proposal)
      if (ids.some((id) => !current.nodes.some((node) => node.id === id))) throw new Error('原提案的节点已删除，自动运行已暂停')
      const eligible = ids.filter((id) => current.nodes.some((node) => node.id === id && isCanvasRunnableTarget(node)))
      if (!eligible.length) return null
      const scope: CanvasRunScope = { kind: 'selection', nodeIds: eligible }
      const graph = toCanvasRunGraph(current.nodes, current.edges, confirmedRunGroups(), nodeSourceCatalogRef.current)
      const configuration = confirmedRunGroups()
      const preflight = buildCanvasRunPreflight({ capabilities: canvasCapabilities(), graph, scope, sourceCatalog: nodeSourceCatalogRef.current, imageAssetDimensions,
        cachedNodeIds: cachedNodeIdsForPreflight(current.nodes, scope), imageGroup: configuration.image, videoGroup: configuration.video,
        videoProtocol: configuration.videoProtocol, textGroup: configuration.text, imageModels: mediaModelsRef.current.image,
        videoModels: mediaModelsRef.current.video, textModels: mediaModelsRef.current.text, nodeBlockReasons: dramaPreflightBlockReasons(current.nodes, current.edges) })
      if (rejectPendingMedia(preflight) || rejectUnavailableGroups(preflight) || !preflight.canStart) throw new Error(preflight.warnings.filter((entry) => entry.includes('：')).join('；') || '运行预检未通过，自动执行已暂停，请先处理阻塞项')
      await saveAgentWorkflow(captureAgentWorkflow())
      authorization.assert()
      const after = getGraphSnapshot()
      if (!sameCanvasRunGraphSnapshot(graph, toCanvasRunGraph(after.nodes, after.edges, confirmedRunGroups(), nodeSourceCatalogRef.current))) throw new Error('保存期间运行内容已变化，自动执行已暂停；没有创建其他运行')
      const operationId = await canvasAgentApprovedExecutionOperationId(turn.id, approval.grantId, turn.proposal.digest)
      authorization.assert()
      startingRunsRef.current++; setStartingRuns(startingRunsRef.current)
      try {
        const started = await hostBridge().startRun(canvasRunInputForHost({ graph, scope, agentExecution: { version: 1, sessionId: turn.sessionId, turnId: turn.id, proposalDigest: turn.proposal.digest } }, canvasCapabilities()), { operationId, signal: authorization.signal })
        authorization.assert()
        if (!started.execution || started.execution.operationId !== operationId || started.execution.origin.turnId !== turn.id || started.execution.runId !== started.runId) throw new Error('原运行关联回执待核对，不会自动重新生成')
        rememberActiveRun({ ...started, projectId: turn.projectId, scope, graph })
        setAgentExecutionRefreshKey((value) => value + 1)
        setBanner('已按本条授权继续原运行，进度和结果会保留在原消息')
        void refreshRuns(started.runId)
        return started.execution
      } finally { startingRunsRef.current--; setStartingRuns(startingRunsRef.current) }
    })
  }

  async function renameActiveProject(name: string): Promise<void> {
    if (!activeProject || projectTransitionRef.current || closeBusyRef.current || saveConflictRef.current || draftRecoveryPendingRef.current) throw new Error('请先完成当前保存或恢复操作，再修改项目名称')
    const projectId = activeProject.id
    const epoch = projectEpochRef.current
    const scope = renameScopeRef.current
    const bridge = hostBridge()
    function current() { return renameScopeRef.current === scope && projectEpochRef.current === epoch && activeProjectIdRef.current === projectId }
    projectTransitionRef.current = true
    setProjectTransition(true)
    if (autosaveTimerRef.current !== null) { window.clearTimeout(autosaveTimerRef.current); autosaveTimerRef.current = null }
    try {
      const live = collaborationRef.current
      if (live?.needsOperationSave()) {
        const snapshot = latestBrowserSnapshotRef.current
        if (!snapshot || snapshot.content === null || snapshot.project.id !== projectId) throw new Error('当前工程暂不可保存，改名尚未提交。')
        await queueProjectSave(snapshot.project, snapshot.content, ++autoSaveRevisionRef.current)
        if (!current() || collaborationRef.current !== live) throw new Error('工程或协作连接已变化，原改名未提交。')
        await live.rename(name)
        if (!current()) throw new Error('原改名已确认，但当前工程已切换，请在原工程核对。')
        return
      }
      await runProjectRenameTransaction({
        pendingSaves: projectSaveChainRef.current,
        current,
        capture: () => {
          const snapshot = latestBrowserSnapshotRef.current
          if (!snapshot || snapshot.project.id !== projectId || snapshot.content === null) throw new Error(snapshot?.errorMessage ?? '当前工程无法保存，请先处理画布格式问题')
          const graph = getGraphSnapshot()
          const parts = { mediaGroups: { ...mediaGroupsRef.current }, nodes: graph.nodes.map(toWorkflowNode), edges: graph.edges.map(toWorkflowEdge) }
          const savedViewport = parseWorkflowFile(snapshot.content)?.viewport
          return { project: snapshot.project, content: snapshot.content, signature: JSON.stringify([canvasAutosaveSignature(parts), savedViewport]), graphSignature: canvasAutosaveGraphSignature(parts) }
        },
        save: async (snapshot) => { await queueProjectSave(snapshot.project, snapshot.content, ++autoSaveRevisionRef.current) },
        rename: () => {
          const operation = projectSaveChainRef.current.then(() => {
            if (!current()) throw new Error('项目或账号已切换，原改名操作已停止')
            return bridge.renameProject(projectId, name)
          })
          projectSaveChainRef.current = operation.then(() => undefined, () => undefined)
          return operation
        },
        confirm: (renamed, { content, signature, graphSignature }) => {
          const savedWorkflow = parseWorkflowFile(content)
          if (!savedWorkflow) throw new Error('当前工程快照无法核对，请重新打开项目确认名称')
          lastConfirmedContentRef.current = serializeWorkflow({ ...savedWorkflow, name: renamed.name })
          draftBaseVersionRef.current = renamed.version ?? draftBaseVersionRef.current
          const latest = latestBrowserSnapshotRef.current
          const latestWorkflow = latest?.content ? parseWorkflowFile(latest.content) : null
          const latestContent = latestWorkflow ? serializeWorkflow({ ...latestWorkflow, name: renamed.name }) : null
          browserUnsavedRef.current = latestContent !== lastConfirmedContentRef.current
          if (browserUnsavedRef.current && latestContent) persistBrowserDraft(renamed, latestContent, draftBaseVersionRef.current)
          lastAutosaveSignatureRef.current = signature
          lastAutosaveGraphSignatureRef.current = graphSignature
          setActiveProject(renamed)
          setProjects((entries) => [renamed, ...entries.filter((entry) => entry.id !== projectId)])
          setAutoSaveState(browserUnsavedRef.current ? 'pending' : 'saved')
          setBanner('项目名称已保存')
        },
      })
    } catch (error) {
      if (current()) setBanner('项目改名未确认，当前画布与本地草稿仍保留。请核对错误后重试。')
      throw error
    } finally {
      if (current()) { projectTransitionRef.current = false; setProjectTransition(false) }
    }
  }

  const historyCurrent = Boolean(historyScope && draftActionsEnabled && historyScope.projectId === activeProject?.id && historyScope.projectEpoch === projectEpochRef.current)
  useEffect(() => {
    if (!historyScope || historyCurrent) return
    historyDialogEpochRef.current += 1
    setHistoryScope(null)
  }, [historyScope, historyCurrent])

  function openProjectHistory() {
    if (!activeProject || !draftActionsEnabledRef.current || projectTransitionRef.current || closeBusyRef.current) return
    const bridge = hostBridge()
    if (!bridge.listProjectHistory || !bridge.readProjectRevision || !bridge.restoreProjectRevision || !bridge.inspectProjectRestore) return
    setMoreActionsOpen(false)
    setHistoryError(collaborationRef.current?.needsOperationSave() ? '实时协作期间只可查看历史，不能整图恢复；请先保留本地稿并明确结束协作。' : null)
    setHistoryScope({ projectId: activeProject.id, projectEpoch: projectEpochRef.current, dialogEpoch: ++historyDialogEpochRef.current })
  }

  function closeProjectHistory() {
    if (historyBusyRef.current) return
    historyDialogEpochRef.current += 1
    setHistoryScope(null)
  }

  async function restoreProjectHistory(detail?: CanvasProjectRevisionDetail, retryMissing = false): Promise<void> {
    if (collaborationRef.current?.needsOperationSave()) { setHistoryError('实时协作期间不能整图恢复历史，当前版本仍可预览；请先保留本地稿并明确结束协作。'); return }
    if (!projectCanRestore) { setHistoryError('只有项目拥有者可以恢复版本；当前版本可预览'); return }
    if (!activeProject || !historyScope || !historyCurrent || historyBusyRef.current || projectTransitionRef.current || closeBusyRef.current) return
    const pending = historyPendingRef.current
    if (historyRecoveryErrorRef.current) { setHistoryError(historyRecoveryErrorRef.current); return }
    if (retryMissing && (!pending || historyMissingRef.current !== pending)) { setHistoryError('请先核对原恢复结果；只有明确未找到时才能按原编号重试'); return }
    const bridge = hostBridge()
    if (!bridge.restoreProjectRevision || !bridge.inspectProjectRestore) return
    const projectId = activeProject.id, epoch = projectEpochRef.current, dialogEpoch = historyDialogEpochRef.current, mountedScope = renameScopeRef.current, ownerId = creationOwnerId
    function current() { return draftActionsEnabledRef.current && !closeBusyRef.current && historyRecoveryOwnerRef.current === ownerId && renameScopeRef.current === mountedScope && projectEpochRef.current === epoch && activeProjectIdRef.current === projectId && historyDialogEpochRef.current === dialogEpoch }
    if (pending && (pending.projectId !== projectId || pending.epoch !== epoch)) { setHistoryError('原恢复操作属于另一个工程，请重新打开原工程核对'); return }
    if (!pending && (!detail?.canRestore || detail.revision.projectId !== projectId || saveConflictRef.current || draftRecoveryPendingRef.current)) { setHistoryError('请先处理当前工程的保存冲突、草稿或缺失素材，再恢复版本'); return }
    if (activeRunsRef.current.size || running || startingRunsRef.current || resumingTaskIdsRef.current.size || pendingRunProjectionIdsRef.current.size) { setHistoryError('请先等待任务结束并完成结果回填，再恢复工程版本'); return }
    historyBusyRef.current = true
    setHistoryBusy(true); setHistoryError(null)
    projectTransitionRef.current = true; setProjectTransition(true)
    if (autosaveTimerRef.current !== null) { window.clearTimeout(autosaveTimerRef.current); autosaveTimerRef.current = null }
    autoSaveRevisionRef.current += 1
    let installed = false
    let mutationStarted = false
    let writeLease = false
    async function confirm(result: CanvasProjectRestoreResult) {
      if (!current()) throw new Error('工程或账户已经切换，恢复回执不会替换当前画布')
      if (result.state === 'changed') {
        setHistoryPendingState('changed')
        throw new Error('原恢复已提交，但工程随后又有更新。请保留本地草稿并读取云端核对。')
      }
      // A user may close an unknown-result dialog and continue editing locally.
      // Reconciliation must preserve those later edits without resaving them over
      // the already restored cloud version or reusing their draft writer.
      const latest = latestBrowserSnapshotRef.current
      let retainedWriter: ReturnType<typeof buildCanvasBrowserDraftWriterRotation> | null = null
      if (latest?.project.id === projectId && canvasWorkflowSnapshotNeedsSave(latest, lastConfirmedContentRef.current)) {
        if (latest.content === null) throw new Error('当前新编辑无法保留，请先导出并处理格式问题，再核对恢复结果')
        if (draftOwnerId) {
          const retained = persistBrowserDraft(latest.project, latest.content)
          if (!retained) throw new Error('当前新编辑尚未安全保留，请先导出工作流，再读取已恢复的版本')
          assertCanvasBrowserDraftStored(window.localStorage, retained)
          retainedWriter = buildCanvasBrowserDraftWriterRotation(draftWriterIdRef.current, crypto.randomUUID())
        } else throw new Error('当前存在恢复提交后的新编辑，请先导出当前工作流再重新读取云端')
      }
      const recovery = historyPendingRef.current?.record
      if (!await openStoredProject(projectId, { skipDraftRecovery: true, confirmed: result, ...(recovery ? { resolvedRecovery: recovery } : {}) })) throw new Error('版本已经恢复，但画布尚未载入，请重新读取云端；恢复前的保存点仍保留')
      if (retainedWriter) { draftWriterIdRef.current = retainedWriter.writerId; draftRevisionSequenceRef.current = retainedWriter.revisionSequence; browserDraftRef.current = null }
      installed = true
      setBanner(`已恢复所选画布并保存为版本 ${result.project.version}，恢复前的保存点已保留`)
    }
    async function confirmWithLease(result: CanvasProjectRestoreResult) {
      if (storageMode === 'cloud' && !writeLease) {
        if (!ownerId) throw new Error('版本恢复所属账号尚未核对，原操作记录仍保留')
        await withProjectHistoryRecoveryLock(ownerId, projectId, current, () => confirm(result))
      } else await confirm(result)
    }
    function enqueueRestore(input: CanvasProjectRestoreInput) {
      const operation = projectSaveChainRef.current.then(() => {
        if (!current()) throw new Error('工程或账户已经变化，原恢复请求已停止')
        const recovery = historyPendingRef.current?.record
        if (recovery) assertProjectHistoryRecoveryStored(window.localStorage, recovery)
        mutationStarted = true
        return bridge.restoreProjectRevision!(projectId, input)
      })
      projectSaveChainRef.current = operation.then(() => undefined, () => undefined)
      return operation
    }
    async function operate() {
      if (storageMode === 'cloud') {
        if (!ownerId) throw new Error('版本恢复所属账号尚未核对，恢复请求未提交')
        let stored: ProjectHistoryRecoveryRecord | null
        try { stored = readProjectHistoryRecovery(window.localStorage, ownerId, projectId) }
        catch (error) {
          const message = error instanceof Error ? error.message : '本机版本恢复记录尚未核对，请保留浏览器数据'
          historyRecoveryErrorRef.current = message
          saveConflictRef.current = true; setSaveConflict(message); setAutoSaveState('failed')
          throw error
        }
        if (pending?.record && stored) assertProjectHistoryRecoveryStored(window.localStorage, pending.record)
        else if (stored) {
          historyPendingRef.current = { projectId, epoch, input: stored.input, record: stored }
          historyMissingRef.current = null
          setHistoryPendingState('unknown')
          throw new Error('另一页面已有原恢复操作，请先核对；当前没有提交新的恢复')
        }
      }
      if (pending) {
        historyMissingRef.current = null
        const inspection = await bridge.inspectProjectRestore!(projectId, pending.input)
        if (!current()) throw new Error('工程或账户已切换，原恢复回执不会覆盖当前画布')
        if (pending.record && readProjectHistoryRecovery(window.localStorage, pending.record.ownerId, projectId)) assertProjectHistoryRecoveryStored(window.localStorage, pending.record)
        if (inspection.state === 'missing') {
          historyMissingRef.current = pending
          setHistoryPendingState('missing')
          if (!retryMissing) {
            saveConflictRef.current = true; setSaveConflict('服务器未找到原恢复操作。自动保存仍暂停；请在版本历史中明确按原编号重试，不会自动重新提交。'); setAutoSaveState('failed')
            return
          }
          await confirmWithLease(await enqueueRestore(pending.input))
        } else {
          if (inspection.state === 'restored') setHistoryPendingState('completed')
          await confirmWithLease(inspection)
        }
      } else {
        await runProjectHistoryRestore({
          pendingSaves: projectSaveChainRef.current, current,
          capture() {
            const snapshot = latestBrowserSnapshotRef.current
            if (!snapshot || snapshot.project.id !== projectId || snapshot.content === null) throw new Error(snapshot?.errorMessage ?? '当前工程内容无法保存，请先导出并修复格式问题')
            return snapshot
          },
          async save(snapshot) {
            if (snapshot.content !== null && canvasWorkflowSnapshotNeedsSave(snapshot, lastConfirmedContentRef.current)) {
              if (draftOwnerId && !persistBrowserDraft(snapshot.project, snapshot.content)) throw new Error('当前编辑尚未安全保留，请先导出工作流再恢复版本')
              setAutoSaveState('saving')
              await queueProjectSave(snapshot.project, snapshot.content, ++autoSaveRevisionRef.current, { retainRevisionId: detail!.revision.id })
            }
          },
          restore() {
            const input = { operationId: crypto.randomUUID(), revisionId: detail!.revision.id, expectedVersion: draftBaseVersionRef.current }
            const record = storageMode === 'cloud' && ownerId ? writeProjectHistoryRecovery(window.localStorage, { version: 1, ownerId, projectId, input, createdAt: new Date().toISOString() }) : undefined
            historyPendingRef.current = { projectId, epoch, input, ...(record ? { record } : {}) }
            historyMissingRef.current = null
            setHistoryPendingState('unknown')
            return enqueueRestore(input)
          },
          confirm: confirmWithLease,
        })
      }
    }
    try {
      if (storageMode === 'cloud' && (!pending || retryMissing)) {
        if (!ownerId) throw new Error('版本恢复所属账号尚未核对，恢复请求未提交')
        await withProjectHistoryRecoveryLock(ownerId, projectId, current, async () => { writeLease = true; try { await operate() } finally { writeLease = false } })
      } else await operate()
    } catch (error) {
      if (!current()) return
      const message = error instanceof Error ? error.message : '版本恢复尚未确认，请核对原操作'
      if (mutationStarted && isDefiniteProjectHistoryRejection(error)) {
        const recovery = historyPendingRef.current?.record
        if (recovery) {
          try { await withProjectHistoryRecoveryLock(recovery.ownerId, projectId, current, async () => clearProjectHistoryRecovery(window.localStorage, recovery)) }
          catch (storageError) {
            const message = storageError instanceof Error ? storageError.message : '原恢复记录尚未清除，请继续核对'
            saveConflictRef.current = true; setSaveConflict(message); setAutoSaveState('failed'); setHistoryError(message)
            return
          }
        }
        historyPendingRef.current = null; setHistoryPendingState(undefined)
        historyMissingRef.current = null
        if (typeof error === 'object' && error !== null && 'status' in error && error.status === 409) {
          saveConflictRef.current = true; setSaveConflict(message); setAutoSaveState('failed')
        }
      } else if (historyPendingRef.current) {
        saveConflictRef.current = true
        setSaveConflict('版本恢复结果尚需核对，自动保存已暂停。请打开“版本历史”核对原操作，或保留草稿并重新读取云端。')
        setAutoSaveState('failed')
      }
      setHistoryError(message)
    } finally {
      if ((renameScopeRef.current === mountedScope && projectEpochRef.current === epoch && activeProjectIdRef.current === projectId) || installed) { projectTransitionRef.current = false; setProjectTransition(false) }
      if (renameScopeRef.current === mountedScope) { historyBusyRef.current = false; setHistoryBusy(false) }
    }
  }

  const restoreLocalDraft = useCallback(() => {
    if (!activeProject || !draftRecovery || draftDialogMode !== 'recovery' || !draftActionsEnabledRef.current || draftLocalActionGuard.current.busy() || !draftDialogScope || !isSameCanvasDraftActionScope(draftDialogScope, currentDraftActionScope())) return
    const draft = selectCanvasBrowserDraft(draftRecovery, selectedDraft)
    if (draft) {
      try { assertCanvasBrowserDraftStored(window.localStorage, draft) }
      catch (error) { setDraftStorageError(error instanceof Error ? error.message : '这份草稿已经变化，请重新读取核对'); return }
    }
    const workflow = draft ? parseWorkflowFile(draft.content) : null
    if (!draft || !workflow) { setDraftStorageError('本地草稿无法读取，请先导出草稿后再选择云端内容'); return }
    workflow.name = activeProject.name
    // A recovered local draft can predate the persisted dirty field. Preserve
    // its existing conservative policy of checking the whole restored graph.
    workflow.nodes = workflow.nodes.map((node) => ({ ...node, data: { ...node.data, dirty: true } }))
    const serialization = inspectCanvasWorkflowSnapshot(workflow, canvasCapabilities().project)
    if (serialization.content === null) { setDraftStorageError(serialization.errorMessage); return }
    const document = workflowDocument(workflow)
    const conflict = draft.cloudVersion !== (activeProject.version ?? 0)
    draftBaseVersionRef.current = draft.cloudVersion
    restoredDraftRef.current = draft
    browserDraftRef.current = null
    draftRecoveryPendingRef.current = false
    saveConflictRef.current = conflict
    browserUnsavedRef.current = true
    setDraftRecovery(null)
    setDraftDialogScope(null)
    setSaveConflict(conflict ? '这份草稿创建后云端工程已有更新，自动保存已暂停。请另存为新工程，或导出当前内容后读取云端。' : null)
    projectHydrationRef.current = false
    lastAutosaveSignatureRef.current = null
    lastAutosaveGraphSignatureRef.current = null
    persistBrowserDraft(activeProject, serialization.content, draft.cloudVersion)
    execute({ type: 'replace-document', document, resetHistory: true })
    setDirtyNodeIds(new Set(workflow.nodes.map((node) => node.id)))
    restoreCanvasViewport(document.viewport)
    setAutoSaveState(conflict ? 'failed' : 'pending')
    setBanner(conflict ? '本地草稿已恢复，当前编辑会继续保存在本地，请选择保存冲突的处理方式' : '本地草稿已恢复，正在保存到云端')
  }, [activeProject, draftRecovery, selectedDraft, draftDialogMode, draftDialogScope, persistBrowserDraft, execute, restoreCanvasViewport])

  const useCloudDocument = useCallback(() => {
    if (draftDialogMode !== 'recovery' || !draftActionsEnabledRef.current || draftLocalActionGuard.current.busy() || !draftDialogScope || !isSameCanvasDraftActionScope(draftDialogScope, currentDraftActionScope())) return
    try {
      const ownDraft = draftRecovery?.find((draft) => draft.writerId === draftWriterIdRef.current)
      if (ownDraft) {
        assertCanvasBrowserDraftStored(window.localStorage, ownDraft)
        const next = buildCanvasBrowserDraftWriterRotation(draftWriterIdRef.current, crypto.randomUUID())
        draftWriterIdRef.current = next.writerId
        draftRevisionSequenceRef.current = next.revisionSequence
        browserDraftRef.current = null
      }
      draftRecoveryPendingRef.current = false
      setDraftRecovery(null)
      setDraftDialogScope(null)
      setSelectedDraft(null)
      setBanner('已使用云端工程，本地草稿仍保留，可在重新打开工程时恢复')
    } catch (error) { setDraftStorageError(error instanceof Error ? error.message : '旧草稿尚未确认保存在本地，请先导出草稿后重试') }
  }, [draftRecovery, draftDialogMode, draftDialogScope])

  function openLocalDraftManager(returnFocus?: HTMLElement | null) {
    if (!draftOwnerId || !activeProject || !draftActionsEnabledRef.current || draftActionBusy || draftLocalActionGuard.current.busy() || projectTransitionRef.current) return
    draftLocalActionGuard.current.invalidate()
    draftReturnFocusRef.current = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    if (autosaveTimerRef.current !== null) { window.clearTimeout(autosaveTimerRef.current); autosaveTimerRef.current = null }
    autoSaveRevisionRef.current += 1
    draftDialogEpochRef.current += 1
    draftRecoveryPendingRef.current = true
    setDraftDialogMode('manage')
    setDraftDialogScope(currentDraftActionScope())
    draftConfirmationRef.current = null
    setDraftConfirmation(null)
    setDraftDialogNotice(null)
    setDraftDialogError(null)
    try {
      const drafts = listCanvasBrowserDrafts(window.localStorage, draftOwnerId, activeProject.id)
      setDraftRecovery(drafts)
      setSelectedDraft(drafts[0] ? { writerId: drafts[0].writerId, revision: drafts[0].revision } : null)
      setDraftListAvailable(true)
    } catch (error) {
      setDraftRecovery([])
      setSelectedDraft(null)
      setDraftListAvailable(false)
      setDraftDialogError(error instanceof Error ? error.message : '本地草稿列表读取失败，请保留浏览器数据后重试')
    }
  }

  function refreshLocalDraftManager(selectFirst = false) {
    if (!draftOwnerId || draftDialogMode !== 'manage' || !draftDialogScope || !draftActionsEnabledRef.current || !isSameCanvasDraftActionScope(draftDialogScope, currentDraftActionScope())) return
    try {
      if (!draftDialogScope.projectId) return
      const drafts = listCanvasBrowserDrafts(window.localStorage, draftOwnerId, draftDialogScope.projectId)
      const stillSelected = selectCanvasBrowserDraft(drafts, selectedDraft)
      setDraftRecovery(drafts)
      setSelectedDraft(stillSelected ? { writerId: stillSelected.writerId, revision: stillSelected.revision } : selectFirst && drafts[0] ? { writerId: drafts[0].writerId, revision: drafts[0].revision } : null)
      setDraftListAvailable(true)
      setDraftDialogError(null)
    } catch (error) {
      setDraftListAvailable(false)
      setDraftDialogError(error instanceof Error ? error.message : '本地草稿列表读取失败，请保留原草稿后重试')
    }
  }

  function closeLocalDraftManager() {
    if (draftDialogMode !== 'manage') return
    draftLocalActionGuard.current.invalidate()
    draftDialogEpochRef.current += 1
    draftRecoveryPendingRef.current = false
    draftConfirmationRef.current = null
    setDraftConfirmation(null)
    setDraftRecovery(null)
    setDraftDialogScope(null)
    setSelectedDraft(null)
    setDraftLocalActionBusy(false)
    setDraftDialogError(null)
    setDraftDialogNotice(null)
  }

  function protectedLocalDraft(): CanvasBrowserDraft | null {
    if (!browserUnsavedRef.current && !saveConflictRef.current) return null
    return browserDraftRef.current ?? restoredDraftRef.current
  }

  function requestLocalDraftRemoval(draft: CanvasBrowserDraft) {
    if (draftDialogMode !== 'manage' || !draftListAvailable || !draftDialogScope || !draftActionsEnabledRef.current || draftLocalActionGuard.current.busy() || !isSameCanvasDraftActionScope(draftDialogScope, currentDraftActionScope())) return
    if (isSameCanvasBrowserDraftIdentity(protectedLocalDraft(), draft)) { setDraftDialogError('这份草稿正在保护当前编辑，请先完成保存再清理'); return }
    try {
      const confirmation = buildCanvasDraftConfirmation(currentDraftActionScope(), draft)
      draftConfirmationRef.current = confirmation
      setDraftConfirmation(confirmation)
      setDraftDialogError(null)
      setDraftDialogNotice(null)
    } catch (error) { setDraftDialogError(error instanceof Error ? error.message : '草稿归属无法确认，请重新读取核对') }
  }

  function cancelLocalDraftRemoval() {
    if (draftLocalActionGuard.current.busy()) return
    draftConfirmationRef.current = null
    setDraftConfirmation(null)
  }

  function retainLatestLocalDraft(): boolean {
    const snapshot = latestBrowserSnapshotRef.current
    if (!snapshot || snapshot.project.id !== activeProjectIdRef.current) return true
    if (snapshot.content === null) {
      browserUnsavedRef.current = true
      setDraftStorageError(snapshot.errorMessage)
      setAutoSaveState('failed')
      return false
    }
    if (!canvasWorkflowSnapshotNeedsSave(snapshot, lastConfirmedContentRef.current) && !saveConflictRef.current) return true
    browserUnsavedRef.current = true
    const saved = persistBrowserDraft(snapshot.project, snapshot.content)
    if (!saved) { setAutoSaveState('failed'); return false }
    if (!saveConflictRef.current) setAutoSaveState('pending')
    return true
  }

  function confirmLocalDraftRemoval() {
    const confirmation = draftConfirmationRef.current
    if (!confirmation || draftDialogMode !== 'manage' || !canvasDraftConfirmationCurrent(confirmation, currentDraftActionScope(), draftActionsEnabledRef.current)) return
    if (isSameCanvasBrowserDraftIdentity(protectedLocalDraft(), confirmation.draft)) { setDraftDialogError('这份草稿正在保护当前编辑，请先完成保存再清理'); return }
    const token = draftLocalActionGuard.current.begin(currentDraftActionScope())
    if (!token) return
    setDraftLocalActionBusy(true)
    try {
      const result = confirmCanvasDraftActionRemoval(confirmation, currentDraftActionScope(), draftActionsEnabledRef.current, (draft) => confirmRemoveCanvasBrowserDraft(window.localStorage, draft, true))
      if (result === 'inactive') return
      const removed = result === 'removed'
      if (!draftLocalActionGuard.current.current(token, currentDraftActionScope(), draftActionsEnabledRef.current)) return
      draftConfirmationRef.current = null
      setDraftConfirmation(null)
      if (removed) {
        if (isSameCanvasBrowserDraftIdentity(browserDraftRef.current, confirmation.draft)) browserDraftRef.current = null
        if (isSameCanvasBrowserDraftIdentity(restoredDraftRef.current, confirmation.draft)) restoredDraftRef.current = null
        setDraftStorageError(null)
        const retained = retainLatestLocalDraft()
        setDraftDialogNotice(retained ? '指定的本地草稿已删除。当前画布与云端工程没有被替换。' : '指定的本地草稿已删除，但当前编辑仍未完成本地保存，请处理存储提示；当前画布仍保留。')
      } else {
        setDraftDialogNotice('草稿可能已更新，或来自旧版存储、仍可能被其他页面写入，暂不能安全清理。原草稿仍保留，可先导出并重新读取核对。')
      }
      refreshLocalDraftManager(removed)
    } catch (error) {
      if (draftLocalActionGuard.current.current(token, currentDraftActionScope(), draftActionsEnabledRef.current)) setDraftDialogError(error instanceof Error ? error.message : '草稿删除未确认，原草稿仍需保留并核对')
    } finally {
      const current = draftLocalActionGuard.current.current(token, currentDraftActionScope(), draftActionsEnabledRef.current)
      draftLocalActionGuard.current.finish(token)
      if (current) setDraftLocalActionBusy(false)
    }
  }

  async function retryLocalDraftSave() {
    if (!draftActionsEnabledRef.current || !activeProject || draftActionBusy || draftRecoveryPendingRef.current || projectTransitionRef.current) return
    const token = draftLocalActionGuard.current.begin(currentDraftActionScope())
    if (!token) return
    setDraftLocalActionBusy(true)
    function current() { return draftLocalActionGuard.current.current(token, currentDraftActionScope(), draftActionsEnabledRef.current) }
    try {
      if (autosaveTimerRef.current !== null) { window.clearTimeout(autosaveTimerRef.current); autosaveTimerRef.current = null }
      if (!retainLatestLocalDraft()) return
      if (saveConflictRef.current) { setBanner('当前编辑已保留在本地，云端保存冲突仍需处理'); return }
      const snapshot = latestBrowserSnapshotRef.current
      if (!snapshot || snapshot.content === null || !current()) return
      const revision = ++autoSaveRevisionRef.current
      setAutoSaveState('saving')
      await queueProjectSave(snapshot.project, snapshot.content, revision)
      if (current()) setBanner('当前编辑已确认保存到云端，本地保留草稿仍可单独管理')
    } catch (error) {
      if (current()) { setAutoSaveState('failed'); setBanner(canvasAutosaveErrorMessage(error)) }
    } finally {
      const active = current()
      draftLocalActionGuard.current.finish(token)
      if (active) setDraftLocalActionBusy(false)
    }
  }

  const saveConflictAsNewProject = useCallback(async () => {
    if (!activeProject || draftActionBusy) return
    setDraftActionBusy(true)
    try {
      const content = serializeWorkflow(workflowSnapshot())
      persistBrowserDraft(activeProject, content)
      const created = await createProjectCopyForHost(hostBridge(), { name: `${activeProject.name.slice(0, 148)} · ${storageMode === 'cloud' ? '云端副本' : '本地副本'}`, content, sourceProjectId: activeProject.id }, canvasCapabilities())
      if (!created) throw new Error('新工程未创建，请保留当前编辑后重试')
      const opened = await openStoredProject(created.project.id, { skipDraftRecovery: true })
      if (!opened) throw new Error('新工程已经创建，但尚未打开，请从项目中心打开新副本；原编辑草稿仍保留')
      const route = new URL(window.location.href)
      route.searchParams.set('project', created.project.id)
      route.searchParams.delete('template')
      window.history.replaceState(window.history.state, '', `${route.pathname}${route.search}${route.hash}`)
      setBanner('已另存为新工程，原工程的本地草稿仍保留')
    } catch (error) { setBanner(error instanceof Error ? error.message : '另存工程未完成，请保留当前编辑后重试') }
    finally { setDraftActionBusy(false) }
  }, [activeProject, draftActionBusy, nodes, edges, viewport, mediaGroups, persistBrowserDraft, openStoredProject, storageMode])

  const reloadCloudProject = useCallback(async (resolveHistory = false) => {
    if (!activeProject || draftActionBusy) return
    const projectId = activeProject.id, epoch = projectEpochRef.current, ownerId = creationOwnerId, mountedScope = renameScopeRef.current
    function current() { return draftActionsEnabledRef.current && historyRecoveryOwnerRef.current === ownerId && renameScopeRef.current === mountedScope && projectEpochRef.current === epoch && activeProjectIdRef.current === projectId }
    const pending = historyPendingRef.current
    setDraftActionBusy(true)
    try {
      const content = serializeWorkflow(workflowSnapshot())
      const retainedDraft = draftOwnerId ? persistBrowserDraft(activeProject, content) : null
      if (draftOwnerId && !retainedDraft) {
        throw new Error('当前编辑还未保存在本地，请先导出当前内容，再重新读取云端')
      }
      if (retainedDraft) assertCanvasBrowserDraftStored(window.localStorage, retainedDraft)
      const nextWriter = retainedDraft ? buildCanvasBrowserDraftWriterRotation(draftWriterIdRef.current, crypto.randomUUID()) : null
      let resolvedRecovery: ProjectHistoryRecoveryRecord | undefined
      if (resolveHistory && pending?.record) {
        const inspect = hostBridge().inspectProjectRestore
        if (!inspect) throw new Error('当前宿主尚未提供原恢复核对，记录仍保留')
        const inspection = await inspect(projectId, pending.input)
        if (!current() || historyPendingRef.current !== pending) throw new Error('工程或账号已经变化，原云端读取已停止；本机草稿仍保留')
        if (inspection.state === 'missing') { historyMissingRef.current = pending; setHistoryPendingState('missing'); throw new Error('服务器仍未找到原恢复操作，当前只核对了结果；请在版本历史中明确按原编号重试') }
        resolvedRecovery = pending.record
      }
      if (!current()) throw new Error('工程或账号已经变化，原云端读取已停止；本机草稿仍保留')
      const open = () => openStoredProject(projectId, { skipDraftRecovery: true, ...(resolvedRecovery ? { resolvedRecovery } : {}) })
      const opened = resolvedRecovery ? await withProjectHistoryRecoveryLock(resolvedRecovery.ownerId, projectId, current, open) : await open()
      if (!opened) throw new Error('云端工程读取失败，当前编辑和本地草稿仍保留，请稍后重试')
      if (nextWriter) {
        draftWriterIdRef.current = nextWriter.writerId
        draftRevisionSequenceRef.current = nextWriter.revisionSequence
        browserDraftRef.current = null
      }
      setBanner('已重新读取云端工程，之前的编辑草稿仍保留')
    } catch (error) {
      if (draftActionsEnabledRef.current && historyRecoveryOwnerRef.current === ownerId && renameScopeRef.current === mountedScope && activeProjectIdRef.current === projectId) setBanner(error instanceof Error ? error.message : '云端工程读取失败，当前编辑仍保留')
    }
    finally { if (historyRecoveryOwnerRef.current === ownerId && renameScopeRef.current === mountedScope) setDraftActionBusy(false) }
  }, [activeProject, draftActionBusy, draftOwnerId, creationOwnerId, nodes, edges, viewport, mediaGroups, persistBrowserDraft, openStoredProject])

  const returnToProjectCenter = useCallback(async () => {
    if (!activeProject || projectTransitionRef.current) return
    if (!projectCanEditRef.current) { window.dispatchEvent(new CustomEvent('xingmang:project-closed')); return }
    if (pendingRunProjectionIdsRef.current.size > 0) {
      setBanner('运行结果尚未回填，请刷新运行历史后再返回项目中心')
      return
    }
    if (running || startingRunsRef.current > 0 || resumingTaskIds.size > 0) {
      setBanner('当前任务尚未结束，请等待任务结束后再返回项目中心')
      return
    }
    const revision = autoSaveRevisionRef.current + 1
    autoSaveRevisionRef.current = revision
    projectTransitionRef.current = true
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current)
      autosaveTimerRef.current = null
    }
    setProjectTransition(true)
    setAutoSaveState('saving')
    try {
      await queueProjectSave(activeProject, serializeWorkflow(workflowSnapshot()), revision)
      runsRequestRevisionRef.current += 1
      pendingRunProjectionIdsRef.current.clear()
      runInputGraphsRef.current.clear()
      activeRunsRef.current.clear()
      runWaitingBannerRef.current = null
      setRunning(false)
      projectEpochRef.current += 1
      autoSaveRevisionRef.current += 1
      setActiveProject(null)
      if (projectPaginationEnabled) void refreshProjects()
      activeProjectIdRef.current = null
      browserUnsavedRef.current = false
      setDirtyNodeIds(new Set())
      window.dispatchEvent(new CustomEvent('xingmang:project-closed'))
      projectHydrationRef.current = false
      applyProjectUiPreferences({ ...defaultCanvasUiPreferences })
    } catch (error) {
      setAutoSaveState('failed')
      setBanner(canvasAutosaveErrorMessage(error))
    } finally {
      projectTransitionRef.current = false
      setProjectTransition(false)
    }
  }, [activeProject, applyProjectUiPreferences, nodes, edges, viewport, mediaGroups, queueProjectSave, running, resumingTaskIds, projectPaginationEnabled, refreshProjects])

  const prepareWorkflowDocument = async (workflow: WorkflowFile): Promise<{
    document: CanvasDocumentState
    warnings: string[]
  } | null> => {
    // Hydration is local. Source reads belong to the background effect and
    // cannot delay opening, importing, editing or saving a document.
    mediaPreparationRevisionRef.current += 1
    settledMediaSignaturesRef.current = {}
    appliedMediaSignatureRef.current = ''
    // A same-source import may batch both transition state updates into one
    // render; its replacement document still requires fresh preparation.
    mediaRetryRevisionRef.current += 1
    setMediaRetryRevision(mediaRetryRevisionRef.current)
    const warnings = groupsRef.current.length === 0 ? ['工作流可编辑和保存；真实模型尚未接入，生成前请配置来源'] : []
    return { document: workflowDocument(workflow), warnings }
  }

  const save = async () => {
    try {
      const workflow = workflowSnapshot()
      const result = await hostBridge().exportProject('xingmang-project.xingcanvas', serializeWorkflow(workflow), activeProject ? { projectId: activeProject.id } : undefined)
      if (result) setBanner(workflowSavedNotice(canvasCapabilities().host))
    } catch (error) {
      setBanner(`工作流保存失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const exportLocalDraft = async (draft: CanvasBrowserDraft) => {
    if (!draftDialogScope || !isSameCanvasDraftActionScope(draftDialogScope, currentDraftActionScope()) || !draftActionsEnabledRef.current) return
    const token = draftLocalActionGuard.current.begin(currentDraftActionScope())
    if (!token) return
    setDraftLocalActionBusy(true)
    function current() { return draftLocalActionGuard.current.current(token, currentDraftActionScope(), draftActionsEnabledRef.current) }
    try {
      assertCanvasBrowserDraftStored(window.localStorage, draft)
      const workflow = parseWorkflowFile(draft.content)
      if (!workflow) throw new Error('本地草稿内容无法读取，请保留浏览器数据后重试')
      const result = await hostBridge().exportProject('xingmang-local-draft.xingcanvas', serializeWorkflow(workflow), { projectId: draft.projectId })
      if (result && current()) setDraftDialogNotice('已请求下载选中的本地草稿，原草稿仍保留；素材文件需在素材库单独下载。')
    } catch (error) { if (current()) setDraftDialogError(error instanceof Error ? error.message : '本地草稿导出失败，请稍后重试') }
    finally {
      const active = current()
      draftLocalActionGuard.current.finish(token)
      if (active) setDraftLocalActionBusy(false)
    }
  }

  const exportProject = async () => {
    const workflow = workflowSnapshot()
    try {
      const result = window.xingmangCanvasHost
        ? await hostBridge().exportProject('xingmang-project.xingcanvas', serializeWorkflow(workflow), activeProject ? { projectId: activeProject.id } : undefined)
        : await hostBridge().saveFile('xingmang-project.xingcanvas', serializeWorkflow(workflow))
      if (result) setBanner(workflowExportedNotice(canvasCapabilities().host))
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error))
    }
  }

  function clearProjectExportState() {
    setProjectExportOpen(false)
    setProjectExportPreview(null)
    setProjectExportPreparing(false)
    setProjectExportBusy(false)
    setProjectExportError(null)
    setProjectExportBlocked(false)
    setProjectExportProgress(undefined)
    setProjectExportAllowExternal(false)
    projectTransitionRef.current = false
    setProjectTransition(false)
  }

  function cancelProjectExport() {
    const pending = pendingProjectExportRef.current
    if (!pending) return
    pendingProjectExportRef.current = null
    projectExportGuard.current.cancel()
    pending.cancel(pending.preview?.previewId)
    clearProjectExportState()
    setBanner('已停止准备项目包。当前画布与素材仍保留；已经交给浏览器的下载不能撤销。')
  }

  async function previewProjectExport(scopeNodeIds?: readonly string[]): Promise<void> {
    if (projectTransitionRef.current || draftActionBusy || draftRecoveryPendingRef.current) return
    const bridge = hostBridge()
    if (!activeProject || !bridge.previewProjectExport || !bridge.exportProjectPackage || !bridge.cancelProjectExport) {
      setBanner('当前宿主尚未接入携素材项目导出，可以使用“导出工作流”单独保存画布。')
      return
    }
    let captured: WorkflowFile
    try { captured = scopeNodeIds ? buildResourceExportWorkflow(workflowSnapshot(), scopeNodeIds) : workflowSnapshot() }
    catch (error) { setBanner(error instanceof Error ? error.message : '选区无法导出'); return }
    const token = projectExportGuard.current.begin({ projectId: activeProject.id, projectEpoch: projectEpochRef.current })
    if (!token) return
    const pending: NonNullable<typeof pendingProjectExportRef.current> = { token, cancel: bridge.cancelProjectExport.bind(bridge), exportPackage: bridge.exportProjectPackage.bind(bridge), exporting: false }
    pendingProjectExportRef.current = pending
    projectTransitionRef.current = true
    setProjectTransition(true)
    setProjectExportOpen(true)
    setProjectExportPreparing(true)
    setProjectExportBusy(false)
    setProjectExportPreview(null)
    setProjectExportError(null)
    setProjectExportBlocked(false)
    setProjectExportProgress(undefined)
    setProjectExportAllowExternal(false)
    try {
      const preview = await bridge.previewProjectExport(serializeWorkflow(captured))
      if (pendingProjectExportRef.current !== pending || !projectExportGuard.current.current(token, { projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current })) { pending.cancel(preview.previewId); return }
      buildProjectExportPresentation(preview)
      pending.preview = preview
      setProjectExportPreview(preview)
    } catch (error) {
      if (pendingProjectExportRef.current === pending && projectExportGuard.current.current(token, { projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current })) {
        setProjectExportError(projectExportFailureMessage(error))
        setProjectExportBlocked(projectExportAccountChanged(error))
      }
    } finally {
      if (pendingProjectExportRef.current === pending && projectExportGuard.current.current(token, { projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current })) setProjectExportPreparing(false)
    }
  }

  async function confirmProjectExport(): Promise<void> {
    const candidate = pendingProjectExportRef.current
    if (!candidate || !candidate.preview || candidate.exporting || projectExportBlocked) return
    const pending = candidate
    const preview = candidate.preview
    const summary = buildProjectExportPresentation(preview)
    if (!summary.canExport || summary.needsExternalConsent && !projectExportAllowExternal) return
    function current() { return pendingProjectExportRef.current === pending && projectExportGuard.current.current(pending.token, { projectId: activeProjectIdRef.current, projectEpoch: projectEpochRef.current }) }
    if (!current()) { cancelProjectExport(); return }
    pending.exporting = true
    setProjectExportBusy(true)
    setProjectExportError(null)
    setProjectExportProgress(undefined)
    try {
      const result = await pending.exportPackage(preview.previewId, { allowExternalReferences: projectExportAllowExternal }, (progress) => { if (current()) setProjectExportProgress(progress) })
      if (!current()) return
      pendingProjectExportRef.current = null
      projectExportGuard.current.finish(pending.token)
      pending.cancel(preview.previewId)
      clearProjectExportState()
      setBanner(`已请求浏览器下载“${result.fileName}”，携带 ${result.embeddedAssetCount} 项素材${result.externalReferenceCount ? `；保留 ${result.externalReferenceCount} 个未携带文件的引用` : ''}。请在浏览器下载记录核对。`)
    } catch (error) {
      if (current()) {
        setProjectExportError(projectExportFailureMessage(error))
        setProjectExportBlocked(projectExportAccountChanged(error))
      }
    } finally {
      pending.exporting = false
      if (current()) setProjectExportBusy(false)
    }
  }

  function retainCurrentImportDraft(): void {
    const snapshot = latestBrowserSnapshotRef.current
    if (snapshot?.content === null) throw new Error(snapshot.errorMessage)
    if (!snapshot || (snapshot.content === lastConfirmedContentRef.current && !saveConflictRef.current)) return
    if (!draftOwnerId || !persistBrowserDraft(snapshot.project, snapshot.content)) throw new Error('当前编辑还未保存在本地，请先导出当前工作流，再导入文件；当前画布仍保留')
  }

  function previewProjectImport(preview: ProjectImportPreview, projectEpoch: number) {
    if (projectEpochRef.current !== projectEpoch) throw new Error('工程已经重新打开，此文件预览已停止；当前画布仍保留，请重新选择文件。')
    buildProjectImportPresentation(preview)
    pendingProjectImportRef.current = { preview, projectEpoch }
    setProjectImportPreview(preview)
    setProjectImportError(null)
    setProjectImportBlocked(false)
    setProjectImportProgress(undefined)
  }

  function cancelProjectImport() {
    if (projectImportGuard.current.busy()) return
    const preview = pendingProjectImportRef.current?.preview
    if (preview) hostBridge().discardProjectImport?.(preview.previewId)
    pendingProjectImportRef.current = null
    projectImportGuard.current.invalidate()
    setProjectImportPreview(null)
    setProjectImportError(null)
    setProjectImportProgress(undefined)
    setProjectImportBlocked(false)
    projectTransitionRef.current = false
    setProjectTransition(false)
    setBanner('已取消导入；如有素材已经上传，可到素材库核对。当前画布仍保留。')
  }

  function openImportRecovery() {
    if (projectTransitionRef.current || draftActionBusy || draftRecoveryPendingRef.current || !draftActionsEnabledRef.current) return
    setMoreActionsOpen(false)
    setProjectImportRecoveryEpoch(projectEpochRef.current)
  }

  function assertImportRecoveryCurrent() {
    if (projectImportRecoveryEpoch === null || projectImportRecoveryEpoch !== projectEpochRef.current || !draftActionsEnabledRef.current) throw new Error('账户或画布已变化，请重新打开导入恢复；当前编辑仍保留。')
  }

  async function openRecoveredImport(projectId: string) {
    assertImportRecoveryCurrent()
    if (projectTransitionRef.current || draftActionBusy || draftRecoveryPendingRef.current) throw new Error('当前画布仍有操作待完成，请稍后打开原工程。')
    retainCurrentImportDraft()
    projectTransitionRef.current = true
    setProjectTransition(true)
    const revision = projectRequestRevisionRef.current + 1
    try {
      const opened = await openStoredProject(projectId)
      if (projectRequestRevisionRef.current !== revision) return
      setProjectImportRecoveryEpoch(projectEpochRef.current)
      if (!opened) throw new Error('原工程已确认，但读取尚未完成；当前画布与草稿仍保留，请重试打开。')
      const route = new URL(window.location.href)
      route.searchParams.set('project', projectId); route.searchParams.delete('template')
      window.history.replaceState(window.history.state, '', `${route.pathname}${route.search}${route.hash}`)
      setProjectImportRecoveryEpoch(null)
      setBanner('已打开原导入工程。原画布的未保存编辑仍保留在本地草稿。')
    } finally { projectTransitionRef.current = false; setProjectTransition(false) }
  }

  async function confirmProjectImport(): Promise<void> {
    const candidate = pendingProjectImportRef.current
    if (!candidate || projectImportBlocked) return
    const pending = candidate
    const requestToken = projectImportGuard.current.begin()
    if (requestToken === null) return
    const token = requestToken
    const preview = pending.preview
    const cloud = preview.createsProject === true
    const missing = preview.missingAssetCount ?? 0
    function current() { return projectImportGuard.current.current(token) && pendingProjectImportRef.current === pending && projectEpochRef.current === pending.projectEpoch }
    setProjectImportBusy(true)
    setProjectImportError(null)
    try {
      if (!current()) throw new Error('工程已经重新读取，旧导入已停止。请从项目中心核对原导入结果；当前画布仍保留。')
      retainCurrentImportDraft()
      const result = await hostBridge().importProject(preview.previewId, { missingAssets: preview.originalImportPolicy ?? (missing ? 'drop' : 'reject') }, (progress) => { if (current()) setProjectImportProgress(progress) })
      if (!current()) return
      if (cloud) {
        if (!result.projectId) throw new Error('导入结果缺少新工程编号，请从项目中心核对；当前画布与草稿仍保留')
        // Inputs that finished loading while the modal was open still need a draft.
        retainCurrentImportDraft()
        const openRevision = projectRequestRevisionRef.current + 1
        const opened = await openStoredProject(result.projectId)
        if (!projectImportGuard.current.current(token) || pendingProjectImportRef.current !== pending || projectRequestRevisionRef.current !== openRevision) return
        // Our own open attempt advances the epoch even on a read failure. A retry
        // may read the same created project, but cannot absorb a foreign reopen.
        pending.projectEpoch = projectEpochRef.current
        if (!opened) throw new Error('新工程已经创建，但尚未打开。可继续核对同一次导入，或从项目中心打开新工程；原画布与草稿仍保留。')
        const route = new URL(window.location.href)
        route.searchParams.set('project', result.projectId)
        route.searchParams.delete('template')
        window.history.replaceState(window.history.state, '', `${route.pathname}${route.search}${route.hash}`)
        void refreshAssets()
        setBanner(`已导入为新工程${result.warnings.length ? `；${result.warnings.join('；')}` : ''}`)
      } else {
        const workflow = parseWorkflowFile(result.content)
        if (!workflow) throw new Error('导入项目中的工作流无法读取；当前画布与草稿仍保留')
        const prepared = await prepareWorkflowDocument(workflow)
        if (!prepared || !current()) return
        retainCurrentImportDraft()
        execute({ type: 'replace-document', document: prepared.document })
        restoreCanvasViewport(prepared.document.viewport)
        const warnings = [...result.warnings, ...prepared.warnings]
        setBanner(`已导入工作流${warnings.length ? `；${warnings.join('；')}` : ''}`)
      }
      void refreshAssets()
      pendingProjectImportRef.current = null
      setProjectImportPreview(null)
      hostBridge().discardProjectImport?.(preview.previewId)
    } catch (error) {
      if (projectImportGuard.current.current(token) && pendingProjectImportRef.current === pending) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'PROJECT_IMPORT_RECOVERY_REQUIRED') {
          hostBridge().discardProjectImport?.(preview.previewId)
          pendingProjectImportRef.current = null; setProjectImportPreview(null); setProjectImportRecoveryEpoch(projectEpochRef.current)
        }
        setProjectImportError(projectImportFailureMessage(error))
        setProjectImportBlocked(projectImportAccountChanged(error) || projectEpochRef.current !== pending.projectEpoch)
      }
    } finally {
      projectImportGuard.current.finish(token)
      if (projectImportGuard.current.current(token)) {
        setProjectImportBusy(false)
        if (!pendingProjectImportRef.current) { projectTransitionRef.current = false; setProjectTransition(false) }
      }
    }
  }

  const importProject = async () => {
    if (!projectCanEditRef.current) return
    if (projectTransitionRef.current || draftActionBusy || draftRecoveryPendingRef.current) return
    const token = projectImportGuard.current.begin()
    if (token === null) return
    const projectEpoch = projectEpochRef.current
    projectTransitionRef.current = true
    setProjectTransition(true)
    try {
      const preview = await hostBridge().previewProject()
      if (preview && projectImportGuard.current.current(token)) previewProjectImport(preview, projectEpoch)
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'PROJECT_IMPORT_RECOVERY_REQUIRED') setProjectImportRecoveryEpoch(projectEpochRef.current)
      setBanner(error instanceof Error ? error.message : String(error))
    }
    finally { projectImportGuard.current.finish(token); if (projectImportGuard.current.current(token) && !pendingProjectImportRef.current) { projectTransitionRef.current = false; setProjectTransition(false) } }
  }

  const load = async () => {
    if (!projectCanEditRef.current) return
    if (projectTransitionRef.current || draftActionBusy || draftRecoveryPendingRef.current) return
    const token = projectImportGuard.current.begin()
    if (token === null) return
    const projectEpoch = projectEpochRef.current
    projectTransitionRef.current = true
    setProjectTransition(true)
    try {
      const bridge = hostBridge()
      const picked = await bridge.pickFile()
      if (!picked) return
      if (bridge.previewWorkflowContent) {
        const preview = await bridge.previewWorkflowContent(picked.content, picked.name)
        if (projectImportGuard.current.current(token)) previewProjectImport(preview, projectEpoch)
        return
      }
      const project = parseXingCanvasProject(picked.content)
      const workflow = project?.workflow ?? parseWorkflowFile(picked.content)
      if (!workflow) throw new Error('无法读取该文件：不是有效的星芒工作流')
      const prepared = await prepareWorkflowDocument(workflow)
      if (!prepared) return
      retainCurrentImportDraft()
      execute({ type: 'replace-document', document: prepared.document })
      restoreCanvasViewport(prepared.document.viewport)
      const warnings = [...(project?.warnings ?? []), ...prepared.warnings]
      setBanner(warnings.length ? `已打开「${workflow.name}」；${warnings.join('；')}` : `已打开「${workflow.name}」`)
    } catch (error) { setBanner(error instanceof Error ? error.message : String(error)) }
    finally { projectImportGuard.current.finish(token); if (projectImportGuard.current.current(token) && !pendingProjectImportRef.current) { projectTransitionRef.current = false; setProjectTransition(false) } }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (runPreflight || closeBusyRef.current || projectTransitionRef.current || draftRecoveryPendingRef.current || draftActionBusy) return
      const shortcut = resolveCanvasShortcut(event, { modalOpen: canvasModalOpen() })
      if (!shortcut) return
      if (!projectCanEditRef.current && !['save', 'copy', 'find-node', 'select-all', 'toggle-overview', 'toggle-assets'].includes(shortcut)) { event.preventDefault(); return }
      if (shortcut === 'undo') { event.preventDefault(); undo() }
      else if (shortcut === 'redo') { event.preventDefault(); redo() }
      else if (shortcut === 'save') { event.preventDefault(); void save() }
      else if (shortcut === 'open') { event.preventDefault(); void load() }
      else if (shortcut === 'run') { event.preventDefault(); void run() }
      else if (shortcut === 'layout') { event.preventDefault(); autoLayout() }
      else if (shortcut === 'toggle-assets') { event.preventDefault(); toggleAssetTray() }
      else if (shortcut === 'toggle-overview') { event.preventDefault(); toggleCanvasOverview() }
      else if (shortcut === 'quick-insert') {
        event.preventDefault()
        if (quickInsert) {
          setQuickInsert(null)
          return
        }
        const bounds = document.querySelector('.canvas-flow')?.getBoundingClientRect()
        if (!bounds) return
        setMediaConfigOpen(false)
        setMoreActionsOpen(false)
        setRunMenuOpen(false)
        setNodeSearchOpen(false)
        const client = { x: bounds.left + bounds.width / 2, y: bounds.top + Math.min(bounds.height * 0.38, 320) }
        setQuickInsert({
          anchor: { x: Math.max(12, Math.min(bounds.width - 372, client.x - bounds.left - 180)), y: Math.max(12, Math.min(bounds.height - 430, client.y - bounds.top - 70)) },
          flowPosition: reactFlow.screenToFlowPosition(client),
        })
      }
      // Native copy/paste events provide synchronous clipboard access under the
      // keyboard gesture. Preventing keydown would suppress those events.
      else if (shortcut === 'copy' || shortcut === 'paste') return
      else if (shortcut === 'duplicate') { event.preventDefault(); duplicateNodes(nodes.filter((node) => node.selected).map((node) => node.id)) }
      else if (shortcut === 'group') { event.preventDefault(); groupSelection() }
      else if (shortcut === 'ungroup') { event.preventDefault(); ungroupSelection() }
      else if (shortcut === 'find-node') {
        event.preventDefault()
        setQuickInsert(null)
        setMoreActionsOpen(false)
        setRunMenuOpen(false)
        setMediaConfigOpen(false)
        setNodeSearchOpen(true)
      }
      else if (shortcut === 'select-all') {
        event.preventDefault()
        setNodes((current) => current.map((node) => ({ ...node, selected: true })))
      } else if (shortcut === 'delete') {
        const selectedNodes = nodes.filter((node) => node.selected).map((node) => node.id)
        const selectedEdges = edges.filter((edge) => edge.selected).map((edge) => edge.id)
        if (!selectedNodes.length && !selectedEdges.length) return
        event.preventDefault()
        // Only bridge when nodes alone are removed. Deleting an edge on purpose
        // must not be undone by a bridge that puts an equivalent one back.
        const bridges = selectedEdges.length === 0
          ? bridgeEdgesForRemoval(edges, selectedNodes).map((draft) => ({ id: nextNodeId(), ...draft }))
          : []
        execute({
          type: 'delete-elements',
          nodeIds: selectedNodes,
          edgeIds: selectedEdges,
          ...(bridges.length > 0 ? { bridges } : {}),
        })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undo, redo, save, load, run, autoLayout, toggleAssetTray, toggleCanvasOverview, duplicateNodes, groupSelection, ungroupSelection, nodes, edges, execute, setNodes, quickInsert, reactFlow, runPreflight, draftActionBusy])

  const serverBacked = Boolean(window.xingmangCanvasHost)
  const visiblePendingMediaKinds = [...new Set([...pendingMediaKinds, ...currentPendingMediaKinds()])]
  let activeRunHasPendingMedia = false
  if (serverBacked && !activeRunOption.disabled) {
    try {
      const scope = currentRunScope()
      const preflight = buildCanvasRunPreflight({ capabilities: canvasCapabilities(), sourceCatalog: nodeSourceCatalogRef.current,
        imageAssetDimensions,
        graph: toCanvasRunGraph(nodes, edges, { image: imageGroup ?? '', video: videoGroup ?? '', videoProtocol, text: textGroup ?? '', imageModel: mediaGroups.imageModel, videoModel: mediaGroups.videoModel, textModel: mediaGroups.textModel }, nodeSourceCatalogRef.current),
        scope, cachedNodeIds: cachedNodeIdsForPreflight(nodes, scope), imageGroup: imageGroup ?? undefined, videoGroup: videoGroup ?? undefined, textGroup: textGroup ?? undefined,
        imageModels: mediaModelsRef.current.image, videoModels: mediaModelsRef.current.video, textModels: mediaModelsRef.current.text,
        nodeBlockReasons: dramaPreflightBlockReasons(nodes, edges),
      })
      activeRunHasPendingMedia = pendingCanvasMediaRunKinds(preflight, currentPendingMediaKinds(), mediaGroupsRef.current).length > 0
    } catch { /* The normal run preflight presents graph validation errors. */ }
  }
  const mediaConnectionLabel = projectAccessState?.denied ? '项目权限已撤销；已停止来源读取' : projectAccessState?.access?.canRun === false
    ? `${projectAccessState.access.canEdit ? '协作编辑' : '协作查看'}；生成由项目所有者运行`
    : visiblePendingMediaKinds.length > 0
    ? `正在后台核对${visiblePendingMediaKinds.map((kind) => ({ image: '生图', video: '视频', text: '文字' })[kind]).join('、')}来源；画布可继续编辑和保存`
    : `图片 · ${canvasGroupDisplayName(imageGroup, groups)} / 视频 · ${canvasGroupDisplayName(videoGroup, groups)} / 文字 · ${canvasGroupDisplayName(textGroup, groups)}`
  const toggleMediaConfiguration = () => {
    setMoreActionsOpen(false)
    setRunMenuOpen(false)
    setQuickInsert(null)
    setMediaConfigOpen((open) => !open)
  }

  useEffect(() => {
    if (!moreActionsOpen && !runMenuOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return
      if (moreActionsOpen && !moreActionsRef.current?.contains(event.target)) setMoreActionsOpen(false)
      if (runMenuOpen && !runMenuRef.current?.contains(event.target)) setRunMenuOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (canvasKeyboardEventBlocked(event, { modalOpen: canvasModalOpen() })) return
      if (event.key === 'Escape') {
        if (runMenuOpen) {
          setRunMenuOpen(false)
          runMenuTriggerRef.current?.focus()
        }
        if (moreActionsOpen) {
          setMoreActionsOpen(false)
          moreActionsTriggerRef.current?.focus()
        }
        return
      }
      if (!runMenuOpen || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const items = [...(runMenuRef.current?.querySelectorAll<HTMLButtonElement>('.canvas-run-menu button:not(:disabled)') ?? [])]
      if (items.length === 0) return
      event.preventDefault()
      const current = items.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? items.length - 1
          : event.key === 'ArrowDown' ? (current + 1 + items.length) % items.length
            : (current - 1 + items.length) % items.length
      items[next]?.focus()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [moreActionsOpen, runMenuOpen])

  useEffect(() => {
    if (!runMenuOpen) return
    const frame = window.requestAnimationFrame(() => {
      runMenuRef.current?.querySelector<HTMLButtonElement>('.canvas-run-menu button[aria-checked="true"]:not(:disabled), .canvas-run-menu button:not(:disabled)')?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [runMenuOpen])

  useEffect(() => {
    if (!projectCanEdit || !window.xingmangCanvasHost || !activeProject || closeBusyRef.current || projectTransitionRef.current || saveConflictRef.current || draftRecoveryPendingRef.current) return
    if (collaborationState?.phase === 'busy' && collaborationRef.current?.needsOperationSave()) return
    if (workflowSerialization.content === null) return
    const content = workflowSerialization.content
    const parts = {
      mediaGroups: { ...mediaGroups },
      nodes: nodes.map(toWorkflowNode),
      edges: edges.map(toWorkflowEdge),
    }
    const signature = JSON.stringify([canvasAutosaveSignature(parts), viewport])
    const graphSignature = canvasAutosaveGraphSignature(parts)
    if (projectHydrationRef.current) {
      projectHydrationRef.current = false
      lastAutosaveSignatureRef.current = signature
      lastAutosaveGraphSignatureRef.current = graphSignature
      setAutoSaveState('saved')
      return
    }
    if (signature === lastAutosaveSignatureRef.current) {
      let cancelled = false
      const epoch = projectEpochRef.current
      // Undo can cancel an unsent debounce and return to the confirmed document.
      // Wait for older writes so an in-flight change cannot be called saved.
      void projectSaveChainRef.current.then(() => {
        if (cancelled || projectEpochRef.current !== epoch || !projectCanEditRef.current || closeBusyRef.current || projectTransitionRef.current || saveConflictRef.current || draftRecoveryPendingRef.current) return
        const latest = latestBrowserSnapshotRef.current
        if (!latest || latest.project.id !== activeProject.id || latest.content !== content || canvasWorkflowSnapshotNeedsSave(latest, lastConfirmedContentRef.current)) return
        setAutoSaveState((current) => current === 'pending' ? 'saved' : current)
      })
      return () => { cancelled = true }
    }
    const revision = autoSaveRevisionRef.current + 1
    autoSaveRevisionRef.current = revision
    const showProgress = graphSignature !== lastAutosaveGraphSignatureRef.current
    const timeout = window.setTimeout(() => {
      autosaveTimerRef.current = null
      if (closeBusyRef.current || projectTransitionRef.current) return
      const latest = latestBrowserSnapshotRef.current
      if (!latest || latest.project.id !== activeProject.id || latest.content !== content) return
      if (showProgress) setAutoSaveState('saving')
      void queueProjectSave(activeProject, content, revision)
        .then(() => {
          if (autoSaveRevisionRef.current !== revision) return
          lastAutosaveSignatureRef.current = signature
          lastAutosaveGraphSignatureRef.current = graphSignature
        })
        .catch((error) => {
          if (autoSaveRevisionRef.current !== revision) return
          setAutoSaveState('failed')
          setBanner(canvasAutosaveErrorMessage(error))
        })
    }, 800)
    autosaveTimerRef.current = timeout
    return () => {
      window.clearTimeout(timeout)
      if (autosaveTimerRef.current === timeout) autosaveTimerRef.current = null
    }
  }, [projectCanEdit, collaborationState?.phase, activeProject?.id, activeProject?.name, nodes, edges, viewport, mediaGroups, workflowSerialization, queueProjectSave, closePhase, projectTransition, draftRecovery, saveConflict])

  const closeOperationsRef = useRef<{ hasPendingWork(): boolean; saveLatest(): Promise<void> }>({
    hasPendingWork: () => false,
    saveLatest: async () => {},
  })
  closeOperationsRef.current = {
    hasPendingWork: () => running || startingRuns > 0 || pendingRunProjectionIdsRef.current.size > 0 || projectTransition || resumingTaskIdsRef.current.size > 0 || projectLoading || runsLoading,
    saveLatest: async () => {
      if (!activeProject || !projectCanEditRef.current) { await projectSaveChainRef.current; return }
      const revision = autoSaveRevisionRef.current + 1
      autoSaveRevisionRef.current = revision
      setAutoSaveState('saving')
      try {
        await queueProjectSave(activeProject, serializeWorkflow(workflowSnapshot()), revision)
      } catch (error) {
        setAutoSaveState('failed')
        throw error
      }
    },
  }
  useEffect(() => {
    const host = window.xingmangCanvasHost
    if (typeof host?.onCloseRequested !== 'function' || typeof host.finishClose !== 'function') return
    const guard = createCanvasCloseGuard({
      hasPendingWork: () => closeOperationsRef.current.hasPendingWork(),
      hasPendingDraft: () => projectCenterDraftRef.current,
      chooseAction: () => new Promise((resolve) => { closeChoiceRef.current = resolve }),
      dismissChoice: () => { closeChoiceRef.current?.('cancel'); closeChoiceRef.current = null },
      stopPendingWork: async (requestId) => {
        const accepted = await host.cancelCloseTasks(requestId)
        if (accepted) abortRef.current?.abort()
        return accepted
      },
      saveLatest: () => closeOperationsRef.current.saveLatest(),
      finishClose: (requestId, allowed) => host.finishClose(requestId, allowed),
      onPhase: (phase) => {
        closeBusyRef.current = phase !== null
        if (phase && autosaveTimerRef.current !== null) {
          window.clearTimeout(autosaveTimerRef.current)
          autosaveTimerRef.current = null
        }
        if (!phase) closeRequestRef.current = null
        setClosePhase(phase)
      },
      onError: (error) => setBanner(`未关闭画布：${error instanceof Error ? error.message : String(error)}`),
    })
    closeGuardRef.current = guard
    const unsubscribeRequest = host.onCloseRequested(({ requestId }) => {
      const request = guard.request(requestId)
      closeRequestRef.current = requestId
      void request
    })
    const unsubscribeCancel = host.onCloseCancelled(({ requestId }) => guard.cancel(requestId))
    return () => { unsubscribeRequest(); unsubscribeCancel(); guard.dispose(); closeGuardRef.current = null }
  }, [])

  const closeDialog = closePhase ? createPortal(<CanvasCloseDialog phase={closePhase}
    onChoose={(choice) => { closeChoiceRef.current?.(choice); closeChoiceRef.current = null }}
    onCancel={() => {
      const requestId = closeRequestRef.current
      if (!requestId) return
      closeGuardRef.current?.cancel(requestId)
      void hostBridge().finishClose(requestId, false).catch((error) => setBanner(error instanceof Error ? error.message : String(error)))
    }} />, document.body) : null

  const historyRestoreBlocked = !projectCanRestore ? '只有项目拥有者可以恢复版本，协作者可预览共享期间的历史。' : saveConflict && !historyPendingRef.current ? '当前工程存在保存冲突，请先保留草稿并重新读取云端。'
    : draftRecovery !== null ? '请先选择本地草稿的处理方式，再恢复历史版本。'
      : running || startingRuns > 0 || resumingTaskIds.size > 0 || pendingRunProjectionIdsRef.current.size > 0 ? '请等待当前任务结束并完成结果回填，再恢复版本。' : null
  const historyDialog = historyCurrent && activeProject ? createPortal(<ProjectHistoryDialog
    key={`${historyScope!.projectId}:${historyScope!.dialogEpoch}`}
    shared={projectAccessState?.access?.mode === 'view' || projectAccessState?.access?.mode === 'edit'}
    projectId={activeProject.id} name={activeProject.name} cloudVersion={activeProject.version ?? 0}
    bridge={hostBridge()} busy={historyBusy || draftActionBusy} error={historyError}
    pendingRevisionId={historyPendingRef.current?.projectId === activeProject.id ? historyPendingRef.current.input.revisionId : undefined}
    pendingOperationId={historyPendingRef.current?.projectId === activeProject.id ? historyPendingRef.current.input.operationId : undefined}
    pendingState={historyPendingState} restoreBlocked={historyRestoreBlocked} returnFocus={moreActionsTriggerRef.current}
    onRestore={(detail) => { void restoreProjectHistory(detail) }} onRetry={() => { void restoreProjectHistory() }} onRetryMissing={() => { void restoreProjectHistory(undefined, true) }}
    onReload={() => { void reloadCloudProject(historyPendingState === 'changed' || historyPendingState === 'completed') }} onClose={closeProjectHistory}
  />, document.body) : null

  const draftDialogCurrent = Boolean(draftActionsEnabled && draftDialogScope && isSameCanvasDraftActionScope(draftDialogScope, currentDraftActionScope()))
  const protectingDraft = protectedLocalDraft()
  const recoveryDialog = draftRecovery && activeProject && draftDialogCurrent ? createPortal(<BrowserDraftRecovery
    drafts={draftRecovery}
    cloudVersion={activeProject.version ?? 0}
    selected={selectedDraft}
    mode={draftDialogMode}
    busy={draftLocalActionBusy}
    confirmation={draftConfirmation?.draft}
    protectedSelection={protectingDraft ? { writerId: protectingDraft.writerId, revision: protectingDraft.revision } : null}
    returnFocus={draftDialogMode === 'manage' ? draftReturnFocusRef.current : undefined}
    listAvailable={draftListAvailable}
    storageError={draftDialogError ?? draftStorageError}
    notice={draftDialogNotice}
    onSelect={(selection) => { setSelectedDraft(selection); cancelLocalDraftRemoval(); setDraftDialogNotice(null) }}
    onRestore={restoreLocalDraft}
    onUseCloud={useCloudDocument}
    onExport={(draft) => void exportLocalDraft(draft)}
    onRequestRemove={requestLocalDraftRemoval}
    onConfirmRemove={confirmLocalDraftRemoval}
    onCancelRemove={cancelLocalDraftRemoval}
    onClose={closeLocalDraftManager}
    onRefresh={() => { if (!draftLocalActionGuard.current.busy()) refreshLocalDraftManager() }}
  />, document.body) : null

  const projectImportDialog = projectImportPreview ? createPortal(<CanvasProjectImportDialog preview={projectImportPreview} busy={projectImportBusy} error={projectImportError} blocked={projectImportBlocked} progress={projectImportProgress} onCancel={cancelProjectImport} onConfirm={() => void confirmProjectImport()} />, document.body) : null
  const projectImportRecoveryDialog = projectImportRecoveryEpoch !== null && hostBridge().projectImportRecovery ? createPortal(<ProjectImportRecoveryDialog appearance="canvas" port={hostBridge().projectImportRecovery!} onClose={() => setProjectImportRecoveryEpoch(null)} onOpen={openRecoveredImport} onPreview={(preview) => {
    assertImportRecoveryCurrent()
    previewProjectImport(preview, projectEpochRef.current)
    projectTransitionRef.current = true; setProjectTransition(true)
    setProjectImportRecoveryEpoch(null)
  }} />, document.body) : null
  const projectExportDialog = projectExportOpen ? createPortal(<CanvasProjectExportDialog preview={projectExportPreview} preparing={projectExportPreparing} busy={projectExportBusy} error={projectExportError} blocked={projectExportBlocked} progress={projectExportProgress} allowExternalReferences={projectExportAllowExternal} onAllowExternalReferences={setProjectExportAllowExternal} onCancel={cancelProjectExport} onConfirm={() => void confirmProjectExport()} />, document.body) : null
  const activeAssetCategoryDialog = assetCategoryDialog?.scope === assetCategoryOwnerScope ? assetCategoryDialog : null
  const currentAssetCategoryRecovery = assetCategoryRecovery.pending
  const categoryDialogProps = {
    scopeKey: assetCategoryOwnerScope, directory: assetCategoryState.scope === assetCategoryOwnerScope ? assetCategoryState.directory : null,
    recovery: currentAssetCategoryRecovery, durableRecoveryReady: assetCategoryRecovery.ready, onRecoveryChange: () => undefined,
    recoveryNotice: <AssetCategoryRecoveryNotice state={assetCategoryRecovery} onReload={assetCategoryRecovery.reload} />,
    onReadDirectory: readAssetCategories, onSubmit: assetCategoryRecovery.submit, onInspect: assetCategoryRecovery.inspect, onRetry: assetCategoryRecovery.retry,
    onChanged: assetCategoryChanged, onClose: () => setAssetCategoryDialog(null), disabled: !draftActionsEnabled || !assetCategoryRecovery.ready,
  }
  const assetCategoryDialogElement = activeAssetCategoryDialog && assetCategorySupported && typeof document !== 'undefined' ? createPortal(activeAssetCategoryDialog.kind === 'move'
    ? <AssetCategoryMoveDialog key={`${assetCategoryOwnerScope}:move`} {...categoryDialogProps} assets={activeAssetCategoryDialog.assets} onReadAssets={readAssetCategorySelections} />
    : <AssetCategoryManagerDialog key={`${assetCategoryOwnerScope}:manage`} {...categoryDialogProps} />, document.body) : null

  const selectedInspectorNodes: CanvasInspectorNode[] = useMemo(
    () => projectCanvasInspectorNodes(nodes, edges),
    [edges, nodes],
  )
  const inspectorShown = !focusMode && !agentOpen && (
    (inspectorTab === 'node' && nodeInspectorOpen && selectedInspectorNodes.length > 0)
    || (inspectorTab === 'assets' && assetTrayOpen)
    || (inspectorTab === 'runs' && runInspectorOpen)
  )
  // In the narrow layout an open side panel squeezes the library into its rail (styles.css,
  // canvas-agent.css). The library is told it is collapsed then, so a rail tab really opens it: the panel
  // closes first, instead of the drawer expanding into a 48px column nobody can see.
  const narrowCanvas = useCanvasNarrowLayout()
  const libraryRailForced = narrowCanvas && (agentOpen || inspectorShown)
  const changeLibraryCollapsed = useCallback((collapsed: boolean) => {
    if (!collapsed && libraryRailForced) { setAgentOpen(false); closeInspector() }
    setUiPreferences((current) => current.libraryCollapsed === collapsed ? current : { ...current, libraryCollapsed: collapsed })
  }, [closeInspector, libraryRailForced])

  const workshopDialog = workshopCatalog && CanvasWorkshopLibraryDialog ? <PromptCatalogProvider value={promptCatalogValue}><CanvasWorkshopLibraryDialog
    key={`${draftOwnerId ?? 'local'}:${activeProject?.id ?? 'new'}:${workshopProjectEpoch}`}
    readOnly={!projectCanEdit}
    initialItemId={workshopCatalog.initialItemId}
    initialPromptId={workshopCatalog.initialPromptId}
    initialBuiltinPromptId={workshopCatalog.initialBuiltinPromptId}
    creatingProject={!activeProject && Boolean(hostBridge().createTemplateProject)}
    editingItemId={!activeProject ? workshopEditTarget?.id : undefined}
    onClose={() => setWorkshopCatalog(null)}
    onInsert={insertWorkshopItem}
    onInsertPrompt={(preset) => insertWorkshopItem(promptPresetWorkflowItem(preset), 'prompt')}
    onInsertOfficialPrompt={(id) => insertWorkshopItem(builtinPromptWorkflowItem(id), 'builtin-prompt')}
    onInsertOfficialTemplate={(id) => insertTemplate(id, undefined, true)}
    onPromptAcquired={(preset) => {
      if (!draftActionsEnabledRef.current || !promptCatalog.active()) throw new Error('账户已变化，已获取提示词将在重新进入工作区后显示')
      promptCatalog.upsert(preset)
    }}
  /></PromptCatalogProvider> : null

  const templateDialog = (
    <TemplateCatalog
      open={templateCatalog !== null}
      templates={builtinCanvasTemplates.filter((template) => template.requiredNodeTypes.every((type) => canvasNodeKindAvailable(type, canvasCapabilities())))}
      assets={assetPage}
      imageModels={imageModels}
      videoModels={videoModels}
      textModels={textModels}
      initialTemplateId={templateCatalog?.initialTemplateId}
      onClose={() => {
        setTemplateCatalog(null)
        if (!activeProjectIdRef.current && hostBridge().createTemplateProject) window.location.assign('/#templates')
      }}
      onPickAsset={pickAssetForTemplate}
      onListAssets={listAssetsForTemplate}
      officialAccess={officialAssetAccess}
      assetScopeKey={layerEditorScope}
      onAssetAcquired={() => void refreshAssets()}
      onInsert={insertTemplate}
    />
  )
  const commerceEditNode = commerceSession?.nodeId ? nodes.find((node) => node.id === commerceSession.nodeId) : undefined
  const commerceDialog = commerceSession && commerceSession.scope === layerEditorScope ? <CommerceTaskDialog
    key={`${commerceSession.scope}:${commerceSession.nodeId ?? 'new'}`}
    mode={commerceSession.nodeId ? 'edit' : 'create'} scopeKey={commerceSession.scope}
    isCurrent={() => commerceSessionRef.current === commerceSession && commerceSession.scope === currentWorkshopSetupScope() && draftActionsEnabledRef.current && !projectTransitionRef.current}
    initialTask={commerceSession.task} initialReferences={commerceSession.references}
    assets={assetPage} onListAssets={listAssetsForTemplate} onPickAsset={async () => {
      assertCommerceCurrent(commerceSession.scope)
      const asset = await pickAssetForTemplate(); assertCommerceCurrent(commerceSession.scope)
      if (asset && asset.mediaType !== 'image') throw new Error('商品任务只支持图片素材')
      return asset
    }} onReadAsset={async (assetId, signal) => {
      assertCommerceCurrent(commerceSession.scope)
      const asset = await readCanvasAssetDetail(assetId, signal); assertCommerceCurrent(commerceSession.scope)
      if (asset.mediaType !== 'image' || !isTemplateImageAsset(asset)) throw new Error('原图不可读取，请重新选择可用图片')
      setAssetCatalog((previous) => [...previous.filter((entry) => entry.assetId !== asset.assetId), asset])
      return asset
    }} officialAccess={officialAssetAccess} onAssetAcquired={() => void refreshAssets()}
    imageModels={imageModels.map((model) => ({ id: model, label: model }))}
    initialModel={commerceEditNode?.data.model || mediaGroups.imageModel}
    initialSize={commerceEditNode?.data.size || '1024x1024'} initialImageResolution={commerceEditNode?.data.imageResolution || '1K'}
    analysisUnavailableReason={!mediaGroups.textModel && !textModels.length ? '请先在模型来源中配置支持图片的文字模型；生成前会单独预检分析节点' : undefined}
    initialQuality={commerceEditNode?.data.quality || 'low'} initialCandidateCount={parseImageCandidateCount(commerceEditNode?.data.imageCandidateCount, 'image-generate')}
    onApply={applyCommerceDraft} onClose={() => {
      commerceOpenRevisionRef.current += 1
      commerceSessionRef.current = null; setCommerceSession(null)
      const route = new URL(window.location.href)
      if (!route.searchParams.has('templateOperation')) { route.searchParams.delete('commerceTask'); route.searchParams.delete('interiorTask'); window.history.replaceState(window.history.state, '', `${route.pathname}${route.search}${route.hash}`) }
    }}
  /> : null
  const interiorEditNode = interiorSession?.nodeId ? nodes.find((node) => node.id === interiorSession.nodeId) : undefined
  const interiorDialog = interiorSession && interiorSession.scope === layerEditorScope ? <InteriorTaskDialog
    key={`${interiorSession.scope}:${interiorSession.nodeId ?? 'new'}`}
    mode={interiorSession.nodeId ? 'edit' : 'create'} scopeKey={interiorSession.scope}
    isCurrent={() => interiorSessionRef.current === interiorSession && interiorSession.scope === currentWorkshopSetupScope() && draftActionsEnabledRef.current && projectCanEditRef.current && !projectTransitionRef.current}
    initialTask={interiorSession.task} initialSource={interiorSession.source}
    initialPrompt={interiorEditNode?.data.prompt ?? ''}
    initialGeneration={{ model: interiorEditNode ? interiorEditNode.data.model ?? '' : mediaGroups.imageModel, size: interiorEditNode?.data.size ?? '1024x1024', imageResolution: interiorEditNode?.data.imageResolution ?? '1K', quality: interiorEditNode?.data.quality ?? 'low', imageCandidateCount: parseImageCandidateCount(interiorEditNode?.data.imageCandidateCount, 'image-generate') }}
    assets={assetPage} onListAssets={listAssetsForTemplate} onPickAsset={async () => {
      assertCommerceCurrent(interiorSession.scope)
      const asset = await pickAssetForTemplate(); assertCommerceCurrent(interiorSession.scope)
      if (interiorSessionRef.current !== interiorSession) throw new Error('室内配置已关闭，请重新打开后选择图片')
      if (asset && asset.mediaType !== 'image') throw new Error('室内任务只支持图片素材')
      return asset
    }} onReadAsset={async (assetId, signal) => {
      assertCommerceCurrent(interiorSession.scope)
      const asset = await readCanvasAssetDetail(assetId, signal); assertCommerceCurrent(interiorSession.scope)
      if (interiorSessionRef.current !== interiorSession) throw new Error('室内配置已关闭，请重新打开后选择图片')
      if (asset.mediaType !== 'image' || !isTemplateImageAsset(asset)) throw new Error('原图不可读取，请重新选择可用图片')
      setAssetCatalog((previous) => [...previous.filter((entry) => entry.assetId !== asset.assetId), asset])
      return asset
    }} officialAccess={officialAssetAccess} onAssetAcquired={() => void refreshAssets()}
    imageModels={availableImageModelPresets(imageModels, true).map((model) => ({ id: model.id, label: model.label }))}
    onApply={applyInteriorDraft} onClose={() => {
      interiorOpenRevisionRef.current += 1
      interiorSessionRef.current = null; setInteriorSession(null)
      const route = new URL(window.location.href)
      if (!route.searchParams.has('templateOperation')) { route.searchParams.delete('interiorTask'); window.history.replaceState(window.history.state, '', `${route.pathname}${route.search}${route.hash}`) }
    }}
  /> : null
  const exteriorEditNode = exteriorSession?.nodeId ? nodes.find((node) => node.id === exteriorSession.nodeId) : undefined
  const exteriorDialog = exteriorSession && exteriorSession.scope === layerEditorScope ? <ExteriorTaskDialog
    key={`${exteriorSession.scope}:${exteriorSession.nodeId ?? 'new'}`}
    mode={exteriorSession.nodeId ? 'edit' : 'create'} scopeKey={exteriorSession.scope}
    isCurrent={() => exteriorSessionRef.current === exteriorSession && exteriorSession.scope === currentWorkshopSetupScope() && draftActionsEnabledRef.current && projectCanEditRef.current && !projectTransitionRef.current}
    initialTask={exteriorSession.task} initialReferences={exteriorSession.references}
    initialPrompt={exteriorEditNode?.data.prompt ?? ''}
    initialGeneration={{ model: exteriorEditNode ? exteriorEditNode.data.model ?? '' : mediaGroups.imageModel, size: exteriorEditNode?.data.size ?? '1024x1024', imageResolution: exteriorEditNode?.data.imageResolution ?? '1K', quality: exteriorEditNode?.data.quality ?? 'low', imageCandidateCount: parseImageCandidateCount(exteriorEditNode?.data.imageCandidateCount, 'image-generate') }}
    initialAnalysis={exteriorSession.analysis ?? { model: textImageInputModelSupported(mediaGroups.textModel ?? '') && textModels.includes(mediaGroups.textModel!) ? mediaGroups.textModel! : textModels.find(textImageInputModelSupported) ?? '' }}
    assets={assetPage} onListAssets={listAssetsForTemplate} onPickAsset={async () => {
      assertCommerceCurrent(exteriorSession.scope)
      const asset = await pickAssetForTemplate(); assertCommerceCurrent(exteriorSession.scope)
      if (exteriorSessionRef.current !== exteriorSession) throw new Error('室外配置已关闭，请重新打开后选择图片')
      if (asset && asset.mediaType !== 'image') throw new Error('室外任务只支持图片素材')
      return asset
    }} onReadAsset={async (assetId, signal) => {
      assertCommerceCurrent(exteriorSession.scope)
      const asset = await readCanvasAssetDetail(assetId, signal); assertCommerceCurrent(exteriorSession.scope)
      if (exteriorSessionRef.current !== exteriorSession) throw new Error('室外配置已关闭，请重新打开后选择图片')
      if (asset.mediaType !== 'image' || !isTemplateImageAsset(asset)) throw new Error('图片不可读取，请重新选择可用室外图片')
      setAssetCatalog((previous) => [...previous.filter((entry) => entry.assetId !== asset.assetId), asset])
      return asset
    }} officialAccess={officialAssetAccess} onAssetAcquired={() => void refreshAssets()}
    imageModels={availableImageModelPresets(imageModels, true).map((model) => ({ id: model.id, label: model.label }))}
    textModels={textModels.map((model) => ({ id: model, label: model }))}
    imageSources={groupsForCapability(groups, 'image').map((group) => ({ id: group.name, label: canvasGroupDisplayName(group.name, groups) }))}
    textSources={groupsForCapability(groups, 'text').map((group) => ({ id: group.name, label: canvasGroupDisplayName(group.name, groups) }))}
    imageSource={mediaGroups.image ?? ''} textSource={mediaGroups.text ?? ''}
    sourceLoading={!groupsLoaded || pendingMediaKinds.includes('image') || exteriorTaskUsesAnalysis(exteriorSession.task) && pendingMediaKinds.includes('text')}
    onSelectSource={(kind, source) => {
      assertCommerceCurrent(exteriorSession.scope)
      if (exteriorSessionRef.current !== exteriorSession) throw new Error('室外配置已关闭，请重新打开后选择来源')
      if (!groupsForCapability(groupsRef.current, kind).some((group) => group.name === source)) throw new Error('此来源已不可用或不提供所选用途，请重新核对')
      selectMediaGroup(kind, source)
      const session = { ...exteriorSession, [kind === 'image' ? 'imageSource' : 'textSource']: exteriorTaskSourceSignature(groupsRef.current, source) }
      exteriorSessionRef.current = session; setExteriorSession(session)
    }}
    analysisUnavailableReason={!mediaGroups.text || !textModels.some(textImageInputModelSupported) || mediaPreparationErrors.text ? '当前来源没有可用的视觉文字模型，请先配置模型来源，或关闭自动提示并填写要求。' : undefined}
    onApply={applyExteriorDraft} onClose={() => {
      exteriorOpenRevisionRef.current += 1
      exteriorSessionRef.current = null; setExteriorSession(null)
      const route = new URL(window.location.href)
      if (!route.searchParams.has('templateOperation')) { route.searchParams.delete('exteriorTask'); window.history.replaceState(window.history.state, '', `${route.pathname}${route.search}${route.hash}`) }
    }}
  /> : null
  const storyboardEditNode = storyboardSession?.nodeId ? nodes.find((node) => node.id === storyboardSession.nodeId) : undefined
  const storyboardDialog = storyboardSession && storyboardSession.scope === layerEditorScope ? <StoryboardTaskDialog
    key={`${storyboardSession.scope}:${storyboardSession.nodeId ?? 'new'}`}
    mode={storyboardSession.nodeId ? 'edit' : 'create'} scopeKey={storyboardSession.scope}
    isCurrent={() => storyboardSessionRef.current === storyboardSession && storyboardSession.scope === currentWorkshopSetupScope() && draftActionsEnabledRef.current && projectCanEditRef.current && !projectTransitionRef.current}
    initialTask={storyboardSession.task} initialReferences={storyboardSession.references}
    initialPrompt={storyboardEditNode?.data.prompt ?? ''}
    initialGeneration={{ model: storyboardEditNode ? storyboardEditNode.data.model ?? '' : mediaGroups.imageModel, size: storyboardEditNode?.data.size ?? '1024x1024', imageResolution: storyboardEditNode?.data.imageResolution ?? '1K', quality: storyboardEditNode?.data.quality ?? 'low', imageCandidateCount: parseImageCandidateCount(storyboardEditNode?.data.imageCandidateCount, 'image-generate') }}
    initialAnalysis={storyboardSession.analysis ?? { model: textImageInputModelSupported(mediaGroups.textModel ?? '') && textModels.includes(mediaGroups.textModel!) ? mediaGroups.textModel! : textModels.find(textImageInputModelSupported) ?? '' }}
    assets={assetPage} onListAssets={listAssetsForTemplate} onPickAsset={async () => {
      assertCommerceCurrent(storyboardSession.scope)
      const asset = await pickAssetForTemplate(); assertCommerceCurrent(storyboardSession.scope)
      if (storyboardSessionRef.current !== storyboardSession) throw new Error('故事板配置已关闭，请重新打开后选择图片')
      if (asset && asset.mediaType !== 'image') throw new Error('故事板任务只支持图片素材')
      return asset
    }} onReadAsset={async (assetId, signal) => {
      assertCommerceCurrent(storyboardSession.scope)
      const asset = await readCanvasAssetDetail(assetId, signal); assertCommerceCurrent(storyboardSession.scope)
      if (storyboardSessionRef.current !== storyboardSession) throw new Error('故事板配置已关闭，请重新打开后选择图片')
      if (asset.mediaType !== 'image' || !isTemplateImageAsset(asset)) throw new Error('图片不可读取，请重新选择可用故事板图片')
      setAssetCatalog((previous) => [...previous.filter((entry) => entry.assetId !== asset.assetId), asset])
      return asset
    }} officialAccess={officialAssetAccess} onAssetAcquired={() => void refreshAssets()}
    imageModels={availableImageModelPresets(imageModels, true).map((model) => ({ id: model.id, label: model.label }))}
    textModels={textModels.map((model) => ({ id: model, label: model }))}
    imageSources={groupsForCapability(groups, 'image').map((group) => ({ id: group.name, label: canvasGroupDisplayName(group.name, groups) }))}
    textSources={groupsForCapability(groups, 'text').map((group) => ({ id: group.name, label: canvasGroupDisplayName(group.name, groups) }))}
    imageSource={mediaGroups.image ?? ''} textSource={mediaGroups.text ?? ''}
    sourceLoading={!groupsLoaded} imageSourceLoading={pendingMediaKinds.includes('image')} textSourceLoading={pendingMediaKinds.includes('text')}
    onSelectSource={(kind, source) => {
      assertCommerceCurrent(storyboardSession.scope)
      if (storyboardSessionRef.current !== storyboardSession) throw new Error('故事板配置已关闭，请重新打开后选择来源')
      if (!groupsForCapability(groupsRef.current, kind).some((group) => group.name === source)) throw new Error('此来源已不可用或不提供所选用途，请重新核对')
      selectMediaGroup(kind, source)
      const session = { ...storyboardSession, [kind === 'image' ? 'imageSource' : 'textSource']: storyboardTaskSourceSignature(groupsRef.current, source) }
      storyboardSessionRef.current = session; setStoryboardSession(session)
    }}
    analysisUnavailableReason={!mediaGroups.text || !textModels.some(textImageInputModelSupported) || mediaPreparationErrors.text ? '当前来源没有可用的视觉文字模型，请先配置模型来源，或关闭自动剧情并填写要求。' : undefined}
    onApply={applyStoryboardDraft} onClose={() => {
      storyboardOpenRevisionRef.current += 1
      storyboardSessionRef.current = null; setStoryboardSession(null)
      const route = new URL(window.location.href)
      if (!route.searchParams.has('templateOperation')) { route.searchParams.delete('storyboardTask'); window.history.replaceState(window.history.state, '', `${route.pathname}${route.search}${route.hash}`) }
    }}
  /> : null
  const templateRecoveryDialog = savedTemplateRecovery ? <TemplateProjectRecovery
    submission={savedTemplateRecovery}
    error={templateRecoveryError}
    busy={templateRecoveryBusy}
    onRetry={() => void resumeTemplateProjectCreation()}
    onExport={() => { void hostBridge().exportProject('xingmang-template-recovery.xingcanvas', savedTemplateRecovery.content).catch((error) => setTemplateRecoveryError(error instanceof Error ? error.message : '原模板工作流导出失败')) }}
    onClose={() => { if (!templateRecoveryBusyRef.current) window.location.assign('/#canvas') }}
  /> : null

  if (window.xingmangCanvasHost && !activeProject) {
    return (
      <>{closeDialog}{templateDialog}{commerceDialog}{interiorDialog}{exteriorDialog}{storyboardDialog}{workshopDialog}{templateRecoveryDialog}{projectImportRecoveryDialog}
      {WorkshopCreationRecoveryNotice && <WorkshopCreationRecoveryNotice key={`creation:${layerEditorScope}`} scopeKey={layerEditorScope} active={() => agentMountedRef.current && draftActionsEnabledRef.current && currentWorkshopSetupScope() === layerEditorScope} onSaved={(item) => setBanner(item.deletedAt ? `已核对原保存：「${item.name}」目前在回收站，请到我的工坊恢复。` : `已核对原保存：「${item.name}」当前为 v${item.version}，不会另建一份。`)} />}
      <ProjectCenter
        projects={projects}
        page={projectPaginationEnabled ? projectPage : undefined}
        query={projectPaginationEnabled ? projectQuery : undefined}
        onQueryChange={projectPaginationEnabled ? changeProjectQuery : undefined}
        onQueryPending={projectPaginationEnabled ? invalidateProjectQuery : undefined}
        storageMode={storageMode}
        loading={projectLoading}
        error={projectError}
        onRefresh={() => void refreshProjects()}
        onCreate={createStoredProject}
        blankCreation={storageMode === 'cloud' ? blankCreation : undefined}
        blankCreationReady={blankCreationReady && draftActionsEnabled}
        blankDraftName={storageMode === 'cloud' ? blankProjectName : undefined}
        blankDraftError={blankDraftError}
        onBlankDraftNameChange={changeBlankProjectName}
        onContinueBlankCreate={continueBlankProjectCreation}
        onFinishBlankCreate={finishBlankProjectCreation}
        onOpen={(id) => void openStoredProject(id)}
        onRename={renameStoredProject}
        onDuplicate={duplicateStoredProject}
        onSetArchived={setStoredProjectArchived}
        onDraftChange={rememberProjectCenterDraft}
      />
      </>
    )
  }

  return (
    <div className="canvas-app" ref={(element) => { element?.toggleAttribute('inert', projectTransition || projectImportRecoveryEpoch !== null || historyCurrent || (draftRecovery !== null && draftDialogCurrent) || draftActionBusy || draftLocalActionBusy) }} aria-busy={projectTransition || draftActionBusy || draftLocalActionBusy || undefined}>
      {closeDialog}
      {historyDialog}
      {recoveryDialog}
      {projectImportDialog}
      {projectImportRecoveryDialog}
      {projectExportDialog}
      {assetCategoryDialogElement}
      {templateRecoveryDialog}
      <header className="canvas-toolbar canvas-toolbar-editor">
        <div className="canvas-brand">
          <button type="button" className="canvas-project-back" title={pendingRunProjectionIdsRef.current.size > 0 ? '运行结果尚未回填，请刷新运行历史后再返回' : running || startingRuns > 0 || resumingTaskIds.size > 0 ? '任务结束后可返回项目中心' : '保存并返回项目中心'} aria-label="返回项目中心" disabled={running || startingRuns > 0 || pendingRunProjectionIdsRef.current.size > 0 || projectTransition || resumingTaskIds.size > 0 || projectLoading} onClick={() => void returnToProjectCenter()}><FolderOpen size={15} /></button>
          {storageMode === 'cloud' && <span className="canvas-web-brand">星芒画布 <span aria-hidden="true">/</span></span>}
          {activeProject ? <CanvasProjectName key={activeProject.id} name={activeProject.name} disabled={!projectCanEdit || projectAccessState?.access?.mode === 'edit' || projectLoading || projectTransition || Boolean(saveConflict) || draftRecovery !== null} onRename={renameActiveProject} /> : <strong>星芒无限画布</strong>}
        </div>
        <div className="canvas-toolbar-group canvas-toolbar-center">
          <button type="button" className="canvas-icon-command" title="撤销 (⌘/Ctrl+Z)" aria-label="撤销" onClick={undo} disabled={!canUndo}><Undo2 size={15} /></button>
          <button type="button" className="canvas-icon-command" title="重做 (⌘/Ctrl+Shift+Z)" aria-label="重做" onClick={redo} disabled={!canRedo}><Redo2 size={15} /></button>
          <span className="canvas-tool-divider" aria-hidden="true" />
          <div className="canvas-arrange-control" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setArrangeMenuOpen(false) }}>
            <button type="button" className="canvas-icon-command" aria-disabled={!projectCanEdit} title="排列节点" aria-label="排列节点" aria-haspopup="menu" aria-expanded={arrangeMenuOpen} onClick={() => setArrangeMenuOpen((open) => !open)} disabled={!projectCanEdit || !nodes.length}><LayoutGrid size={15} /></button>
            {arrangeMenuOpen && <div className="canvas-arrange-menu" role="menu" aria-label="排列方式" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setArrangeMenuOpen(false) } }}><strong>{selectedNodeIds.length ? `排列 ${selectedNodeIds.length} 个选中节点（分组整体移动）` : '排列顶层节点（保持组内布局）'}</strong><button type="button" role="menuitem" onClick={() => arrangeNodes('horizontal')}>水平排列</button><button type="button" role="menuitem" onClick={() => arrangeNodes('vertical')}>垂直排列</button><button type="button" role="menuitem" onClick={() => arrangeNodes('smart')}>智能排列</button>{(selectedNodeIds.length ? selectedNodes.some((node) => node.type === 'group') : nodes.some((node) => node.type === 'group')) && <button type="button" role="menuitem" onClick={organizeGroupContents}>{selectedNodeIds.length ? '整理选中分组内部' : '整理所有分组内部'}</button>}</div>}
          </div>
          <button type="button" className="canvas-icon-command" title="适配全部内容" aria-label="适配全部内容" onClick={fitCanvas} disabled={!nodes.length}><Crosshair size={15} /></button>
          <button type="button" className="canvas-icon-command" title="查找节点 (Ctrl/Cmd+F)" aria-label="查找节点" aria-haspopup="dialog" aria-expanded={nodeSearchOpen} data-node-search-trigger="true" onClick={() => { setQuickInsert(null); setMoreActionsOpen(false); setRunMenuOpen(false); setMediaConfigOpen(false); setNodeSearchOpen((open) => !open) }} disabled={!nodes.length}><Search size={15} /></button>
        </div>
        <div className="canvas-toolbar-group canvas-toolbar-actions">
          {canvasCapabilities().features.scenarioTemplates && <>
            <button type="button" className="canvas-icon-command" title="电商创作：材质、风格与商品视角" aria-label="电商创作" disabled={!projectCanEdit || running || startingRuns > 0} onClick={openCommerceCreation}><ImageIcon size={15} /><span>电商创作</span></button>
            <button type="button" className="canvas-icon-command" title="室内一键渲染：空间、天气与光线" aria-label="室内渲染" disabled={!projectCanEdit || running || startingRuns > 0} onClick={openInteriorCreation}><Building2 size={15} /><span>室内渲染</span></button>
            <button type="button" className="canvas-icon-command" title="室外渲染、景观、立面、风格与门头改造" aria-label="室外创作" disabled={!projectCanEdit || running || startingRuns > 0} onClick={openExteriorCreation}><Building2 size={15} /><span>室外创作</span></button>
            <button type="button" className="canvas-icon-command" title="故事板画风、剧情、输入图片与宫格布局" aria-label="故事板" disabled={!projectCanEdit || running || startingRuns > 0} onClick={openStoryboardCreation}><Video size={15} /><span>故事板</span></button>
          </>}
          {projectCanRun && agentScope && <button type="button" className={`canvas-icon-command canvas-agent-command${agentOpen ? ' is-active' : ''}`} title="Canvas Agent · 描述需求并规划节点" aria-label="Canvas Agent" aria-pressed={agentOpen} onClick={() => { setFocusMode(false); setMediaConfigOpen(false); setQuickInsert(null); setMoreActionsOpen(false); setAgentOpen((open) => !open) }}><Sparkles size={15} /><span>Agent</span></button>}
          <button
            ref={quickInsertTriggerRef}
            type="button"
            className="canvas-icon-command canvas-quick-command"
            title="快速创建 (Ctrl+K)"
            aria-label="快速创建"
            disabled={!projectCanEdit}
            aria-haspopup="dialog"
            aria-expanded={quickInsert !== null}
            data-quick-insert-trigger="true"
            onClick={() => {
              if (quickInsert) {
                setQuickInsert(null)
                return
              }
              const bounds = document.querySelector('.canvas-flow')?.getBoundingClientRect()
              if (!bounds) return
              setMediaConfigOpen(false)
              setRunMenuOpen(false)
              setMoreActionsOpen(false)
              setNodeSearchOpen(false)
              const client = { x: bounds.left + bounds.width / 2, y: bounds.top + Math.min(bounds.height * 0.38, 320) }
              setQuickInsert({ anchor: { x: Math.max(12, bounds.width / 2 - 180), y: Math.max(12, Math.min(bounds.height - 430, client.y - bounds.top - 70)) }, flowPosition: reactFlow.screenToFlowPosition(client) })
            }}
          ><Plus size={16} /><span>添加</span></button>
          <button
            type="button"
            className={`canvas-icon-command canvas-history-command${inspectorTab === 'runs' && runInspectorOpen ? ' is-active' : ''}`}
            title="运行历史"
            aria-label="运行历史"
            disabled={!projectCanRun}
            aria-pressed={inspectorTab === 'runs' && runInspectorOpen}
            onClick={toggleRunInspector}
          ><History size={15} /></button>
          {/* Distinct icon from the bottom-right "focus selection" control: this
              one hides the side panels, it does not move the viewport. */}
          <button
            type="button"
            className={`canvas-icon-command${focusMode ? ' is-active' : ''}`}
            title={focusMode ? '显示侧边面板' : '隐藏侧边面板,专注画布'}
            aria-label={focusMode ? '显示侧边面板' : '隐藏侧边面板'}
            aria-pressed={focusMode}
            onClick={() => setFocusMode((current) => !current)}
          ><PanelRight size={15} /></button>
          {projectCanRun && <MediaConfiguration
            open={mediaConfigOpen}
            groups={groups}
            imageGroup={imageGroup}
            videoGroup={videoGroup}
            textGroup={textGroup}
            imageModel={mediaGroups.imageModel ?? null}
            videoModel={mediaGroups.videoModel ?? null}
            textModel={mediaGroups.textModel ?? null}
            imageModels={imageModels}
            videoModels={videoModels}
            textModels={textModels}
            preparing={preparingMedia}
            pendingKinds={visiblePendingMediaKinds}
            refreshingGroups={refreshingGroups}
            groupsError={groupsError}
            preparationErrors={mediaPreparationErrors}
            groupsLoaded={groupsLoaded}
            onRefreshGroups={refreshGroups}
            onToggle={toggleMediaConfiguration}
            onClose={() => setMediaConfigOpen(false)}
            onSelectGroup={(kind, group) => void selectMediaGroup(kind, group)}
            onSelectModel={selectMediaModel}
            manageSourcesUrl={storageMode === 'cloud' ? '/#account/models' : undefined}
          />}
          <div ref={moreActionsRef} className="canvas-more-actions">
            <button ref={moreActionsTriggerRef} type="button" className="canvas-icon-command" title="更多操作" aria-label="更多操作" aria-haspopup="menu" aria-expanded={moreActionsOpen} onClick={() => { setMediaConfigOpen(false); setRunMenuOpen(false); setQuickInsert(null); setMoreActionsOpen((open) => !open) }}><MoreHorizontal size={16} /></button>
            {moreActionsOpen && (
              <div className="canvas-more-menu">
                <div className="canvas-more-mobile-tools">
                  <button type="button" disabled={!canUndo} onClick={() => { setMoreActionsOpen(false); undo() }}><Undo2 size={14} />撤销</button>
                  <button type="button" disabled={!canRedo} onClick={() => { setMoreActionsOpen(false); redo() }}><Redo2 size={14} />重做</button>
                  <button type="button" disabled={!projectCanEdit || !nodes.length} onClick={() => { setMoreActionsOpen(false); autoLayout() }}><LayoutGrid size={14} />自动布局</button>
                  <button type="button" disabled={!nodes.length} onClick={() => { setMoreActionsOpen(false); fitCanvas() }}><Crosshair size={14} />适配全部内容</button>
                  <span className="canvas-more-divider" />
                </div>
                <button type="button" onClick={() => { setMoreActionsOpen(false); setQuickInsert(null); setRunMenuOpen(false); setMediaConfigOpen(false); setNodeSearchOpen(true) }} disabled={!nodes.length}><Search size={14} />查找节点</button>
                <button type="button" disabled={!draftActionsEnabled || projectTransition || !nodes.some((node) => node.selected)} onClick={() => { setMoreActionsOpen(false); void copySelection() }}>复制选区到系统剪贴板</button>
                {hostEntryPoints.menuPaste && <button type="button" disabled={!projectCanEdit || projectTransition} onClick={() => { setMoreActionsOpen(false); void pasteSelection() }}>从系统剪贴板粘贴</button>}
                <button type="button" disabled={!projectCanEdit} onClick={() => { setMoreActionsOpen(false); groupSelection() }}>将选中节点分组</button>
                <button type="button" disabled={!projectCanEdit} onClick={() => { setMoreActionsOpen(false); openTemplateCatalog() }}><Sparkles size={14} />打开行业模板库</button>
                {canvasCapabilities().features.scenarioTemplates && <>
                  <button type="button" disabled={!projectCanEdit} onClick={openCommerceCreation}><ImageIcon size={14} />电商创作任务</button>
                  <button type="button" disabled={!projectCanEdit || running || startingRuns > 0} onClick={openInteriorCreation}><Building2 size={14} />室内一键渲染</button>
                  <button type="button" disabled={!projectCanEdit || running || startingRuns > 0} onClick={openExteriorCreation}><Building2 size={14} />室外创作任务</button>
                  <button type="button" disabled={!projectCanEdit || running || startingRuns > 0} onClick={openStoryboardCreation}><Video size={14} />故事板创作任务</button>
                </>}
                {CanvasWorkshopLibraryDialog && hostBridge().listWorkshopItems && <button type="button" onClick={() => { setMoreActionsOpen(false); setWorkshopCatalog({}) }}><BookmarkPlus size={14} />打开我的工坊</button>}
                {WorkshopSetupPanel && <button type="button" onClick={() => openWorkshopSetup()} disabled={!draftActionsEnabled || projectTransition}><ListChecks size={14} />创作准备清单</button>}
                {SaveCanvasWorkshopDialog && hostBridge().createWorkshopItem && <button type="button" disabled={!projectCanEdit || !selectedNodeIds.length} onClick={() => { setMoreActionsOpen(false); saveWorkshopSelection(selectedNodeIds) }}><BookmarkPlus size={14} />保存选区到工坊</button>}
                <button type="button" disabled={!projectCanEdit || !nodes.length} onClick={() => { setMoreActionsOpen(false); arrangeNodes('horizontal') }}>水平排列节点</button>
                <button type="button" disabled={!projectCanEdit || !nodes.length} onClick={() => { setMoreActionsOpen(false); arrangeNodes('vertical') }}>垂直排列节点</button>
                <button type="button" disabled={!projectCanEdit} onClick={() => { setMoreActionsOpen(false); showAssetTray() }}><ImageIcon size={14} />打开素材库</button>
                {/* Overflow fallback: the toolbar toggle is hidden below 1320px,
                    so narrow windows would otherwise lose every entry point. */}
                <button type="button" disabled={!projectCanRun} onClick={() => { setMoreActionsOpen(false); openInspectorTab('runs') }}><History size={14} />打开运行历史</button>
                <span className="canvas-more-divider" />
                <button type="button" disabled={!projectCanEdit} onClick={() => { setMoreActionsOpen(false); void load() }}>打开工作流</button>
                <button type="button" onClick={() => { setMoreActionsOpen(false); void save() }}>保存工作流</button>
                <button type="button" disabled={!projectCanEdit} onClick={() => { setMoreActionsOpen(false); void importProject() }}>导入工作流</button>
                {hostBridge().projectImportRecovery && <button type="button" disabled={!draftActionsEnabled || projectTransition || draftActionBusy} onClick={openImportRecovery}>恢复未完成导入</button>}
                <button type="button" onClick={() => { setMoreActionsOpen(false); void exportProject() }}>导出工作流</button>
                {hostEntryPoints.projectHistory && <button type="button" disabled={Boolean(projectAccessState?.denied) || !draftActionsEnabled || !activeProject} title={projectCanRestore ? "查看已保存的云端版本，预览并恢复画布" : "查看共享期间的云端版本；只有项目拥有者可以恢复"} onClick={openProjectHistory}>版本历史</button>}
                {draftOwnerId && <button type="button" disabled={!draftActionsEnabled || draftActionBusy || draftLocalActionBusy} title={!draftActionsEnabled ? '账户连接已停止，请重新进入工作区核对' : '管理本浏览器为当前工程保留的草稿'} onClick={() => { setMoreActionsOpen(false); openLocalDraftManager(moreActionsTriggerRef.current) }}>管理本地草稿</button>}
                {hostEntryPoints.projectPackageExport && <button type="button" title="导出网页便携包，确认后携带可读取图片、视频与音频" onClick={() => { setMoreActionsOpen(false); void previewProjectExport() }}>导出项目（含素材）</button>}
              </div>
            )}
          </div>
          {running
            ? <button type="button" className="canvas-run" onClick={cancel}>取消</button>
            : <div ref={runMenuRef} className="canvas-run-split">
                <button type="button" className="canvas-run canvas-run-main" title={mediaPreparationBlocked ?? (activeRunHasPendingMedia ? '此运行范围的来源仍在核对；其他用途和画布编辑可继续使用' : undefined)} onClick={() => void run()} disabled={!projectCanRun || projectTransition || startingRuns > 0 || Boolean(mediaPreparationBlocked) || activeRunHasPendingMedia || nodes.length === 0 || resumingTaskIds.size > 0 || activeRunOption.disabled}><Play size={14} aria-hidden="true" />{startingRuns > 0 ? '提交中…' : runScopeLabel}</button>
                <button ref={runMenuTriggerRef} type="button" className="canvas-run canvas-run-menu-toggle" title="选择运行范围" aria-label="选择运行范围" disabled={!projectCanRun} aria-haspopup="menu" aria-expanded={runMenuOpen} onClick={() => { setMoreActionsOpen(false); setMediaConfigOpen(false); setQuickInsert(null); setRunMenuOpen((open) => !open) }}><ChevronDown size={14} /></button>
                {runMenuOpen && <div className="canvas-run-menu" role="menu" aria-label="运行范围">
                  {runScopeOptions.map((option) => (
                    <button key={option.kind} type="button" role="menuitemradio" aria-checked={runScopeKind === option.kind} disabled={option.disabled} onClick={() => { setRunScopeKind(option.kind); setRunMenuOpen(false); runMenuTriggerRef.current?.focus() }}>
                      <span><strong>{option.label}</strong><small>{option.description}</small></span>
                    </button>
                  ))}
                </div>}
              </div>}
        </div>
      </header>
      {collaboration.state && ProjectCollaborationPanel && <ProjectCollaborationPanel key={collaborationScopeKey} state={collaboration.state} onAction={(action, operationId) => { void collaboration.action(action, operationId).catch((error) => setBanner(error instanceof Error ? error.message : '协作操作未确认，请保留当前编辑。')) }} onExport={() => void save()} />}
      {!workshopSelection && WorkshopContentRecoveryNotice && <WorkshopContentRecoveryNotice key={`content:${layerEditorScope}`} scopeKey={layerEditorScope} active={() => agentMountedRef.current && draftActionsEnabledRef.current && currentWorkshopSetupScope() === layerEditorScope} onUpdated={(receipt) => setBanner(`已核对：工坊配置更新提交为 v${receipt.committedVersion}。已插入的画布与发布快照保持独立。`)} />}
      {!workshopSelection && WorkshopCreationRecoveryNotice && <WorkshopCreationRecoveryNotice key={`creation:${layerEditorScope}`} scopeKey={layerEditorScope} active={() => agentMountedRef.current && draftActionsEnabledRef.current && currentWorkshopSetupScope() === layerEditorScope} onSaved={(item) => setBanner(item.deletedAt ? `已核对原保存：「${item.name}」目前在回收站，请到我的工坊恢复。` : `已核对原保存：「${item.name}」当前为 v${item.version}，不会另建一份。`)} />}
      {SaveCanvasWorkshopDialog && workshopEditTarget?.projectId === activeProject?.id && activeProject && <div className="canvas-workshop-edit-banner"><span>正在编辑工坊的独立工作副本。修改画布不会自动覆盖工坊。</span><button type="button" disabled={!projectCanEdit || projectTransition || !nodes.length} onClick={() => saveWorkshopSelection(getGraphSnapshot().nodes.map((node) => node.id))}>预览并更新原工坊配置</button></div>}
      {projectAccessState && <div className="canvas-project-access" role="status"><strong>{projectAccessState.denied ? '项目权限已撤销' : projectAccessState.access?.mode === 'owner' ? '我的项目' : projectAccessState.access?.canEdit ? '团队项目 · 可编辑' : '团队项目 · 只读'}</strong><span>{projectAccessState.denied ? '已停止保存与素材读取，当前未提交编辑保留在本机。' : projectAccessState.access?.mode !== 'owner' ? `${projectAccessState.access?.teamName ?? '团队'} · 同一项目；协作运行尚未开放。` : '共享权限由项目所有者管理。'}</span><button type="button" onClick={() => void window.xingmangCanvasHost?.refreshProjectAccess?.().catch((cause) => setBanner(cause instanceof Error ? cause.message : '权限读取失败'))}>核对权限</button>{projectAccessState.denied && <button type="button" onClick={() => void exportProject()}>下载本机工作流</button>}</div>}
      <div className={`canvas-workspace${focusMode ? ' is-focused' : ''}`}>
      <NodeLibrary
        readOnly={!projectCanEdit}
        key={activeProject?.id ?? 'unsaved'}
        resourceCount={nodes.length}
        resources={<ResourceTree readOnly={!projectCanEdit} key={activeProject?.id ?? 'unsaved'} nodes={nodes}
          onSelect={(ids, focusId) => {
            const selected = new Set(ids)
            setNodes((current) => current.map((node) => node.selected === selected.has(node.id) ? node : { ...node, selected: selected.has(node.id) }))
            setEdges((current) => current.map((edge) => edge.selected ? { ...edge, selected: false } : edge))
            if (focusId) locateNode(focusId)
          }}
          onRename={(id) => { if (!projectCanEdit) return; const node = nodes.find((entry) => entry.id === id); if (node) setRenamingNode({ id, name: resourceNodeTitle(node) }) }}
          onGroup={groupNodes} onLock={(ids, locked) => setNodeFlags(ids, 'locked', locked)}
          canExport={hostEntryPoints.projectPackageExport}
          onExport={(ids) => { void previewProjectExport(ids) }} />}
        collapsed={uiPreferences.libraryCollapsed || libraryRailForced}
        onCollapsedChange={changeLibraryCollapsed}
        onAdd={addNode}
        onAddPrompt={(prompt) => addNode('prompt', undefined, { prompt })}
        onAddAsset={addAssetNode}
        onDeletePromptPreset={deletePromptPreset}
        onUpdatePromptPreset={updatePromptPreset}
        onRefreshPromptPresets={async () => { await promptCatalog.load(true); const error = promptCatalog.snapshot().error; if (error) throw new Error(error) }}
        onLoadTemplate={(templateId) => openTemplateCatalog(templateId)}
        onOpenAssets={showAssetTray}
        onAssetMenu={(assetId) => void hostBridge().showAssetMenu(assetId)}
        assets={assetPage}
        userPromptPresets={userPromptPresets}
        capabilities={canvasCapabilities()}
      />
      <div
        className={`canvas-flow${!focusMode && (assetTrayOpen || runInspectorOpen) ? ' has-right-panel' : ''}`}
        onMouseDownCapture={beginCutStroke}
        onDoubleClick={(event) => {
          if (!projectCanEdit) return
          if (!(event.target instanceof Element) || !event.target.classList.contains('react-flow__pane')) return
          const bounds = event.currentTarget.getBoundingClientRect()
          setQuickInsert({
            anchor: {
              x: Math.max(12, Math.min(bounds.width - 372, event.clientX - bounds.left)),
              y: Math.max(12, Math.min(bounds.height - 430, event.clientY - bounds.top)),
            },
            flowPosition: reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
          })
        }}
      >
        <PromptCatalogProvider value={promptCatalogValue}>
        <CanvasModelAvailabilityProvider connected={serverBacked} sourceCatalog={nodeSourceCatalog} sourceGroups={groups} videoProtocol={videoProtocol} imageModels={imageModels} videoModels={videoModels} textModels={textModels} imageModel={mediaGroups.imageModel} videoModel={mediaGroups.videoModel} textModel={mediaGroups.textModel}>
        <CanvasNodeViewProvider capabilities={canvasCapabilities()} readOnly={!projectCanEdit} canRun={projectCanRun} lod={nodeLod} editorScope={layerEditorScope} outputPendingNodeIds={outputPendingNodeIds} composerFollowNode={uiPreferences.composerFollowNode} composerCollapsed={uiPreferences.composerCollapsed} onComposerCollapsedChange={setComposerCollapsed}>
        <CanvasUpstreamReferencesProvider nodes={nodes} edges={edges} assets={assetCatalog}>
        <CanvasEdgeHandlersProvider handlers={edgeHandlers}>
        <ReactFlow
          colorMode={theme}
          defaultViewport={viewport}
          onInit={onCanvasViewportInit}
          nodes={nodes}
          edges={renderedEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          connectionLineType={ConnectionLineType.Bezier}
          onNodesChange={onCanvasNodesChange}
          onNodeDragStart={onCanvasNodeDragStart}
          onNodeDrag={onCanvasNodeDrag}
          onNodeDragStop={onCanvasNodeDragStop}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectStart={onConnectStart}
          onConnectEnd={onConnectEnd}
          isValidConnection={isValidConnection}
          edgesReconnectable={projectCanEdit}
          nodesDraggable={projectCanEdit}
          nodesConnectable={projectCanEdit}
          onReconnect={onReconnect}
          reconnectRadius={14}
          deleteKeyCode={null}
          minZoom={minimumCanvasViewportZoom}
          maxZoom={maximumCanvasViewportZoom}
          proOptions={{ hideAttribution: false }}
          ariaLabelConfig={canvasAriaLabelConfig}
          onMoveStart={(event) => { if (event) { cancelInsertionViewportNavigation(); createdNodeFocusRef.current?.cancel(); viewportRestorationRef.current?.cancel() } }}
          onMove={(_, nextViewport) => setNodeLod((current) => canvasNodeLodForZoom(nextViewport.zoom, current))}
          onMoveEnd={(_, nextViewport) => setDocumentViewport(nextViewport)}
          selectionOnDrag
          selectionMode={SelectionMode.Partial}
          panOnDrag={[1, 2]}
          panOnScroll
          // Shift adds to a selection; space temporarily turns drag into pan,
          // which is the convention in every design tool our users have used.
          multiSelectionKeyCode="Shift"
          panActivationKeyCode="Space"
          // Double-click is reclaimed for quick insert / rename. Leaving the
          // default on made every one of those gestures also zoom the canvas.
          zoomOnDoubleClick={false}
          // A selected node must never paint under an unselected neighbour.
          elevateNodesOnSelect
          elevateEdgesOnSelect
          // Nodes host textareas and selects: without a threshold a 2px twitch
          // while clicking one starts a node drag instead.
          nodeDragThreshold={3}
          onNodeContextMenu={(event, node) => { if (projectCanEdit) openContextMenuFor(event, node); else event.preventDefault() }}
          onSelectionContextMenu={(event, selected) => { if (projectCanEdit && selected[0]) openContextMenuFor(event, selected[0]) }}
          onPaneClick={() => { createdNodeFocusRef.current?.cancel(); setQuickInsert(null); setContextMenu(null); setRunMenuOpen(false); setMoreActionsOpen(false) }}
          onPaneContextMenu={(event) => {
            event.preventDefault()
            if (!projectCanEdit) return
            openQuickInsertAt({ x: event.clientX, y: event.clientY })
          }}
          onEdgeContextMenu={(event, edge) => {
            event.preventDefault()
            if (!projectCanEdit) return
            openEdgeQuickInsertAt({ x: event.clientX, y: event.clientY }, edge)
          }}
          onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}
          onDrop={(event) => {
            if (!projectCanEdit) { event.preventDefault(); return }
            event.preventDefault()
            const position = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
            const nodeType = event.dataTransfer.getData('application/x-xingmang-node')
            if (nodeType) {
              addNode(nodeType, position)
              return
            }
            const presetPrompt = event.dataTransfer.getData(promptPresetMime)
            if (presetPrompt) {
              addNode('prompt', position, { prompt: presetPrompt })
              return
            }
            const batch = event.dataTransfer.getData(assetBatchDragMime)
            if (batch) {
              try { const ids = validateAssetBatchIds(JSON.parse(batch)), epoch = projectEpochRef.current, projectId = activeProjectIdRef.current; void addAssetNodes(ids, position).catch((error) => { if (mediaPreparationMountedRef.current && epoch === projectEpochRef.current && projectId === activeProjectIdRef.current) setBanner(error instanceof Error ? error.message : '批量加入未完成') }) }
              catch { setBanner('批量素材信息无效，请从素材库重新拖入') }
              return
            }
            const assetId = event.dataTransfer.getData('application/x-xingmang-asset-id')
            if (assetId) {
              addAssetNode(assetId, position)
              return
            }
            const file = event.dataTransfer.files[0]
            if (file) void importAssetToCanvas(file, position)
          }}
        >
          <Background id="canvas-grid" variant={BackgroundVariant.Dots} gap={22} size={1.35} />
          {cutStroke.length > 1 && (
            <ViewportPortal>
              <svg className="canvas-cut-stroke" aria-hidden="true">
                <path d={strokePath(cutStroke)} />
              </svg>
            </ViewportPortal>
          )}
          {snapGuides.length > 0 && (
            <ViewportPortal>
              {snapGuides.map((guide) => (
                <div
                  key={`${guide.axis}:${guide.position}`}
                  className={`canvas-snap-guide is-${guide.axis}`}
                  style={guide.axis === 'x'
                    ? { left: guide.position, top: guide.start, height: guide.end - guide.start }
                    : { left: guide.start, top: guide.position, width: guide.end - guide.start }}
                />
              ))}
            </ViewportPortal>
          )}
          {minimapOpen && <MiniMap pannable zoomable nodeColor={canvasMinimapNodeColor} nodeStrokeWidth={3} />}
          <Controls orientation="horizontal" showFitView={false} onZoomIn={() => { cancelInsertionViewportNavigation(); createdNodeFocusRef.current?.cancel(); viewportRestorationRef.current?.cancel() }} onZoomOut={() => { cancelInsertionViewportNavigation(); createdNodeFocusRef.current?.cancel(); viewportRestorationRef.current?.cancel() }} />
        </ReactFlow>
        </CanvasEdgeHandlersProvider>
        {nodeSearchOpen && (
          <NodeSearchPalette
            key={layerEditorScope}
            nodes={nodes.map((node) => ({
              id: node.id,
              title: typeof node.data.settings?.title === 'string' && node.data.settings.title.trim()
                ? node.data.settings.title.trim()
                : builtinNodeRegistry.resolve(node.type ?? 'unknown')?.title ?? node.type ?? '节点',
              kind: node.type ?? 'unknown',
              kindLabel: builtinNodeRegistry.resolve(node.type ?? 'unknown')?.title,
              prompt: node.data.prompt,
              model: node.data.model,
              status: node.data.status,
            }))}
            onJump={locateNode}
            onClose={() => setNodeSearchOpen(false)}
          />
        )}
        {contextMenu && (
          <CanvasContextMenu
            state={contextMenu}
            onAction={runContextAction}
            onClose={() => setContextMenu(null)}
          />
        )}
        </CanvasUpstreamReferencesProvider>
        </CanvasNodeViewProvider>
        </CanvasModelAvailabilityProvider>
        </PromptCatalogProvider>
        {(() => {
          const runNode = selectedNodeIds.length === 1 ? nodes.find((node) => node.id === selectedNodeIds[0]) : undefined
          const runActions = inspectSelectedNodeRun(runNode, { connected: serverBacked, sourceCatalog: nodeSourceCatalog, imageModels, videoModels, textModels, imageModel: mediaGroups.imageModel, videoModel: mediaGroups.videoModel, textModel: mediaGroups.textModel }, canvasCapabilities())
          return <SelectionToolbar
          readOnly={!projectCanEdit}
          count={selectedNodeIds.length}
          canGroup={resourceGroupSelectionIds(nodes, selectedNodeIds).length > 1}
          canUngroup={nodes.some((node) => node.selected && node.type === 'group')}
          allLocked={allSelectedLocked}
          canToggleDisabled={selectedDisableEligibleIds.length > 0}
          allDisabled={allSelectedDisabled}
          onAlign={alignSelection}
          onDistribute={distributeSelection}
          onCopy={() => { void copySelection() }}
          onDuplicate={() => duplicateNodes(selectedNodeIds)}
          onGroup={groupSelection}
          onUngroup={ungroupSelection}
          onToggleLocked={() => setNodeFlags(selectedNodeIds, 'locked', !allSelectedLocked)}
          onToggleDisabled={() => setNodeFlags(selectedDisableEligibleIds, 'disabled', !allSelectedDisabled)}
          onFocus={fitSelection}
          onInspect={() => openInspectorTab('node')}
          onSaveWorkshop={projectCanEdit && SaveCanvasWorkshopDialog && hostBridge().createWorkshopItem ? () => saveWorkshopSelection(selectedNodeIds) : undefined}
          onSendAgent={projectCanRun && agentScope ? sendSelectionToAgent : undefined}
          agentDisabledReason={!draftActionsEnabled ? '画布连接已停止，请重新进入工作区' : undefined}
          onBatchImages={canvasCapabilities().features.imageTools ? () => openBatchImageRelated(selectedNodeIds) : undefined}
          batchImagesDisabledReason={analyzeBatchImageRelatedSources(nodes.map(canvasNodeDocumentRecord), selectedNodeIds).disabledReason}
          onRunTo={projectCanRun && runNode && runActions ? () => { void rerunNode(runNode.id) } : undefined}
          onRunFrom={projectCanRun && runNode && runActions ? () => runFromNode(runNode.id) : undefined}
          onSelectVideoFrame={projectCanEdit && hostEntryPoints.videoFrames && runNode?.type === 'frame-extract' ? () => openFrameSelection(runNode.id) : undefined}
          onCreateFrameSequence={projectCanEdit && runNode && hostEntryPoints.videoFrames && canvasNodeKindAvailable('image-collage', canvasCapabilities()) && (runNode.type === 'video-input' || runNode.type === 'video-generate' || runNode.data.result?.kind === 'video') ? () => openFrameSequence(runNode.id) : undefined}
          frameSequenceDisabledReason={!draftActionsEnabled ? '画布连接已停止，请重新进入工作区' : running ? '运行结束后可创建分镜' : undefined}
          runDisabledReason={!draftActionsEnabled ? '画布连接已停止，请重新进入工作区。' : runActions?.disabledReason}
          onDelete={deleteSelection}
        />
        })()}
        {projectCanEdit && nodes.length === 0 && !quickInsert && <div className={`canvas-empty-state${storageMode === 'cloud' ? ' canvas-web-empty' : ''}`}>
          {storageMode === 'cloud' && <>
            <span className="canvas-web-empty-mark" aria-hidden="true">✳</span>
            <span className="canvas-web-empty-eyebrow">YOUR NEXT IDEA STARTS HERE</span>
            <h1>从一个想法，开始这张画布。</h1>
            <p>写下提示词，放入素材，再用连线把它们串起来。<br />可以自由搭建，也可以从现成的模板开始。</p>
          </>}
          <div className="canvas-empty-actions">
          <button type="button" className="is-primary" onClick={() => openTemplateCatalog()}><Sparkles size={16} />从模板开始</button>
          {storageMode === 'cloud' && <button type="button" onClick={() => addNode('prompt')}><Plus size={16} />写下提示词</button>}
          <button type="button" onClick={() => addNode('image-generate')}><Plus size={16} />新建生成节点</button>
          </div>
          {storageMode === 'cloud' && <div className="canvas-web-empty-help">
            <span>先编辑和连接内容，准备好后再运行。</span>
            <button type="button" onClick={() => setMediaConfigOpen(true)}>选择生成模型</button>
            <small>双击空白处添加内容 · 拖动连接点串联节点</small>
          </div>}
        </div>}
        <QuickInsert
          key={layerEditorScope}
          open={projectCanEdit && quickInsert !== null}
          anchor={quickInsert?.anchor ?? { x: 12, y: 12 }}
          hasNodes={nodes.length > 0}
          hasSelection={selectedNodeIds.length > 0}
          canvasNodes={nodes}
          allowedNodeTypes={quickInsert?.compatibleHandles ? Object.keys(quickInsert.compatibleHandles) : undefined}
          onInteriorTask={canvasCapabilities().features.scenarioTemplates ? openInteriorCreation : undefined}
          onExteriorTask={canvasCapabilities().features.scenarioTemplates ? openExteriorCreation : undefined}
          onStoryboardTask={canvasCapabilities().features.scenarioTemplates ? openStoryboardCreation : undefined}
          onBatchImages={quickInsert?.batchSourceIds && quickInsert.batchSourceIds.length > 1 && canvasCapabilities().features.imageTools ? () => openBatchImageRelated(quickInsert.batchSourceIds!, quickInsert.scope, quickInsert.flowPosition) : undefined}
          batchImagesDisabledReason={quickInsert?.batchSourceIds ? analyzeBatchImageRelatedSources(nodes.map(canvasNodeDocumentRecord), quickInsert.batchSourceIds).disabledReason : undefined}
          capabilities={canvasCapabilities()}
          onAddNode={(type) => {
            const connection = quickInsert?.connection
            const handleId = quickInsert?.compatibleHandles?.[type]
            if (quickInsert?.edgeId && handleId) insertNodeOnEdge(type, quickInsert.flowPosition, quickInsert.edgeId, handleId)
            else if (connection && handleId) addConnectedNode(type, quickInsert?.flowPosition, connection, handleId)
            else addNode(type, quickInsert?.flowPosition)
          }}
          onLoadTemplate={(templateId) => openTemplateCatalog(templateId)}
          onCommand={(command: QuickInsertCommand) => {
            if (command === 'fit-all') fitCanvas()
            else if (command === 'fit-selection') fitSelection()
            else showAssetTray()
          }}
          onLocateNode={locateNode}
          onClose={() => setQuickInsert(null)}
        />
        {banner && <div className="canvas-toast" role="status" aria-live="polite"><span>{banner}</span><button type="button" aria-label="关闭提示" onClick={() => setBanner(null)}><X size={13} /></button></div>}
        {(saveConflict || draftStorageError) && <div className="canvas-draft-notices">
          {saveConflict && <section className="canvas-draft-notice" role="alert" aria-label="保存冲突">
            <strong>{historyPendingRef.current || historyRecoveryErrorRef.current ? '版本恢复需要核对，自动保存已暂停' : '保存冲突，自动保存已暂停'}</strong>
            <p>{saveConflict}</p>
            <nav aria-label="保存冲突处理">
              {(historyPendingRef.current || historyRecoveryErrorRef.current) && <button type="button" className="is-primary" disabled={draftActionBusy || historyBusy} onClick={openProjectHistory}>核对版本恢复</button>}
              <button type="button" className="is-primary" disabled={draftActionBusy} onClick={() => void saveConflictAsNewProject()}>另存为新工程</button>
              <button type="button" disabled={draftActionBusy} onClick={() => void save()}>导出当前内容</button>
              <button type="button" disabled={draftActionBusy} onClick={() => void reloadCloudProject()}>重新读取云端</button>
            </nav>
          </section>}
          {draftStorageError && <section className="canvas-draft-notice" role="alert" aria-label="本地草稿存储问题">
            <strong>本地草稿存储需要处理</strong>
            <p>{draftStorageError}</p>
            <nav aria-label="草稿存储问题处理">
              <button type="button" disabled={draftActionBusy || draftLocalActionBusy} onClick={() => void save()}>导出当前内容</button>
              <button type="button" disabled={!draftActionsEnabled || draftActionBusy || draftLocalActionBusy} onClick={(event) => openLocalDraftManager(event.currentTarget)}>管理本地草稿</button>
              <button type="button" disabled={!draftActionsEnabled || draftActionBusy || draftLocalActionBusy} onClick={() => void retryLocalDraftSave()}>{draftLocalActionBusy ? '正在核对…' : '重试保存'}</button>
            </nav>
          </section>}
        </div>}
        {templateDialog}
        {commerceDialog}
        {interiorDialog}
        {exteriorDialog}
        {storyboardDialog}
        {batchImageRelated && batchImageRelated.scope === layerEditorScope && draftActionsEnabled && <BatchImageRelatedDialog sources={batchImageRelated.sources} error={batchImageRelatedError} onConfirm={confirmBatchImageRelated} onClose={() => { batchImageRelatedRef.current = null; setBatchImageRelated(null); setBatchImageRelatedError(undefined) }} />}
        {projectCanEdit && workshopSelection && workshopSelection.scopeKey === layerEditorScope && SaveCanvasWorkshopDialog && <SaveCanvasWorkshopDialog key={workshopSelection.scopeKey} workflow={workshopSelection.workflow} scopeKey={workshopSelection.scopeKey} initialTargetId={workshopSelection.targetId} isCurrent={() => agentMountedRef.current && draftActionsEnabledRef.current && projectCanEditRef.current && !projectTransitionRef.current && currentWorkshopSetupScope() === workshopSelection.scopeKey} onClose={() => setWorkshopSelection(null)} onSaved={(item) => { setWorkshopSelection(null); setBanner(`已保存「${item.name}」到我的创意工坊`) }} onUpdated={(receipt) => { setWorkshopSelection(null); setBanner(`工坊配置已提交为 v${receipt.committedVersion}；已插入画布、社区发布和已有分享保持独立。`) }} />}
        {workshopDialog}
        {workshopAssetPicker && workshopAssetPicker.scopeKey === layerEditorScope && WorkshopAssetPickerDialog && <WorkshopAssetPickerDialog key={`${layerEditorScope}:${workshopAssetPicker.nodeId}:${workshopAssetPicker.mediaType}`} label={workshopAssetPicker.title} mediaType={workshopAssetPicker.mediaType} scopeKey={layerEditorScope} fallbackPage={assetPage} onListAssets={listAssetsForTemplate} officialAccess={officialAssetAccess} onChoose={chooseWorkshopAsset} onClose={closeWorkshopAssetPicker} onAcquired={() => void refreshAssets()} />}
        {workshopModelMappingSession && workshopModelMappingSession.scopeKey === layerEditorScope && draftActionsEnabled && WorkshopModelMappingDialog && <WorkshopModelMappingDialog rows={workshopModelMapping.rows} sources={workshopModelMapping.sources} choices={workshopModelMappingChoices} phase={workshopModelMappingReview ? 'review' : 'editing'} issues={workshopModelMappingReview?.issues} changedCount={workshopModelMappingChangedCount} busy={workshopModelMappingBusy} error={workshopModelMappingError} onChange={changeWorkshopModelMapping} onReview={reviewWorkshopModelMapping} onApply={() => void applyWorkshopModelMapping()} onCancel={closeWorkshopModelMapping} onBack={() => { workshopModelMappingReviewRef.current = null; setWorkshopModelMappingReview(null); setWorkshopModelMappingError(undefined) }} />}
        {workshopSetupOpen && workshopSetup && WorkshopSetupPanel && <WorkshopSetupPanel setup={workshopSetup} readOnly={!projectCanEdit} busy={workshopSetupBusy} error={workshopSetupError}
          reviewDisabledReason={!projectCanRun ? '共享项目暂未开放运行，请由项目拥有者执行。' : undefined}
          availableScopes={workshopSetupSession?.insertedNodeIds ? ['inserted', 'selection', 'all'] : ['selection', 'all']}
          onLocate={locateWorkshopSetupNode} onAction={(item) => void actOnWorkshopSetup(item)} onPickLibrary={(item) => void actOnWorkshopSetup(item, true)} onScopeChange={changeWorkshopSetupScope} onReviewRun={reviewWorkshopSetupRun} onModelMapping={() => void openWorkshopModelMapping()} onClose={closeWorkshopSetup} />}
        {renamingNode && <CanvasNodeRenameDialog name={renamingNode.name} onClose={() => setRenamingNode(null)} onConfirm={(name) => { const target = nodes.find((node) => node.id === renamingNode.id); if (target) execute({ type: 'update-node-data', nodeId: target.id, patch: { settings: { ...target.data.settings, title: name } } }); setRenamingNode(null) }} />}
        <div className="canvas-statusbar" aria-label="画布状态">
          <span>{selectedNodeIds.length ? `已选 ${selectedNodeIds.length}` : `${nodes.length} 个节点 · ${edges.length} 条连线`}</span>
          {dirtyNodeIds.size > 0 && <span>{dirtyNodeIds.size} 个待更新</span>}
          <span>{canvasViewportZoomLabel(viewport.zoom)}</span>
          <span className="canvas-status-media" title={mediaConnectionLabel}>{mediaConnectionLabel}</span>
          {activeProject && <span className={`canvas-autosave is-${historyPendingRef.current || historyRecoveryErrorRef.current ? 'pending' : autoSaveState}`}>{!projectCanEdit ? projectAccessState?.denied ? '本机草稿 · 暂不可保存' : '只读浏览' : historyPendingRef.current || historyRecoveryErrorRef.current ? '恢复待核对 · 自动保存已暂停' : autoSaveState === 'saving' ? '保存中…' : autoSaveState === 'pending' ? '待保存' : autoSaveState === 'failed' ? '保存失败' : autoSaveState === 'idle' ? '尚未保存' : '已自动保存'}</span>}
        </div>
        {/* Canvas-local navigation only. "Fit all" lives in the toolbar with the
            other commands; duplicating it here made two controls with one job. */}
        <div className="canvas-navigation-tools" aria-label="画布导航">
          {!workshopSetupOpen && workshopSetupSession?.scopeKey === layerEditorScope && <button type="button" title="继续准备创作" aria-label="继续准备创作" disabled={!draftActionsEnabled || projectTransition} onClick={() => openWorkshopSetup()}><ListChecks size={15} /></button>}
          {CanvasWorkshopLibraryDialog && hostBridge().listWorkshopItems && <button type="button" title="我的创意工坊" aria-label="打开我的创意工坊" onClick={() => setWorkshopCatalog({})}><BookmarkPlus size={15} /></button>}
          <button type="button" title={uiPreferences.snapEnabled !== false ? '关闭自动吸附' : '开启自动吸附'} aria-label={uiPreferences.snapEnabled !== false ? '关闭自动吸附' : '开启自动吸附'} aria-pressed={uiPreferences.snapEnabled !== false} onClick={() => { setSnapGuides([]); setUiPreferences((current) => ({ ...current, snapEnabled: current.snapEnabled === false })) }}><Magnet size={15} /></button>
          <button type="button" title={uiPreferences.connectionsHidden ? '显示连线' : '隐藏连线'} aria-label={uiPreferences.connectionsHidden ? '显示连线' : '隐藏连线'} aria-pressed={uiPreferences.connectionsHidden === true} onClick={() => setUiPreferences((current) => ({ ...current, connectionsHidden: !current.connectionsHidden }))}><Unplug size={15} /></button>
          <button type="button" title="输入区跟随节点" aria-label="输入区跟随节点" aria-pressed={uiPreferences.composerFollowNode === true} onClick={() => setUiPreferences((current) => ({ ...current, composerFollowNode: !current.composerFollowNode }))}><MessageSquareText size={15} /></button>
          <CanvasShortcutHelp />
          <button type="button" title="恢复 100% 视图" aria-label="恢复 100% 视图" onClick={() => { cancelInsertionViewportNavigation(); createdNodeFocusRef.current?.cancel(); viewportRestorationRef.current?.cancel(); void reactFlow.zoomTo(1, { duration: 180 }) }}>1:1</button>
          <button type="button" title="聚焦选中节点" aria-label="聚焦选中节点" onClick={fitSelection} disabled={!selectedNodeIds.length}><Focus size={15} /></button>
          <button type="button" title={minimapOpen ? '隐藏缩略图' : '显示缩略图'} aria-label={minimapOpen ? '隐藏缩略图' : '显示缩略图'} aria-pressed={minimapOpen} onClick={() => setMinimapOpen((open) => !open)}><MapIcon size={15} /></button>
        </div>
      </div>
      {projectCanRun && agentScope && CanvasAgentPanel && <CanvasAgentPanel client={agentClient} mcpClient={mcpClient} scope={agentScope} open={agentOpen && !focusMode}
        nodes={nodes.map((node) => buildCanvasAgentContextNode(toWorkflowNode(node), resourceNodeTitle(node)))}
        contextRequest={agentContextRequest}
        selectedNodeIds={selectedNodeIds} groups={groups} textModels={textModels} textGroup={textGroup} textModel={mediaGroups.textModel}
        mediaModelCatalog={agentMediaCatalog.items} mediaModelCatalogLoading={agentMediaCatalog.loading} mediaModelCatalogError={agentMediaCatalog.error} onRefreshMediaModels={agentMediaCatalog.reload}
        onPrepare={prepareAgentTurn} onApply={applyAgentTurn} onListAssets={listAgentImageAssets} onReadImageAsset={readAgentImageAsset} onImportImage={importAgentImage} onLocatePlan={focusAgentPlan}
        automationRevision={agentAutomationRevision} getAutomationRevision={getAgentAutomationRevision}
        onApplyApproved={applyApprovedAgentTurn} onRunApproved={runApprovedAgentTurn} onContinueApproved={continueApprovedAgentTurn}
        executionRefreshKey={agentExecutionRefreshKey}
        onReadExecutionAsset={readAgentExecutionAsset} onPreviewExecutionAsset={previewAgentExecutionAsset} onDownloadExecutionAsset={downloadAgentExecutionAsset}
        onReadExecutionPreflight={prepareAgentExecutionResume}
        onResumeExecution={(execution) => controlAgentExecution(execution, 'resume')} onCancelExecution={(execution) => controlAgentExecution(execution, 'cancel')}
        onRun={(turn) => {
          if (!agentScope.active() || turn.projectId !== agentScope.projectId || turn.state !== 'applied' || turn.supersededBy || !turn.proposal) { setBanner('原 Agent 提案已变化，请重新核对这条需求'); return }
          const ids = canvasAgentProposalTargetNodeIds(turn.proposal)
          if (ids.some((id) => !nodes.some((node) => node.id === id))) { setBanner('原提案的节点已删除，请在当前画布重新选择运行范围'); return }
          const eligible = ids.filter((id) => nodes.some((node) => node.id === id && isCanvasRunnableTarget(node)))
          if (!eligible.length) { setBanner('提案中没有当前可运行的节点，请核对停用状态'); return }
          void run({ kind: 'selection', nodeIds: eligible }, { origin: { version: 1, sessionId: turn.sessionId, turnId: turn.id, proposalDigest: turn.proposal.digest }, scopeKey: currentWorkshopSetupScope(), label: turn.prompt.length > 100 ? `${turn.prompt.slice(0, 100)}…` : turn.prompt })
        }}
        onConfigureModels={() => { setMediaConfigOpen(true); setRunMenuOpen(false); setMoreActionsOpen(false) }}
        onLocateNode={(id) => { const target = nodes.find((node) => node.id === id); if (target) { setNodes((current) => current.map((node) => ({ ...node, selected: node.id === id }))); fitCanvasNodes([id], 1.1) } }}
        onClose={() => setAgentOpen(false)} />}
      {inspectorShown && (
        <CanvasInspector
          readOnly={!projectCanEdit}
          canRun={projectCanRun}
          tab={inspectorTab}
          nodes={selectedInspectorNodes}
          imageModels={imageModels}
          videoModels={videoModels}
          textModels={textModels}
          sourceCatalog={nodeSourceCatalog}
          onTabChange={openInspectorTab}
          onClose={closeInspector}
          onLocate={locateNode}
          onRun={(nodeId) => void rerunNode(nodeId)}
          onToggleLocked={(nodeId, locked) => setInspectorNodeFlag(nodeId, 'locked', locked)}
          onToggleDisabled={(nodeId, disabled) => setInspectorNodeFlag(nodeId, 'disabled', disabled)}
          onPreview={(node) => node.outputText ? textNodeAction(node.id, 'result', 'open') : node.previewAsset && setPreviewAsset({ ...node.previewAsset })}
          dramaAlerts={collectDramaShotAlerts(nodes, edges)}
          capabilities={canvasCapabilities()}
        >
          {inspectorTab === 'assets' && (
            <AssetTray
              embedded
              page={assetPage}
              query={assetQuery}
              loading={assetsLoading}
              onQueryChange={changeAssetQuery}
              onRefresh={() => void refreshAssets()}
              onImport={() => void pickLibraryAssetToCanvas()}
              categoryDirectory={assetCategoryState.scope === assetCategoryOwnerScope ? assetCategoryState.directory : null}
              categoryLoading={assetCategoryState.scope === assetCategoryOwnerScope && assetCategoryState.loading}
              categoryError={assetCategoryState.scope === assetCategoryOwnerScope ? assetCategoryState.error : ''}
              recoverableMutations={assetMutationSupported}
              mutationWritesBlocked={directAssetMutations ? !draftActionsEnabled : !assetMutationSupported || !assetMutationRecovery.ready || !assetMutationRecovery.writeAvailable || Boolean(assetMutationRecovery.pending) || assetMutationRecovery.busy}
              mutationRecoveryNotice={directAssetMutations ? undefined : assetMutationSupported ? <AssetMutationRecoveryPanel journal={assetMutationRecovery} onChanged={() => void refreshAssets()} /> : <p role="status">收藏、改名、标签和回收暂不可用。彻底删除仍按原来的确认流程处理。</p>}
              onFavoriteMany={assetMutationSupported ? favoriteCanvasAssets : undefined}
              categoryRecoveryPending={Boolean(assetCategoryRecovery.pending)}
              categoryRecoveryNotice={<AssetCategoryRecoveryNotice state={assetCategoryRecovery} onReload={assetCategoryRecovery.reload} />}
              categorySelectionRevision={assetCategorySelectionRevision}
              onReadCategories={assetCategorySupported ? () => { void readAssetCategories().catch(() => undefined) } : undefined}
              onManageCategories={assetCategorySupported ? openAssetCategoryManager : undefined}
              onMoveCategory={assetCategorySupported ? openAssetCategoryMove : undefined}
              onAdd={addAssetNode}
              onAddMany={projectCanEdit && hostEntryPoints.batchAdd ? addAssetNodes : undefined}
              onDownloadMany={hostEntryPoints.batchDownload ? downloadAssetNodes : undefined}
              batchScope={layerEditorScope}
              officialAccess={officialAssetAccess}
              readOnly={!projectCanEdit}
              onAssetMenu={(assetId) => void hostBridge().showAssetMenu(assetId)}
              onReadAssetOrigin={hostEntryPoints.assetOrigin ? readCanvasAssetOrigin : undefined}
              onReadDetail={readCanvasAssetDetail}
              onRename={directAssetMutations ? renameCanvasAssetDirectly : renameCanvasAsset}
              onUpdateMetadata={directAssetMutations ? updateCanvasAssetMetadataDirectly : updateCanvasAssetMetadata}
              onInspectReferences={(assetId) => hostBridge().inspectAssetReferences(assetId, serializeWorkflow(workflowSnapshot()))}
              onCheckRunInputs={async (assetId, retryUnavailable) => {
                const bridge = hostBridge()
                if (!bridge.checkAssetRunInputs) throw new Error('当前宿主暂不支持旧运行输入核查')
                return bridge.checkAssetRunInputs(assetId, serializeWorkflow(workflowSnapshot()), retryUnavailable)
              }}
              onDelete={deleteCanvasAssets}
              onRestore={restoreCanvasAssets}
              onPurge={(assetIds) => purgeCanvasAssets(assetIds, serializeWorkflow(workflowSnapshot()))}
              onClose={closeInspector}
            />
          )}
          {inspectorTab === 'runs' && (
            <RunInspector
              VideoTaskRecovery={VideoTaskRecovery}
              embedded
              onOpenAssets={showAssetTray}
              onOpenAgent={projectCanRun && agentScope ? () => { setAgentOpen(true); setFocusMode(false) } : undefined}
              open
              records={runRecords}
              selectedRunId={selectedRunId}
              resultAssets={Object.fromEntries(nodes.map((node) => [node.id, node.data.result]))}
              selectedScope={runScopeKind}
              dirtyCount={dirtyNodeIds.size}
              selectionCount={selectedNodeIds.length}
              loading={runsLoading}
              error={runsError}
              onScopeChange={setRunScopeKind}
              onRefresh={() => void refreshRuns()}
              onOpenCollection={projectCanRun && hostEntryPoints.runResultCollection ? openRunResultCollection : undefined}
              onResumeRun={async (runId) => {
                const resumed = await hostBridge().resumeRun?.(runId) ?? false
                await refreshRuns(runId)
                return resumed
              }}
              onSelectRun={setSelectedRunId}
              onUseCandidate={useCandidate}
              onAddMany={projectCanEdit && hostEntryPoints.batchAdd ? addAssetNodes : undefined}
              onDownloadMany={hostEntryPoints.batchDownload ? downloadAssetNodes : undefined}
              batchScope={layerEditorScope}
              onPreviewAsset={(asset) => setPreviewAsset({ ...asset })}
              onAssetMenu={(assetId) => void hostBridge().showAssetMenu(assetId)}
              onLocateNode={locateNode}
              onRetryNode={(nodeId, scope) => { requestNodeScopeRun(nodeId, scope) }}
              onClose={closeInspector}
            />
          )}
        </CanvasInspector>
      )}
      </div>
      <ModelSuggestions />
      {runResultCollectionSession && runResultCollectionSession.runtimeScope === layerEditorScope && projectCanRun && <RunResultCollectionDialog
        key={runResultCollectionSession.runtimeScope}
        scope={runResultCollectionSession.scope}
        runtimeScope={runResultCollectionSession.runtimeScope}
        initialRunId={runResultCollectionSession.initialRunId}
        onListHistory={(query, signal) => listRunResultCollectionHistory(runResultCollectionSession, query, signal)}
        onReadRun={(runId, signal) => readRunResultCollectionHistory(runResultCollectionSession, runId, signal)}
        onReadAsset={(assetId, signal) => readRunResultCollectionAsset(runResultCollectionSession, assetId, signal)}
        onAddMany={projectCanEdit ? (ids) => applyRunResultCollection(runResultCollectionSession, 'add', ids) : undefined}
        onDownloadMany={(ids) => applyRunResultCollection(runResultCollectionSession, 'download', ids)}
        onPreviewAsset={(asset) => { assertRunResultCollectionCurrent(runResultCollectionSession); setPreviewAsset({ ...asset }) }}
        onClose={() => closeRunResultCollection(runResultCollectionSession)}
      />}
      {frameSequenceSession && frameSequenceSession.scope === layerEditorScope && projectCanEdit && <VideoFrameEditor key={`sequence:${frameSequenceSession.scope}:${frameSequenceSession.snapshot.sourceNodeId}:${frameSequenceSession.asset.assetId}`} asset={frameSequenceSession.asset} initialTimestampSeconds={0} title="创建视频分镜" loadVideo={loadFrameSequenceVideo} onApply={async () => { throw new Error('请通过创建分镜按钮保存序列') }} onApplySequence={applyFrameSequence} onClose={() => { frameSequenceSessionRef.current = null; setFrameSequenceSession(null) }} />}
      {frameSession && frameSession.scope === layerEditorScope && draftActionsEnabled && <VideoFrameEditor key={`${frameSession.scope}:${frameSession.snapshot.nodeId}:${frameSession.asset.assetId}`} asset={frameSession.asset} initialTimestampSeconds={frameSession.snapshot.timestampSeconds} loadVideo={loadFrameVideo} onApply={applyFrameSelection} onClose={() => { frameSessionRef.current = null; setFrameSession(null) }} />}
      {textSession && textSession.scope === layerEditorScope && draftActionsEnabled && <CanvasTextEditor
        key={textSession.id} title={textSession.title} value={textSession.value} readOnly={textSession.selection === 'result'} maxLength={100_000} notice={textSession.notice}
        onSave={textSession.selection === 'input' ? (text, signal) => performTextAction(textSession, 'save', text, signal) : undefined}
        onCopy={(text, signal) => performTextAction(textSession, 'copy', text, signal)}
        onDownload={hostEntryPoints.pageDownload ? (text, signal) => performTextAction(textSession, 'download', text, signal) : undefined}
        onCreateText={textSession.selection === 'result' ? (text, signal) => performTextAction(textSession, 'place', text, signal) : undefined}
        onSavePreset={(text, signal) => performTextAction(textSession, 'preset', text, signal)}
        createTextDisabledReason={running ? '请等待当前运行结束' : undefined}
        savePresetDisabledReason={running ? '请等待当前运行结束' : undefined}
        onClose={() => setTextSession(null)}
      />}
      {annotationSession && annotationSession.scope === layerEditorScope && draftActionsEnabled && <ImageAnnotationEditor key={`${annotationSession.scope}:${annotationSession.nodeId}:${annotationSession.asset.assetId}`} asset={annotationSession.asset} onSave={(recipe, mode, signal) => saveImageAnnotation(recipe, mode, signal)} onDownload={hostEntryPoints.pageDownload ? (recipe, signal) => saveImageAnnotation(recipe, 'download', signal) : undefined} onClose={() => { annotationSessionRef.current = null; setAnnotationSession(null) }} />}
      {imageMaskSession && imageMaskSession.scope === layerEditorScope && draftActionsEnabled && <ImageMaskEditor key={`${imageMaskSession.scope}:${imageMaskSession.nodeId}:${imageMaskSession.source.asset.assetId}`} asset={imageMaskSession.source.asset} initial={imageMaskSession.initial} saveLabel={imageMaskSession.from === 'output' ? '创建 AI 局部修改节点' : '保存 AI 局部修改蒙版'} onApply={applyImageMask} onSaveAsset={saveImageMaskAsset} allowDownload={hostEntryPoints.pageDownload} allowLinkedAsset allowReplaceAsset={imageMaskSession.from === 'output'} onClose={() => { imageMaskSessionRef.current = null; setImageMaskSession(null) }} />}
      <MediaLightbox
        asset={previewAsset}
        onClose={() => setPreviewAsset(null)}
        onAssetMenu={(assetId) => void hostBridge().showAssetMenu(assetId)}
      />
      {dramaParseConfirm && (
        <DramaParseConfirm
          tables={dramaParseConfirm.tables}
          onCancel={() => setDramaParseConfirm(null)}
          onConfirm={(selection: DramaConfirmSelection) => {
            const bible = nodes.find((entry) => entry.type === 'drama-bible')
            const laid = buildDramaNodesFromTables(dramaParseConfirm.tables, {
              createId: nextNodeId,
              origin: { x: 80, y: 80 },
              includeBible: !bible,
              bibleId: bible?.id,
              selection,
            })
            execute({ type: 'add-nodes', nodes: laid.nodes, edges: laid.edges })
            setDramaParseConfirm(null)
            setBanner('已落成资产与分镜，未创建出图节点')
          }}
        />
      )}
      {runPreflight && (
        <RunPreflight
          preflight={runPreflight}
          groups={groups}
          agentRequestLabel={pendingCanvasRun?.agentExecution?.label}
          onCancel={() => { setRunPreflight(null); setPendingCanvasRun(null) }}
          onConfigure={() => {
            setRunPreflight(null)
            setPendingCanvasRun(null)
            setMediaConfigOpen(true)
          }}
          onLocateNode={(nodeId) => {
            setRunPreflight(null)
            setPendingCanvasRun(null)
            setAgentOpen(false)
            locateNode(nodeId)
          }}
          onConfirm={() => void confirmCanvasRun()}
        />
      )}
    </div>
  )
}
