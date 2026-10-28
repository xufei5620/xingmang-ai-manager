import type { ProjectImportAssetReceipt } from './project-import-asset-receipt'
import { projectProvenanceDigestFields, type ProjectProvenance } from './project-provenance'

/** Retries confirm the first snapshot even if the source is edited afterward. */
export async function createDuplicateProjectCreationDigest(sourceProjectId: string, name: string): Promise<string> {
  const serialized = JSON.stringify({ method: 'duplicateProject', sourceProjectId: sourceProjectId.toLowerCase(), name: name.trim() })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

/** Keep the original import serialization stable, including omission of empty manifests. */
export async function createWorkflowImportCreationDigest(
  content: string,
  policy: 'drop' | 'reject',
  packageAssets: readonly ProjectImportAssetReceipt[] = [],
  packageProvenance: readonly ProjectProvenance[] = [],
): Promise<string> {
  const serialized = JSON.stringify({ content, policy,
    ...(packageAssets.length ? { packageAssets } : {}),
    ...projectProvenanceDigestFields(packageProvenance),
  })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}
