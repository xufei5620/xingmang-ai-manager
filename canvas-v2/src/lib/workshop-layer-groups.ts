import type { ImageLayerRecipe } from '../image-tools/recipe'

/** Group identities have no meaning outside this recipe. A portable snapshot
 * must not expose author-chosen opaque identifiers; private documents keep
 * their identities so reopened selection and grouping remain stable. */
export function sanitizeWorkshopLayerGroups(recipe: ImageLayerRecipe, redactName: (name: string) => string, portable = false): ImageLayerRecipe {
  if (!recipe.layerGroups) return recipe
  const grouping = recipe.layerGroups
  const ids = new Map<string, string>(grouping.layerIds.map((id, index) => [id, `layer-${index + 1}`]))
  for (const [index, group] of grouping.groups.entries()) ids.set(group.id, `group-${index + 1}`)
  return { ...recipe, layerGroups: { version: 1, layerIds: grouping.layerIds.map((id) => portable ? ids.get(id)! : id), groups: grouping.groups.map((group) => ({ ...group, id: portable ? ids.get(group.id)! : group.id, name: redactName(group.name).slice(0, 80) || '图层组', children: group.children.map((id) => portable ? ids.get(id)! : id) })) } }
}
