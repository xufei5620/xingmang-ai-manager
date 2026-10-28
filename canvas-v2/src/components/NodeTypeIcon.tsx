import { ArrowDownToLine, Clapperboard, Film, GitBranch, Image, Layers3, MessageSquareText, Music2, Sparkles, WandSparkles, type LucideIcon } from 'lucide-react'
import type { NodeCategory } from '../domain/node-definition'

const categoryIcons: Record<NodeCategory, LucideIcon> = {
  input: MessageSquareText,
  generation: Sparkles,
  transform: WandSparkles,
  flow: GitBranch,
  output: ArrowDownToLine,
  structural: Layers3,
  drama: Clapperboard,
}

function resolveNodeTypeIcon(type: string, category: NodeCategory): LucideIcon {
  if (type.startsWith('image-')) return Image
  if (type.startsWith('video-') || type === 'frame-extract') return Film
  if (type.startsWith('audio-')) return Music2
  return categoryIcons[category]
}

export function NodeTypeIcon({ type, category, size = 17 }: { type: string; category: NodeCategory; size?: number }) {
  const Icon = resolveNodeTypeIcon(type, category)
  return <Icon size={size} aria-hidden="true" />
}
