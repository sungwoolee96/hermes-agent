import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, get, type Server } from 'node:http'
import { join } from 'node:path'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'

import { setApiRequestConnection, setApiRequestProfile } from '@/api/client'
import { I18nProvider } from '@/i18n'
import { createClientSessionState } from '@/lib/chat-runtime'
import type * as DesktopFs from '@/lib/desktop-fs'
import { $notifications } from '@/store/notifications'
import { $activeSessionId, $connection, $selectedStoredSessionId, setSessions } from '@/store/session'
import { $sessionTiles, clearAllSessionStates, publishSessionState, recordSessionEventScope } from '@/store/session-states'
import { makeSessionInfo } from '@/test/session-info'

import { PreviewAttachment } from './preview-attachment'

// This is an isolated HTTP/host-bridge fixture, not a live Electron save-dialog test.
// Only the host boundary is replaced: the mounted card, media helper and owner resolver are real.
vi.mock('@/lib/desktop-fs', async importOriginal => ({
  ...(await importOriginal<typeof DesktopFs>()),
  isDesktopFsRemoteMode: () => true
}))

interface SaveRequest {
  connectionId?: string
  path: string
  profile?: string
  sessionId?: string
}

let server: Server
let origin: string
let dir: string
let source: string
const bytes = Buffer.from('Isolated manager attachment fixture.\n', 'utf8')

function requestFile(request: SaveRequest): Promise<Buffer> {
  const url = new URL('/api/fs/download', origin)
  url.search = new URLSearchParams({ path: request.path, profile: request.profile ?? 'default', session_id: request.sessionId ?? '' }).toString()

  return new Promise((resolve, reject) => {
    get(url, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('error', reject)
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`${response.statusCode}: ${Buffer.concat(chunks).toString()}`))
        } else {
          resolve(Buffer.concat(chunks))
        }
      })
    }).on('error', reject)
  })
}

beforeAll(async () => {
  if (!process.env.TMPDIR) {
    throw new Error('Tests require a managed TMPDIR')
  }

  dir = await mkdtemp(join(process.env.TMPDIR, 'attachment-owner-'))
  source = join(dir, 'attachment.txt')
  await writeFile(source, bytes)
  server = createServer((request, response) => {
    const query = new URL(request.url!, 'http://fixture').searchParams

    if (query.get('profile') !== 'manager' || query.get('session_id') !== 'manager-stored') {
      response.writeHead(404).end('Session not found')
    } else if (query.get('path') !== source) {
      response.writeHead(403).end('Fixture path is outside its session')
    } else {
      void readFile(source).then(content => response.writeHead(200).end(content))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()

  if (!address || typeof address === 'string') {
    throw new Error('Fixture did not bind')
  }

  origin = `http://127.0.0.1:${address.port}`
})

afterEach(() => {
  cleanup()
  setSessions([])
  $sessionTiles.set([])
  clearAllSessionStates()
  setApiRequestConnection(null)
  setApiRequestProfile(null)
  $connection.set(null)
  $selectedStoredSessionId.set(null)
  $activeSessionId.set(null)
  $notifications.set([])
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await rm(dir, { recursive: true, force: true })
})

it.each([
  { stored: 'manager-stored', runtime: 'unrelated-runtime', expected: 'manager-stored' },
  { stored: null, runtime: 'manager-runtime', expected: 'manager-stored' }
])('downloads and rereads the producing session bytes from a mounted card (%j)', async ({ stored, runtime, expected }) => {
  await expect(requestFile({ path: source, profile: 'default', sessionId: expected })).rejects.toThrow('404: Session not found')
  const destination = join(dir, `${runtime}-downloaded.txt`)

  const saveGatewayFile = vi.fn(async (request: SaveRequest) => {
    const downloaded = await requestFile(request)
    await writeFile(destination, downloaded)

    return { saved: true, path: destination }
  })

  vi.stubGlobal('hermesDesktop', { saveGatewayFile })
  $connection.set({ connectionId: 'remote-server', mode: 'remote', profile: 'default' } as never)
  setApiRequestConnection('remote-server')
  setApiRequestProfile('default')
  setSessions([makeSessionInfo({ id: 'manager-stored', profile: 'manager', connection_id: 'remote-server' })])
  publishSessionState('manager-runtime', createClientSessionState('manager-stored'))
  recordSessionEventScope({ session_id: 'manager-runtime', profile: 'manager', connectionId: 'remote-server' })
  $selectedStoredSessionId.set(stored)
  $activeSessionId.set(runtime)

  render(<I18nProvider configClient={null} initialLocale="en"><PreviewAttachment target={source} /></I18nProvider>)
  await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Download' })) })

  await vi.waitFor(async () => expect(await readFile(destination)).toEqual(bytes))
  expect(saveGatewayFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ connectionId: 'remote-server', profile: 'manager', sessionId: expected, path: source }))
  await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Download' }).textContent).toContain('Saved'))
  expect($notifications.get().filter(({ kind }) => kind === 'error')).toEqual([])
})
