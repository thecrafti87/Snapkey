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
  scan: () => ipcRenderer.invoke('node:scan'),
  settings: () => ipcRenderer.invoke('node:settings'),
  setSetting: (patch) => ipcRenderer.invoke('node:setSetting', patch),
  // `id` ist die Aufgabenkennung der Oberflaeche - sie kommt in jeder
  // Fortschrittsmeldung zurueck und ist der Griff fuer sendStop.
  send: (ziel, paths, id) => ipcRenderer.invoke('node:send', { ziel, paths, id }),
  sendStop: (id, art) => ipcRenderer.invoke('node:sendStop', { id, art }),
  recvStop: (from) => ipcRenderer.invoke('node:recvStop', { from }),
  pair: (address) => ipcRenderer.invoke('node:pair', address),
  forget: (address) => ipcRenderer.invoke('node:forget', address),

  // Antwort auf eine Empfangsfrage - die Frage selbst kommt ueber
  // onReceiveAsk unten.
  receiveAnswer: (id, ok) => ipcRenderer.invoke('receive:answer', { id, ok }),

  say: (ziel, texte) => ipcRenderer.invoke('node:say', { ziel, texte }),
  chats: () => ipcRenderer.invoke('node:chats'),
  messages: (address) => ipcRenderer.invoke('node:messages', address),

  historyList: () => ipcRenderer.invoke('history:list'),
  historyClear: () => ipcRenderer.invoke('history:clear'),

  showWindow: () => ipcRenderer.invoke('window:show'),

  pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
  pickFolder: (current) => ipcRenderer.invoke('dialog:pickFolder', current),
  statPaths: (paths) => ipcRenderer.invoke('fs:stat', paths),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  reveal: (target) => ipcRenderer.invoke('shell:reveal', target),

  updateCan: () => ipcRenderer.invoke('update:can'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateFetch: () => ipcRenderer.invoke('update:fetch'),
  updateApply: () => ipcRenderer.invoke('update:apply'),

  finderStatus: () => ipcRenderer.invoke('finder:status'),
  finderInstall: (label) => ipcRenderer.invoke('finder:install', label),
  finderRemove: () => ipcRenderer.invoke('finder:remove'),

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
  },

  onHistoryChanged: (fn) => {
    const handler = () => fn();
    ipcRenderer.on('history:changed', handler);
    return () => ipcRenderer.removeListener('history:changed', handler);
  },

  onUpdateProgress: (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on('update:progress', handler);
    return () => ipcRenderer.removeListener('update:progress', handler);
  },

  // Eine eingehende Uebertragung wartet auf Einwilligung - siehe
  // uebertragungErfragen() in main.js.
  onReceiveAsk: (fn) => {
    const handler = (_e, frage) => fn(frage);
    ipcRenderer.on('receive:ask', handler);
    return () => ipcRenderer.removeListener('receive:ask', handler);
  },

  // Die stille Pruefung kurz nach dem Start hat etwas gefunden. Kommt
  // ungefragt, deshalb landet es nur in der Update-Karte - siehe
  // stillNachUpdateSehen() in main.js.
  onUpdateFound: (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on('update:found', handler);
    return () => ipcRenderer.removeListener('update:found', handler);
  },

  // Ruft von aussen an: Menueleistensymbol oder eine angeklickte
  // Mitteilung wollen eine bestimmte Ansicht vorne sehen.
  onOpenView: (fn) => {
    const handler = (_e, view) => fn(view);
    ipcRenderer.on('window:openView', handler);
    return () => ipcRenderer.removeListener('window:openView', handler);
  },

  // Pfade aus dem Finder (Kurzbefehl oder "Oeffnen mit"), gebuendelt vom
  // Hauptprozess - siehe app/main.js, Abschnitt "Dateien aus dem Finder".
  onFilesAdd: (fn) => {
    const handler = (_e, paths) => fn(paths);
    ipcRenderer.on('files:add', handler);
    return () => ipcRenderer.removeListener('files:add', handler);
  }
});
