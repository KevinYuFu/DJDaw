/**
 * Electron main entry: one window, the application menu, and the IPC handlers
 * that back `window.api`.
 */

import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { registerIpcHandlers, startRekordboxSync } from './ipc'
import { whenLibraryIdle } from './library'
import { installAppMenu } from './menu'
import { stopWatching } from './rekordboxSync'

/** Matches `--bg-app` in styles/theme.css, so the first paint is not white. */
const WINDOW_BACKGROUND = '#0e0e10'

/** Set once the pending library write has been waited for, so the retried quit goes through. */
let libraryFlushed = false

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 780,
    backgroundColor: WINDOW_BACKGROUND,
    // Two decks plus the browser need the vertical space; on macOS the toolbar
    // is drawn by the renderer and hosts the traffic lights.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      // The preload bridge needs Node builtins; the renderer itself never does.
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  // Showing only once the first frame is ready avoids a white flash.
  window.on('ready-to-show', () => window.show())

  // The mirror is pushed rather than pulled, so it can only go out once the
  // renderer exists to receive it. Doing it per window also covers the macOS
  // case of the last window being closed and a new one opened later.
  window.webContents.once('did-finish-load', () => {
    void startRekordboxSync().catch((err) =>
      console.error('[main] initial rekordbox sync failed', err)
    )
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

void app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.djdaw.app')

  app.on('browser-window-created', (_event, window) => {
    // F12 opens devtools in dev and CmdOrCtrl+R is ignored in production.
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers()
  installAppMenu()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', (event) => {
  // Nothing should be able to schedule a sync into a process that is leaving.
  stopWatching()
  if (libraryFlushed) return

  // The renderer posts its final library write from `beforeunload`, which runs
  // while the window closes — after `before-quit` and possibly still in flight
  // here. Losing a hot cue the user set seconds before quitting is the worst
  // thing this app can do, so the quit is held back until that write has landed
  // and then restarted. `will-quit` rather than `before-quit` because by then
  // every window has unloaded, so there is nothing left to wait for afterwards.
  event.preventDefault()
  void whenLibraryIdle()
    .catch((err) => console.error('[main] library flush failed on quit', err))
    .finally(() => {
      libraryFlushed = true
      app.quit()
    })
})

app.on('window-all-closed', () => {
  // macOS apps stay alive with no windows until the user quits explicitly.
  if (process.platform !== 'darwin') app.quit()
})
