import type { SessionDownloadOwner, SessionReadOwnerRoute } from '@/api/client'

interface DownloadOwnerEvidence {
  durableOwner: (id: string) => SessionReadOwnerRoute | null | string | undefined
  hasStoredId: (id: string) => boolean
  isRuntime: (id: string) => boolean
  runtimeOwner: (id: string) => SessionReadOwnerRoute | null | string | undefined
  storedId: (id: string) => null | string
}

const profileNames = (owner: SessionReadOwnerRoute | string) =>
  typeof owner === 'string' ? [owner] : [owner.profile, owner.targetProfile].filter(Boolean)

export function durableDownloadOwner(candidates: (SessionReadOwnerRoute | null | string | undefined)[]) {
  return candidates.find(owner => owner && typeof owner !== 'string' && owner.connectionId) ?? candidates.find(Boolean)
}

/** Downloads require durable identity; the RPC ladder may still use live runtimes. */
export function resolveSessionFileDownloadOwner(id: string, evidence: DownloadOwnerEvidence): SessionDownloadOwner {
  const stored = evidence.hasStoredId(id) ? id : evidence.storedId(id)

  if (!stored && evidence.isRuntime(id)) {
    throw new Error('Gateway file session has no stored identity yet')
  }

  const sessionId = stored ?? id
  const durable = evidence.durableOwner(sessionId)
  const runtime = sessionId !== id ? evidence.runtimeOwner(id) : null

  if (!durable) {
    return { owner: runtime, sessionId }
  }

  if ((typeof durable !== 'string' && durable.connectionId) || !runtime) {
    return { owner: durable, sessionId }
  }

  // A bare profile cannot select between two hosts exposing that profile.
  if (!profileNames(runtime).some(name => profileNames(durable).includes(name))) {
    throw new Error('Gateway file session does not belong to its runtime owner')
  }

  return { owner: runtime, sessionId }
}
