import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { HermesConnection } from '@/global'
import { I18nProvider } from '@/i18n'
import { createBrowserFilesBridge } from '@/lib/browser-files'
import type { BrowserBootstrap } from '@/lib/browser-transport'
import { createClientSessionState } from '@/lib/chat-runtime'
import { $notifications } from '@/store/notifications'
import { $activeSessionId, $connection, $selectedStoredSessionId, $sessions } from '@/store/session'
import { clearAllSessionStates, publishSessionState, recordSessionEventScope } from '@/store/session-states'
import type { SessionInfo } from '@/types/hermes'

import { GeneratedImage } from './generated-image-result'

// The image never loads, so the card collapses to its "Open image" link. An inline source stays its
// own src, as in the real hook.
vi.mock('@/hooks/use-media-image', () => ({
  useMediaImage: (path: string) => ({
    failed: true,
    frameStyle: {},
    key: 'k',
    loaded: false,
    src: /^(?:https?|data):/i.test(path) ? path : ''
  })
}))

const openExternal = vi.fn()
const saveGatewayFile = vi.fn().mockResolvedValue({ ok: true })

beforeEach(() => {
  // A native Electron renderer: the preload's bridge, no browser-host marker.
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { openExternal, saveGatewayFile }
})

afterEach(() => {
  cleanup()
  clearAllSessionStates()
  vi.clearAllMocks()
  $connection.set(null)
  $sessions.set([])
  $selectedStoredSessionId.set(null)
  $activeSessionId.set(null)
  $notifications.set([])
  window.document.documentElement.removeAttribute('data-hermes-desktop-host')
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

function openImageLink(image: string) {
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <GeneratedImage result={{ image }} />
    </I18nProvider>
  )

  return screen.getByRole('link', { name: /Open image/ })
}

// A remote gateway's file URL carries the connection token. Handed to the
// system browser it would sit in that browser's history, so the image saves
// through the bridge instead (native Desktop's save dialog). A relative path
// saves there too, on both hosts, from the chat's own working directory: this
// gateway runs from /srv/gateway, and the chat ran on its `work` profile in
// /srv/project.
const SESSION_CWDS: Record<string, string> = { 'work/origin-session': '/srv/project' }

it.each([
  ['electron', '/srv/hermes/images/cat.png', 'cat.png', '/srv/hermes/images/cat.png'],
  ['electron', 'renders/out.png', 'out.png', '/srv/project/renders/out.png'],
  ['browser', 'renders/out.png', 'out.png', '/srv/project/renders/out.png']
])('saves a gateway image through the %s bridge (%s), never opening its tokened URL', async (host, image, name, saved) => {
  // Resolves like /api/fs/download: in the named session's cwd, else in the gateway's own.
  saveGatewayFile.mockImplementation(async ({ path, profile, sessionId }) => {
    const cwd = sessionId ? SESSION_CWDS[`${profile}/${sessionId}`] : '/srv/gateway'

    if (!cwd) {
      throw new Error('404: Session not found')
    }

    return { path: path.startsWith('/') ? path : `${cwd}/${path}`, saved: true }
  })
  window.document.documentElement.dataset.hermesDesktopHost = host
  $connection.set({
    baseUrl: 'https://gateway.example',
    connectionId: 'remote-1',
    mode: 'remote',
    profile: 'default',
    token: 'secret-token'
  } as unknown as HermesConnection)
  $sessions.set([{ id: 'origin-session', profile: 'work', connection_id: 'remote-1' } as SessionInfo])
  $selectedStoredSessionId.set('origin-session')

  const link = openImageLink(image)
  await act(async () => {
    fireEvent.click(link)
  })

  await vi.waitFor(() =>
    expect(saveGatewayFile).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'remote-1', path: image, profile: 'work', sessionId: 'origin-session', suggestedName: name })
    )
  )
  await expect(saveGatewayFile.mock.results[0]!.value).resolves.toEqual({ path: saved, saved: true })
  expect(JSON.stringify(saveGatewayFile.mock.calls)).not.toContain('secret-token')
  expect(openExternal).not.toHaveBeenCalled()
})

