const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mail2telegram", {
  invoke: (command, args) => ipcRenderer.invoke(command, args)
});
