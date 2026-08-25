/**
 * Application menu.
 *
 * Items that belong to the renderer (import, analysis, transport, zoom) do not
 * act on the window themselves; they send a command string on the
 * `menu:command` channel to the focused window, which the renderer subscribes
 * to through `window.api.onMenuCommand`. The complete vocabulary is:
 *
 * ```
 * import              open the import dialog and add the chosen files
 * analyze             (re)analyse the selected track
 * reveal              reveal the selected track in Finder
 * zoom-in / zoom-out  detailed waveform zoom of the focused deck
 * play                play / pause the focused deck
 * cue                 CUE button of the focused deck
 * beat-jump-back      jump back by the deck's beat-jump size
 * beat-jump-forward   jump forward by the deck's beat-jump size
 * ```
 */

import { app, BrowserWindow, dialog, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'

export type MenuCommand =
  | 'import'
  | 'import-rekordbox'
  | 'analyze'
  | 'reveal'
  | 'zoom-in'
  | 'zoom-out'
  | 'play'
  | 'cue'
  | 'beat-jump-back'
  | 'beat-jump-forward'

const isMac = process.platform === 'darwin'

function send(command: MenuCommand): void {
  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  target?.webContents.send('menu:command', command)
}

/** The map from docs/ARCHITECTURE.md, shown natively so it needs no renderer UI. */
const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause the focused deck'],
  ['Tab', 'Switch the focused deck'],
  ['C', 'CUE'],
  ['Q / W', 'Beat jump back / forward'],
  ['Shift+Q / Shift+W', 'Halve / double the beat-jump size'],
  ['1 - 8', 'Hot cue A-H (set if empty, jump if set)'],
  ['Shift+1 - 8', 'Delete hot cue A-H'],
  ['L', 'Toggle loop'],
  ['[ / ]', 'Loop length halve / double'],
  [', / .', 'Nudge the grid back / forward 1/32 beat'],
  ['G', 'Set the downbeat at the playhead'],
  ['T', 'Tap tempo'],
  ['Y', 'Toggle quantize'],
  ['- / =', 'Waveform zoom out / in'],
  ['Left / Right', 'Nudge the playhead by one beat']
]

function showKeyboardShortcuts(): void {
  const options: Electron.MessageBoxOptions = {
    type: 'info',
    title: 'Keyboard Shortcuts',
    message: 'Keyboard Shortcuts',
    detail: SHORTCUTS.map(([key, what]) => `${key} — ${what}`).join('\n'),
    buttons: ['OK'],
    noLink: true
  }
  const owner = BrowserWindow.getFocusedWindow()
  void (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options))
}

function appMenu(): MenuItemConstructorOptions[] {
  if (!isMac) return []
  return [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }
  ]
}

function fileMenu(): MenuItemConstructorOptions {
  return {
    label: 'File',
    submenu: [
      { label: 'Import Track…', accelerator: 'CmdOrCtrl+O', click: () => send('import') },
      {
        label: 'Import rekordbox Collection…',
        accelerator: 'CmdOrCtrl+Shift+O',
        click: () => send('import-rekordbox')
      },
      { type: 'separator' },
      { label: 'Analyze Selected', accelerator: 'CmdOrCtrl+Shift+A', click: () => send('analyze') },
      {
        label: isMac ? 'Reveal in Finder' : 'Show in File Manager',
        accelerator: 'Alt+CmdOrCtrl+R',
        click: () => send('reveal')
      },
      ...(isMac ? [] : ([{ type: 'separator' }, { role: 'quit' }] as MenuItemConstructorOptions[]))
    ]
  }
}

function editMenu(): MenuItemConstructorOptions {
  return {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac ? ([{ role: 'pasteAndMatchStyle' }] as MenuItemConstructorOptions[]) : []),
      { role: 'delete' },
      { type: 'separator' },
      { role: 'selectAll' }
    ]
  }
}

function viewMenu(): MenuItemConstructorOptions {
  return {
    label: 'View',
    submenu: [
      // The renderer also takes bare "-" and "=" for zoom; the menu uses the
      // modified pair so a search box can still receive those characters.
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => send('zoom-in') },
      { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => send('zoom-out') },
      { type: 'separator' },
      { role: 'reload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  }
}

function deckMenu(): MenuItemConstructorOptions {
  return {
    label: 'Deck',
    // Deliberately without accelerators: Space, C, Q and W are handled in the
    // renderer, where a focused text input can swallow them. A menu
    // accelerator fires app-wide and would cue the deck while you type.
    submenu: [
      { label: 'Play / Pause', click: () => send('play') },
      { label: 'Cue', click: () => send('cue') },
      { type: 'separator' },
      { label: 'Beat Jump Back', click: () => send('beat-jump-back') },
      { label: 'Beat Jump Forward', click: () => send('beat-jump-forward') },
      { type: 'separator' },
      // Hot cues are set from the pads or keys 1-8. The renderer contract has no
      // menu command for them, so the item is shown but inert.
      { label: 'Set Hot Cue…', enabled: false }
    ]
  }
}

function windowMenu(): MenuItemConstructorOptions {
  return {
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      ...(isMac
        ? ([
            { type: 'separator' },
            { role: 'front' },
            { type: 'separator' },
            { role: 'window' }
          ] as MenuItemConstructorOptions[])
        : ([{ role: 'close' }] as MenuItemConstructorOptions[]))
    ]
  }
}

function helpMenu(): MenuItemConstructorOptions {
  return {
    label: 'Help',
    role: 'help',
    submenu: [
      { label: 'Keyboard Shortcuts', click: showKeyboardShortcuts },
      ...(isMac ? [] : ([{ type: 'separator' }, { role: 'about' }] as MenuItemConstructorOptions[]))
    ]
  }
}

/** Build and install the application menu. Call once, after the app is ready. */
export function installAppMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...appMenu(),
    fileMenu(),
    editMenu(),
    viewMenu(),
    deckMenu(),
    windowMenu(),
    helpMenu()
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