it('keeps the stored image owner when a different runtime and foreground profile are present', async () => {
  saveGatewayFile.mockResolvedValue({ saved: true })
  $connection.set({ connectionId: 'remote-1', mode: 'remote', profile: 'default' } as HermesConnection)
  $sessions.set([{ id: 'origin-session', profile: 'work', connection_id: 'remote-1' } as SessionInfo])
  $selectedStoredSessionId.set('origin-session')
  $activeSessionId.set('unrelated-runtime')

  const link = openImageLink('/srv/project/cat.png')

  await act(async () => {
    fireEvent.click(link)
  })

  await vi.waitFor(() => expect(saveGatewayFile).toHaveBeenCalledWith(expect.objectContaining({
    connectionId: 'remote-1', profile: 'work', sessionId: 'origin-session', path: '/srv/project/cat.png'
  })))
  expect($notifications.get().map(({ title }) => title)).not.toContain('Image download failed')
})

it('saves a relative gateway image through the stored identity bound to its runtime', async () => {
  saveGatewayFile.mockResolvedValue({ path: '/srv/project/renders/out.png', saved: true })
  window.document.documentElement.dataset.hermesDesktopHost = 'browser'
  $connection.set({
    baseUrl: 'https://gateway.example',
    connectionId: 'remote-1',
    mode: 'remote',
    token: 'secret-token'
  } as unknown as HermesConnection)
  $activeSessionId.set('runtime-1')
  publishSessionState('runtime-1', createClientSessionState('origin-session'))
  recordSessionEventScope({ session_id: 'runtime-1', profile: 'work', connectionId: 'remote-1' })

  const link = openImageLink('renders/out.png')
  await act(async () => {
    fireEvent.click(link)
  })

  await vi.waitFor(
    () =>
      expect(saveGatewayFile).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'renders/out.png', profile: 'work', sessionId: 'origin-session' })
      ),
    { timeout: 2000 }
  )
  expect($notifications.get().map(({ title }) => title)).not.toContain('Image download failed')
})

// Anything else opens as on main: a web image's own URL.
it('opens a web image\'s URL with the system handler in native Desktop', async () => {
  $connection.set({ baseUrl: 'https://gateway.example', mode: 'remote', token: 'secret-token' } as unknown as HermesConnection)

  const link = openImageLink('https://images.example/cat.png')
  await act(async () => {
    fireEvent.click(link)
  })

  expect(openExternal).toHaveBeenCalledWith('https://images.example/cat.png')
  expect(saveGatewayFile).not.toHaveBeenCalled()
})

// A data: image (a plugin backend's HEIC, say, that this renderer cannot decode) carries its own
// bytes: it saves them, on both hosts. As a gateway link it would hand the connection token to the
// system browser, and the Webapp cannot open one at all.
it.each(['electron', 'browser'])('saves a data: image that will not decode in %s, never opening a link', async host => {
  const image = 'data:image/png;base64,AAAA'
  const clicked: string[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this.href)
  })

  const saveImageFromUrl =
    host === 'browser'
      ? vi.fn(
          createBrowserFilesBridge({ api: vi.fn(), bootstrap: {} as BrowserBootstrap, currentProfile: () => null })
            .saveImageFromUrl
        )
      : vi.fn().mockResolvedValue(true)

  ;(window as unknown as { hermesDesktop: object }).hermesDesktop = { openExternal, saveGatewayFile, saveImageFromUrl }
  window.document.documentElement.dataset.hermesDesktopHost = host
  $connection.set({ baseUrl: 'https://gateway.example', mode: 'remote', token: 'secret-token' } as unknown as HermesConnection)

  const link = openImageLink(image)
  await act(async () => {
    fireEvent.click(link)
  })

  expect(JSON.stringify(openExternal.mock.calls)).not.toContain('secret-token')
  expect(openExternal).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(saveImageFromUrl).toHaveBeenCalledWith(image))
  expect(saveGatewayFile).not.toHaveBeenCalled()
  await vi.waitFor(() => expect($notifications.get().map(({ title }) => title)).toContain('Image saved'))
  expect(clicked).toEqual(host === 'browser' ? [image] : [])
})
