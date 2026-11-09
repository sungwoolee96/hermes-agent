import { afterEach, expect, it, vi } from 'vitest'

import { sessionDownloadOwner, sessionReadOwnerPin } from '@/api/client'
import { createClientSessionState } from '@/lib/chat-runtime'
import { downloadGatewayMediaFile } from '@/lib/media'
import { $activeSessionId, $connection, $selectedStoredSessionId, _resetSessionOwnerHintsForTests, setSessionOwnerHint, setSessions } from '@/store/session'
import { resolveSessionFileDownloadOwner } from '@/store/session-file-download-owner'
import {
  $sessionTiles,
  clearAllSessionStates,
  knownOwnerForSession,
  publishSessionState,
  recordSessionEventScope
} from '@/store/session-states'
import { makeSessionInfo } from '@/test/session-info'

const path = '/srv/project/file.txt'

afterEach(() => {
  $activeSessionId.set(null)
  $selectedStoredSessionId.set(null)
  $connection.set(null)
  $sessionTiles.set([])
  clearAllSessionStates()
  setSessions([])
  _resetSessionOwnerHintsForTests({ storage: true })
  vi.unstubAllGlobals()
})

it.each(['row', 'hint', 'tile'])('keeps a %s stored identity ahead of a stale runtime binding', kind => {
  publishSessionState('collision', createClientSessionState('wrong-stored'))
  setSessionOwnerHint('wrong-stored', { connectionId: 'wrong-host', profile: 'default' })
  const owner = { connectionId: 'local', profile: 'manager' }

  if (kind === 'row') {
    setSessions([makeSessionInfo({ id: 'collision', profile: 'manager', connection_id: 'local' })])
  } else if (kind === 'hint') {
    setSessionOwnerHint('collision', owner)
  } else {
    $sessionTiles.set([{ storedSessionId: 'collision', ownerRoute: owner }])
  }

  expect(sessionDownloadOwner('collision')).toEqual({ sessionId: 'collision', owner })
})

it.each(['local', 'host-b'])('canonicalizes runtime identity and retains its proven %s connection over profile-only rows', async connectionId => {
  publishSessionState('runtime', createClientSessionState('stored'))
  recordSessionEventScope({ session_id: 'runtime', profile: 'manager', connectionId })
  setSessions([makeSessionInfo({ id: 'stored', profile: 'manager' })])
  const saveGatewayFile = vi.fn().mockResolvedValue({ saved: true })
  vi.stubGlobal('hermesDesktop', { saveGatewayFile })

  await downloadGatewayMediaFile(path, { sessionId: 'runtime' })

  expect(saveGatewayFile).toHaveBeenCalledExactlyOnceWith({ connectionId, profile: 'manager', sessionId: 'stored', path, suggestedName: 'file.txt' })
})

it('prefers a durable exact alias route over a profile-only tile', () => {
  publishSessionState('runtime', createClientSessionState('stored'))
  $sessionTiles.set([{ storedSessionId: 'stored', ownerProfile: 'manager' }])
  // Tile/runtime binding can provide the exact backend alias through a durable route.
  setSessionOwnerHint('stored', { connectionId: 'host', profile: 'display-manager', targetProfile: 'manager' })
  expect(sessionDownloadOwner('runtime')).toEqual({ sessionId: 'stored', owner: { connectionId: 'host', profile: 'display-manager', targetProfile: 'manager' } })
})

it('rejects a profile-only durable/runtime mismatch without changing the RPC/read ladder', async () => {
  publishSessionState('runtime', createClientSessionState('stored'))
  recordSessionEventScope({ session_id: 'runtime', profile: 'other', connectionId: 'host-b' })
  setSessions([makeSessionInfo({ id: 'stored', profile: 'manager' })])
  const saveGatewayFile = vi.fn()
  vi.stubGlobal('hermesDesktop', { saveGatewayFile })

  expect(knownOwnerForSession('runtime')).toEqual({ connectionId: 'host-b', profile: 'other' })
  expect(sessionReadOwnerPin('runtime')).toEqual({ connectionId: 'host-b', profile: 'other' })
  await expect(downloadGatewayMediaFile(path, { sessionId: 'runtime' })).rejects.toThrow('does not belong')
  expect(saveGatewayFile).not.toHaveBeenCalled()
})

