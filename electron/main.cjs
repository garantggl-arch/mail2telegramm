const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

ipcMain.handle("app_status", async () => {
  return "Локальное ядро Electron запущено";
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    resizable: true,
    title: "Mail2Telegram",
webPreferences: {
  contextIsolation: true,
  nodeIntegration: false,
  preload: path.join(__dirname, "preload.cjs")
}
  });

  win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}



app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
