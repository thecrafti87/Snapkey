'use strict';

/* =================================================================
   Die einzige Bruecke zwischen Fenster und Hauptprozess.

   contextIsolation ist an, nodeIntegration ist aus - die Seite selbst
   sieht kein Node, kein fs, kein require. Was sie braucht, steht hier,
   Funktion fuer Funktion, nichts Offenes dazwischen.
   ================================================================= */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('snapkey', {
  platform: process.platform,

  state: () => ipcRenderer.invoke('node:state'),
  peers: () => ipcRenderer.invoke('node:peers'),
  settings: () => ipcRenderer.invoke('node:settings'),
  setSetting: (patch) => ipcRenderer.invoke('node:setSetting', patch),
  send: (ziel, paths) => ipcRenderer.invoke('node:send', { ziel, paths }),
  pair: (address) => ipcRenderer.invoke('node:pair', address),
  forget: (address) => ipcRenderer.invoke('node:forget', address),

  pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
  pickFolder: (current) => ipcRenderer.invoke('dialog:pickFolder', current),
  statPaths: (paths) => ipcRenderer.invoke('fs:stat', paths),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  reveal: (target) => ipcRenderer.invoke('shell:reveal', target),

  // Seit Electron 32 liefert File.path nichts mehr - der echte Pfad
  // einer per Drag & Drop abgelegten Datei kommt nur noch hierueber.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  onEvent: (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on('node:event', handler);
    return () => ipcRenderer.removeListener('node:event', handler);
  },

  onSendProgress: (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on('send:progress', handler);
    return () => ipcRenderer.removeListener('send:progress', handler);
  }
});
