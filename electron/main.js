import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  session,
  systemPreferences,
} from 'electron'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { mouse, keyboard, Button, Key, Point } = require('@nut-tree-fork/nut-js')

// Input events must be instant; nut-js adds a delay after each one by default.
mouse.config.autoDelayMs = 0
mouse.config.mouseSpeed = 100000
keyboard.config.autoDelayMs = 0

// Tracking has to keep running while another app is in front of Gestura.
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const preloadPath = path.join(__dirname, 'preload.cjs')
const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173'
const PAUSE_SHORTCUT = 'CommandOrControl+Shift+G'

/** @type {BrowserWindow | null} */
let mainWindow = null
/** @type {BrowserWindow | null} */
let hudWindow = null

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

const loadPage = (win, page) => {
  const loading = app.isPackaged
    ? win.loadFile(path.join(__dirname, '..', 'dist', page))
    : win.loadURL(`${devServerUrl}/${page}`)
  loading.catch((error) => {
    console.error(`Failed to load ${page}:`, error)
  })
}

const createMainWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#06090b',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  loadPage(mainWindow, 'index.html')
  mainWindow.on('closed', () => {
    mainWindow = null
    hudWindow?.close()
  })
}

// A small always-on-top, click-through status pill, so the user can see what
// Gestura heard while another app covers the main window.
const createHudWindow = () => {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const hudWidth = 420
  const hudHeight = 64
  hudWindow = new BrowserWindow({
    width: hudWidth,
    height: hudHeight,
    x: Math.round((width - hudWidth) / 2),
    y: height - hudHeight - 24,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  hudWindow.setIgnoreMouseEvents(true)
  hudWindow.setAlwaysOnTop(true, 'screen-saver')
  hudWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  loadPage(hudWindow, 'hud.html')
  hudWindow.on('closed', () => {
    hudWindow = null
  })
}

const isFiniteNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value)

const run = (label, action) => {
  Promise.resolve()
    .then(action)
    .catch((error) => console.error(`${label} failed:`, error))
}

const BUTTONS = { left: Button.LEFT, right: Button.RIGHT }

const KEYS = {
  enter: Key.Enter,
  backspace: Key.Backspace,
  escape: Key.Escape,
  tab: Key.Tab,
  space: Key.Space,
}

ipcMain.on('move-mouse', (_event, payload) => {
  if (!payload || !isFiniteNumber(payload.x) || !isFiniteNumber(payload.y)) {
    return
  }
  const { width, height } = screen.getPrimaryDisplay().size
  const x = clamp(Math.round(payload.x), 0, width - 1)
  const y = clamp(Math.round(payload.y), 0, height - 1)
  run('move-mouse', () => mouse.setPosition(new Point(x, y)))
})

ipcMain.on('mouse-click', (_event, payload) => {
  const button = BUTTONS[payload?.button] ?? Button.LEFT
  run('mouse-click', () =>
    payload?.double ? mouse.doubleClick(button) : mouse.click(button),
  )
})

ipcMain.on('mouse-button', (_event, payload) => {
  run('mouse-button', () =>
    payload?.down
      ? mouse.pressButton(Button.LEFT)
      : mouse.releaseButton(Button.LEFT),
  )
})

ipcMain.on('mouse-scroll', (_event, payload) => {
  if (!isFiniteNumber(payload?.amount)) {
    return
  }
  const steps = Math.min(Math.abs(Math.round(payload.amount)), 2000)
  run('mouse-scroll', () =>
    payload.amount > 0 ? mouse.scrollUp(steps) : mouse.scrollDown(steps),
  )
})

ipcMain.on('type-text', (_event, payload) => {
  if (typeof payload?.text !== 'string' || payload.text.length === 0) {
    return
  }
  run('type-text', () => keyboard.type(payload.text.slice(0, 500)))
})

ipcMain.on('key-tap', (_event, payload) => {
  const key = KEYS[payload?.key]
  if (key === undefined) {
    return
  }
  run('key-tap', async () => {
    await keyboard.pressKey(key)
    await keyboard.releaseKey(key)
  })
})

ipcMain.on('hud-update', (_event, payload) => {
  if (!hudWindow || hudWindow.isDestroyed()) {
    return
  }
  if (payload?.visible === false) {
    hudWindow.hide()
    return
  }
  hudWindow.webContents.send('hud-state', payload)
  if (!hudWindow.isVisible()) {
    hudWindow.showInactive()
  }
})

ipcMain.handle('get-screen-size', () => screen.getPrimaryDisplay().size)

ipcMain.handle('get-accessibility-status', () => {
  if (process.platform !== 'darwin') {
    return true
  }
  return systemPreferences.isTrustedAccessibilityClient(false)
})

ipcMain.handle('request-accessibility-permission', () => {
  if (process.platform !== 'darwin') {
    return true
  }
  return systemPreferences.isTrustedAccessibilityClient(true)
})

ipcMain.handle('request-media-access', async (_event, kind) => {
  if (process.platform !== 'darwin') {
    return true
  }
  if (kind !== 'camera' && kind !== 'microphone') {
    return false
  }
  return systemPreferences.askForMediaAccess(kind)
})

app.whenReady().then(() => {
  // Only the camera and microphone are ever needed by the renderer.
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      callback(permission === 'media')
    },
  )

  createMainWindow()
  createHudWindow()

  // Emergency stop that works from any app, for the user or a caregiver.
  globalShortcut.register(PAUSE_SHORTCUT, () => {
    mainWindow?.webContents.send('toggle-pause')
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
      createHudWindow()
    }
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  app.quit()
})
