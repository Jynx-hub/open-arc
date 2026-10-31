import { contextBridge, ipcRenderer } from 'electron';
import { injectBrowserAction } from 'electron-chrome-extensions/browser-action';
import type { Api, UiEvents } from '../shared/ipc';

const api: Api = {
  getState: () => ipcRenderer.invoke('getState'),
  getWindow: () => ipcRenderer.invoke('getWindow'),
  getLive: () => ipcRenderer.invoke('getLive'),
  dispatch: (action) => ipcRenderer.send('dispatch', action),
  command: (command) => ipcRenderer.invoke('command', command),
  setContentBounds: (rect) => ipcRenderer.send('setContentBounds', rect),
  find: (text, opts) => ipcRenderer.invoke('find', text, opts),
  captures: () => ipcRenderer.invoke('captures'),
  on: <K extends keyof UiEvents>(event: K, cb: (payload: UiEvents[K]) => void) => {
    const listener = (_: unknown, payload: UiEvents[K]) => cb(payload);
    ipcRenderer.on(`ui:${event}`, listener);
    return () => ipcRenderer.removeListener(`ui:${event}`, listener);
  },
};

contextBridge.exposeInMainWorld('openArc', api);

// `<button is="browser-action">` for extension buttons in the sidebar.
injectBrowserAction();