it('keeps a durable exact route above a stale runtime event', () => {
  publishSessionState('runtime', createClientSessionState('stored'))
  recordSessionEventScope({ session_id: 'runtime', profile: 'other', connectionId: 'host-b' })
  const owner = { connectionId: 'local', profile: 'display-manager', targetProfile: 'manager' }
  setSessionOwnerHint('stored', owner)

  expect(sessionDownloadOwner('runtime')).toEqual({ sessionId: 'stored', owner })
})

it.each(['mirror', 'event', 'active'])('rejects a known live-only %s runtime even with an explicit owner', async kind => {
  if (kind === 'mirror') {
    publishSessionState('runtime', createClientSessionState(null))
  } else if (kind === 'event') {
    recordSessionEventScope({ session_id: 'runtime', profile: 'manager', connectionId: 'local' })
  } else {
    $activeSessionId.set('runtime')
    $selectedStoredSessionId.set('unproven-selected')
  }

  const saveGatewayFile = vi.fn()
  vi.stubGlobal('hermesDesktop', { saveGatewayFile })

  await expect(downloadGatewayMediaFile(path, { sessionId: 'runtime', owner: { profile: 'manager' } })).rejects.toThrow('no stored identity')
  expect(saveGatewayFile).not.toHaveBeenCalled()
})

it('rejects implicit unknown ownership but retains explicitly scoped unlisted artifacts', async () => {
  const saveGatewayFile = vi.fn().mockResolvedValue({ saved: true })
  vi.stubGlobal('hermesDesktop', { saveGatewayFile })

  await expect(downloadGatewayMediaFile(path, { sessionId: 'unlisted' })).rejects.toThrow('owner is unknown')
  expect(saveGatewayFile).not.toHaveBeenCalled()
  await downloadGatewayMediaFile(path, { sessionId: 'unlisted', profile: 'manager' })
  expect(saveGatewayFile).toHaveBeenCalledExactlyOnceWith({ path, sessionId: 'unlisted', profile: 'manager', suggestedName: 'file.txt' })
})

it('retains an exact runtime route whose backend alias matches durable profile evidence', () => {
  const owner = { connectionId: 'host-b', profile: 'display-manager', targetProfile: 'manager' }
  expect(resolveSessionFileDownloadOwner('runtime', {
    durableOwner: () => 'manager',
    hasStoredId: () => false,
    isRuntime: () => true,
    runtimeOwner: () => owner,
    storedId: () => 'stored'
  })).toEqual({ sessionId: 'stored', owner })
})

it('keeps even ambiguous stored hints ahead of a colliding runtime mapping', () => {
  publishSessionState('collision', createClientSessionState('wrong-stored'))
  setSessionOwnerHint('wrong-stored', { connectionId: 'wrong-host', profile: 'default' })
  setSessionOwnerHint('collision', { connectionId: 'host-a', profile: 'manager' })
  setSessionOwnerHint('collision', { connectionId: 'host-b', profile: 'manager' })

  expect(sessionDownloadOwner('collision')).toEqual({ sessionId: 'collision', owner: null })
})

it('keeps the canonical payload during a real-store session switch pending at the bridge', async () => {
  publishSessionState('runtime', createClientSessionState('stored'))
  setSessionOwnerHint('stored', { connectionId: 'local', profile: 'display-manager', targetProfile: 'manager' })
  let complete!: (result: { saved: boolean }) => void
  const saveGatewayFile = vi.fn(() => new Promise(resolve => { complete = resolve }))
  vi.stubGlobal('hermesDesktop', { saveGatewayFile })

  const pending = downloadGatewayMediaFile(path, { sessionId: 'runtime' })
  $activeSessionId.set('new-runtime')
  $selectedStoredSessionId.set('new-stored')
  $connection.set({ connectionId: 'other-host', profile: 'default', mode: 'remote' } as never)
  setSessionOwnerHint('stored', { connectionId: 'other-host', profile: 'default' })
  complete({ saved: true })
  await expect(pending).resolves.toEqual({ saved: true })
  expect(saveGatewayFile).toHaveBeenCalledExactlyOnceWith({ path, connectionId: 'local', profile: 'manager', sessionId: 'stored', suggestedName: 'file.txt' })
})

