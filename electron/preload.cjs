const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  moveMouse: (x, y) => ipcRenderer.send('move-mouse', { x, y }),
  click: (button = 'left', double = false) =>
    ipcRenderer.send('mouse-click', { button, double }),
  setMouseDown: (down) => ipcRenderer.send('mouse-button', { down }),
  scroll: (amount) => ipcRenderer.send('mouse-scroll', { amount }),
  typeText: (text) => ipcRenderer.send('type-text', { text }),
  keyTap: (key) => ipcRenderer.send('key-tap', { key }),
  updateHud: (state) => ipcRenderer.send('hud-update', state),
  onHudState: (listener) => {
    ipcRenderer.on('hud-state', (_event, state) => listener(state))
  },
  onTogglePause: (listener) => {
    const handler = () => listener()
    ipcRenderer.on('toggle-pause', handler)
    return () => ipcRenderer.removeListener('toggle-pause', handler)
  },
  getScreenSize: () => ipcRenderer.invoke('get-screen-size'),
  getAccessibilityStatus: () => ipcRenderer.invoke('get-accessibility-status'),
  requestAccessibilityPermission: () =>
    ipcRenderer.invoke('request-accessibility-permission'),
  requestMediaAccess: (kind) => ipcRenderer.invoke('request-media-access', kind),
})
