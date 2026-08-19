/**
 * The context bridge. Nothing but these functions crosses from main into the
 * renderer, and every one of them is a thin `ipcRenderer.invoke` — the channel
 * names match `main/ipc.ts`.
 */

// The contract itself is declared in the sibling index.d.ts, which the
// renderer consumes as well. Pulling it in here means this file is checked
// against the very interface the renderer codes against.
/// <reference path="./index.d.ts" />

import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { RekordboxSyncResult } from '../shared/types'

type DJDawApi = Window['api']

const api: DJDawApi = {
  openAudioFiles: () => ipcRenderer.invoke('audio:openFiles'),
  importPaths: (paths) => ipcRenderer.invoke('library:importPaths', paths),
  importRekordboxXml: () => ipcRenderer.invoke('library:importRekordboxXml'),
  chooseRekordboxXml: () => ipcRenderer.invoke('rekordbox:choose'),
  syncRekordbox: () => ipcRenderer.invoke('rekordbox:syncNow'),
  clearRekordboxXml: () => ipcRenderer.invoke('rekordbox:clear'),
  readAudioFile: (path) => ipcRenderer.invoke('audio:readFile', path),
  transcodeToWav: (path) => ipcRenderer.invoke('audio:transcodeToWav', path),
  loadLibrary: () => ipcRenderer.invoke('library:load'),
  saveLibrary: (lib) => ipcRenderer.invoke('library:save', lib),
  readWaveformCache: (audioKey) => ipcRenderer.invoke('waveform:read', audioKey),
  writeWaveformCache: (audioKey, data) => ipcRenderer.invoke('waveform:write', audioKey, data),
  revealInFinder: (path) => ipcRenderer.invoke('shell:reveal', path),

  onMenuCommand: (cb) => {
    // The listener is wrapped so the renderer never sees the IpcRendererEvent,
    // and so the returned unsubscribe removes exactly this registration.
    const listener = (_event: IpcRendererEvent, command: string): void => cb(command)
    ipcRenderer.on('menu:command', listener)
    return () => {
      ipcRenderer.off('menu:command', listener)
    }
  },

  onRekordboxSync: (cb) => {
    const listener = (_event: IpcRendererEvent, result: RekordboxSyncResult): void => cb(result)
    ipcRenderer.on('rekordbox:sync', listener)
    return () => {
      ipcRenderer.off('rekordbox:sync', listener)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (err) {
    console.error('[preload] failed to expose window.api', err)
  }
} else {
  // Only reachable if contextIsolation is ever turned off; the renderer still
  // finds the same object at window.api.
  ;(globalThis as unknown as { api: DJDawApi }).api = api
}
