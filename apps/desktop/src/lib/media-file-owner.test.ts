import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { setApiRequestConnection, setApiRequestProfile, setSessionOwnerResolver } from '@/api/client'
import { $connection } from '@/store/session'

import { downloadGatewayMediaFile } from './media'

const path = '/srv/project/attachment.txt'
const saveGatewayFile = vi.fn()

beforeEach(() => {
  $connection.set({ connectionId: 'foreground-host', mode: 'remote', profile: 'default' } as never)
  setApiRequestConnection('foreground-host')
  setApiRequestProfile('default')
  saveGatewayFile.mockReset().mockResolvedValue({ canceled: true, saved: false })
  vi.stubGlobal('hermesDesktop', { saveGatewayFile })
})

afterEach(() => {
  setSessionOwnerResolver(null)
  setApiRequestConnection(null)
  setApiRequestProfile(null)
  $connection.set(null)
  vi.unstubAllGlobals()
})

it.each(['foreground-host', 'background-host', 'local'])(
  'pins the backend-facing manager profile and its %s connection',
  async connectionId => {
    setSessionOwnerResolver(id => id === 'stored-manager' ? { connectionId, profile: 'display-manager', targetProfile: 'manager' } : null)

    await downloadGatewayMediaFile(path, { sessionId: 'stored-manager' })

    expect(saveGatewayFile).toHaveBeenCalledWith({ connectionId, profile: 'manager', sessionId: 'stored-manager', path, suggestedName: 'attachment.txt' })
  }
)

it.each([
  { profile: 'default' },
  { owner: { connectionId: 'other-host', profile: 'manager' } },
  { owner: { connectionId: 'manager-host', profile: 'other-profile' } }
])('rejects a known owner conflict before entering the bridge (%j)', async origin => {
  setSessionOwnerResolver(() => ({ connectionId: 'manager-host', targetProfile: 'manager' }))

  await expect(downloadGatewayMediaFile(path, { ...origin, sessionId: 'stored-manager' })).rejects.toThrow('does not belong')
  expect(saveGatewayFile).not.toHaveBeenCalled()
})

it('preserves an explicit legacy owner without merging a foreground connection', async () => {
  setSessionOwnerResolver(() => 'manager')

  await downloadGatewayMediaFile(path, { owner: { profile: 'manager' }, sessionId: 'stored-manager' })

  expect(saveGatewayFile).toHaveBeenCalledWith({ profile: 'manager', sessionId: 'stored-manager', path, suggestedName: 'attachment.txt' })
})

it('does not invent a foreground connection for a profile-only session owner', async () => {
  setSessionOwnerResolver(() => 'manager')

  await downloadGatewayMediaFile(path, { sessionId: 'stored-manager' })

  expect(saveGatewayFile).toHaveBeenCalledWith({ profile: 'manager', sessionId: 'stored-manager', path, suggestedName: 'attachment.txt' })
})

it('retains an explicitly scoped unlisted stored id rather than dropping session scope', async () => {
  setSessionOwnerResolver(() => null)

  await downloadGatewayMediaFile(path, { owner: { connectionId: 'local', profile: 'work' }, sessionId: 'runtime-work' })

  expect(saveGatewayFile).toHaveBeenCalledWith({ connectionId: 'local', profile: 'work', sessionId: 'runtime-work', path, suggestedName: 'attachment.txt' })
})

it('preserves a deliberately sessionless captured primary-pool download', async () => {
  await downloadGatewayMediaFile(path, { owner: {} })

  expect(saveGatewayFile).toHaveBeenCalledWith({ path, suggestedName: 'attachment.txt' })
})

it.each(['display-manager', 'manager'])('accepts the proven %s alias but sends the backend profile', async profile => {
  setSessionOwnerResolver(() => ({ connectionId: 'manager-host', profile: 'display-manager', targetProfile: 'manager' }))

  await downloadGatewayMediaFile(path, { owner: { profile }, profile: 'manager', sessionId: 'stored-manager' })

  expect(saveGatewayFile).toHaveBeenCalledExactlyOnceWith({ profile: 'manager', sessionId: 'stored-manager', path, suggestedName: 'attachment.txt' })
})

it.each([
  { owner: { profile: 'manager' }, profile: 'other' },
  { owner: {}, sessionId: 'unknown' },
  { sessionId: 'unknown' }
])('rejects contradictory explicit profiles or implicit unknown ownership (%j)', async origin => {
  setSessionOwnerResolver(() => null)

  await expect(downloadGatewayMediaFile(path, origin)).rejects.toThrow()
  expect(saveGatewayFile).not.toHaveBeenCalled()
})

it('captures ownership before awaiting a save dialog and survives a foreground switch', async () => {
  let complete!: (result: { saved: boolean }) => void
  saveGatewayFile.mockImplementation(() => new Promise(resolve => { complete = resolve }))
  setSessionOwnerResolver(() => ({ connectionId: 'foreground-host', targetProfile: 'manager' }))

  const pending = downloadGatewayMediaFile(path, { sessionId: 'stored-manager' })
  $connection.set({ connectionId: 'other-host', mode: 'remote', profile: 'default' } as never)
  setApiRequestConnection('other-host')
  setSessionOwnerResolver(() => ({ connectionId: 'other-host', targetProfile: 'default' }))
  complete({ saved: true })
  await expect(pending).resolves.toEqual({ saved: true })

  expect(saveGatewayFile).toHaveBeenCalledExactlyOnceWith({ connectionId: 'foreground-host', profile: 'manager', sessionId: 'stored-manager', path, suggestedName: 'attachment.txt' })
})
