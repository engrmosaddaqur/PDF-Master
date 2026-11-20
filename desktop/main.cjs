const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');

const DIST_DIR = path.join(__dirname, 'dist');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

let mainWindow = null;
let staticServer = null;
let serverUrl = '';
let pendingPdfPayload = null;

function extractPdfPathFromArgs(argv) {
  if (!Array.isArray(argv)) return null;
  for (const arg of argv) {
    if (!arg || typeof arg !== 'string' || arg.startsWith('-')) continue;
    const resolved = path.resolve(arg);
    if (/\.pdf$/i.test(resolved) && fs.existsSync(resolved)) {
      return resolved;
    }
  }
  return null;
}

function readPdfPayload(filePath) {
  try {
    const bytes = fs.readFileSync(filePath);
    return {
      name: path.basename(filePath) || 'document.pdf',
      bytes: new Uint8Array(bytes),
    };
  } catch {
    return null;
  }
}

function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const reqPath = decodeURIComponent((req.url || '/').split('?')[0]);
        let targetPath = path.join(DIST_DIR, reqPath === '/' ? 'index.html' : reqPath);
        if (!targetPath.startsWith(DIST_DIR) || !fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
          targetPath = path.join(DIST_DIR, 'index.html');
        }
        const ext = path.extname(targetPath).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        fs.createReadStream(targetPath).pipe(res);
      } catch {
        res.writeHead(500);
        res.end('Internal Error');
      }
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      serverUrl = `http://127.0.0.1:${addr.port}`;
      staticServer = server;
      resolve(serverUrl);
    });
  });
}

function buildAppMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open PDF...',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            if (!mainWindow) return;
            const res = await dialog.showOpenDialog(mainWindow, {
              title: 'Open PDF File',
              filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
              properties: ['openFile'],
            });
            if (!res.canceled && res.filePaths[0]) {
              const payload = readPdfPayload(res.filePaths[0]);
              if (payload) {
                mainWindow.webContents.send('pm-open-external-pdf', payload);
              }
            }
          },
        },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'togglefullscreen' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About PDF MASTER v1.1',
          click: () => {
            if (!mainWindow) return;
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About PDF MASTER',
              message: 'PDF MASTER v1.1',
              detail: 'Developed by Mosaddaq\nEverything PDF. One Powerful App.',
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createMainWindow() {
  if (!serverUrl) {
    await startStaticServer();
  }

  mainWindow = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 420,
    minHeight: 600,
    title: 'PDF MASTER',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#0A0F1A',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  buildAppMenu();
  await mainWindow.loadURL(serverUrl);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const initialPdfPath = extractPdfPathFromArgs(process.argv.slice(1));
if (initialPdfPath) {
  pendingPdfPayload = readPdfPayload(initialPdfPath);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    const nextPdf = extractPdfPathFromArgs(commandLine.slice(1));
    if (nextPdf) {
      const payload = readPdfPayload(nextPdf);
      if (payload) {
        if (mainWindow) {
          mainWindow.webContents.send('pm-open-external-pdf', payload);
        } else {
          pendingPdfPayload = payload;
        }
      }
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    ipcMain.handle('pm:consume-pending-pdf', () => {
      const out = pendingPdfPayload;
      pendingPdfPayload = null;
      return out;
    });

    ipcMain.handle('pm:save-file', async (_event, filename, uint8Array) => {
      const defaultDir = app.getPath('documents') || app.getPath('downloads');
      const targetWindow = mainWindow || BrowserWindow.getFocusedWindow();
      const res = await dialog.showSaveDialog(targetWindow, {
        title: 'Save to Local Storage',
        defaultPath: path.join(defaultDir, filename || 'document.pdf'),
        filters: [{ name: 'PDF Document', extensions: ['pdf'] }],
      });
      if (res.canceled || !res.filePath) {
        return { canceled: true, saved: false };
      }
      await fs.promises.writeFile(res.filePath, Buffer.from(uint8Array));
      return { canceled: false, saved: true, filePath: res.filePath };
    });

    await createMainWindow();
  });

  app.on('window-all-closed', () => {
    if (staticServer) {
      staticServer.close();
      staticServer = null;
    }
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
