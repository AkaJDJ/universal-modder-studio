const { app, BrowserWindow, shell, Menu, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let mainWindow;
  let serverModule;
  let allowQuit = false;
  let quitStarted = false;

  process.env.UM_STUDIO_PACKAGED = app.isPackaged ? '1' : '0';
  process.env.UM_STUDIO_DATA_DIR = app.getPath('userData');
  process.env.UM_STUDIO_PORT = '0';
  process.env.UM_STUDIO_ASSET_DIR = app.getAppPath();

  if (!app.isPackaged && !process.env.UNIVERSAL_MODDER_REPO) {
    const developerCheckout = path.resolve(__dirname, '..', '..', 'universal-modder');
    if (fs.existsSync(path.join(developerCheckout, 'pyproject.toml'))) {
      process.env.UNIVERSAL_MODDER_REPO = developerCheckout;
    }
  }

  async function start() {
    await app.whenReady();
    app.setAppUserModelId('com.universalmodder.studio');
    Menu.setApplicationMenu(null);
    const serverPath = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'server.mjs')
      : path.join(app.getAppPath(), 'server.mjs');
    serverModule = await import(require('node:url').pathToFileURL(serverPath).href);
    if (!serverModule.server.listening) {
      await new Promise((resolve, reject) => {
        serverModule.server.once('listening', resolve);
        serverModule.server.once('error', reject);
      });
    }
    const port = serverModule.server.address().port;
    const origin = 'http://127.0.0.1:' + port;

    mainWindow = new BrowserWindow({
      width: 1460,
      height: 960,
      minWidth: 1000,
      minHeight: 680,
      backgroundColor: '#0b0d13',
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const target = new URL(url);
        if (target.protocol === 'https:' && ['openai.com', 'www.openai.com', 'chatgpt.com', 'github.com'].includes(target.hostname)) {
          void shell.openExternal(url);
        }
      } catch { /* Ignore malformed window requests. */ }
      return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith(origin + '/')) event.preventDefault();
    });
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('closed', () => { mainWindow = null; });
    await mainWindow.loadURL(origin);
  }

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('before-quit', (event) => {
    if (allowQuit) return;
    event.preventDefault();
    if (quitStarted) return;
    quitStarted = true;
    Promise.resolve(serverModule?.shutDown()).finally(() => {
      allowQuit = true;
      app.quit();
    });
  });

  app.on('window-all-closed', () => app.quit());
  void start().catch((error) => {
    console.error(error);
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'startup-error.log'), String(error?.stack || error)); } catch { /* Keep the startup error visible even if logging is unavailable. */ }
    dialog.showErrorBox('Universal Modder Studio could not start', String(error?.message || error));
    app.quit();
  });
}
