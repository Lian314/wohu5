const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopWindow', {
    isDesktop: true,
    minimize: () => ipcRenderer.invoke('window:minimize'),
    close: () => ipcRenderer.invoke('window:close'),
    toggleAlwaysOnTop: () => ipcRenderer.invoke('window:toggle-always-on-top'),
    getState: () => ipcRenderer.invoke('window:get-state'),
    setOpacity: (opacity) => ipcRenderer.invoke('window:set-opacity', opacity),
    setPosition: (x, y) => ipcRenderer.invoke('window:set-position', x, y),
    openDetail: (payload) => ipcRenderer.invoke('detail:open', payload),
    toggleStats: () => ipcRenderer.invoke('stats:toggle'),
    connectRoom: (roomId) => ipcRenderer.invoke('backend:connect-room', roomId),
    getBackendState: () => ipcRenderer.invoke('backend:get-state'),
    onBackendStatus: (handler) => {
        ipcRenderer.removeAllListeners('backend:status');
        ipcRenderer.on('backend:status', (_event, payload) => handler(payload));
    },
    onDetailUpdate: (handler) => {
        ipcRenderer.removeAllListeners('detail:update');
        ipcRenderer.on('detail:update', (_event, payload) => handler(payload));
    }
});
