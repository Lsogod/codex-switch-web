const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexShell", {
  getBaseUrl: () => ipcRenderer.invoke("shell:get-base-url"),
  openDashboard: () => ipcRenderer.invoke("shell:open-dashboard"),
  hideOverlay: () => ipcRenderer.invoke("shell:hide-overlay"),
  setOverlayExpanded: (expanded) => ipcRenderer.invoke("shell:set-overlay-expanded", expanded),
  getOverlayBounds: () => ipcRenderer.invoke("shell:get-overlay-bounds"),
  setOverlayPosition: (x, y) => ipcRenderer.invoke("shell:set-overlay-position", x, y),
  showContextMenu: () => ipcRenderer.invoke("shell:show-context-menu")
});
