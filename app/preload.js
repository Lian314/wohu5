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
    getDanmaku: () => ipcRenderer.invoke('backend:get-danmaku'),
    getBackendState: () => ipcRenderer.invoke('backend:get-state'),
    openHuyaLogin: () => ipcRenderer.invoke('auth:open-huya-login'),
    sendControlDanmaku: (payload) => ipcRenderer.invoke('control:send-danmaku', payload),
    reviewDanmaku: (payload) => ipcRenderer.invoke('ai:review-danmaku', payload),
    parseMemeLibrary: (payload) => ipcRenderer.invoke('meme-library:parse', payload),
    listMemeRag: () => ipcRenderer.invoke('meme-rag:list'),
    matchMemeRag: (payload) => ipcRenderer.invoke('meme-rag:match', payload),
    upsertMemeRag: (payload) => ipcRenderer.invoke('meme-rag:upsert', payload),
    removeMemeRag: (key) => ipcRenderer.invoke('meme-rag:remove', key),
    importMemeRag: (payload) => ipcRenderer.invoke('meme-rag:import', payload),
    copyText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
    onBackendStatus: (handler) => {
        ipcRenderer.removeAllListeners('backend:status');
        ipcRenderer.on('backend:status', (_event, payload) => handler(payload));
    },
    onDetailUpdate: (handler) => {
        ipcRenderer.removeAllListeners('detail:update');
        ipcRenderer.on('detail:update', (_event, payload) => handler(payload));
    }
});
