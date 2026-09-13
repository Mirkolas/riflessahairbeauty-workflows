from pathlib import Path
import sys

root = Path(sys.argv[1])
app = root / 'riflessahairbeauty-app-registratore' / 'Riflessabeautyapp_v3.5.2_receipt_actions'
main = app / 'electron' / 'main.js'
text = main.read_text(encoding='utf-8')

repls = [
    (
        "const LOCAL_POS = path.join(__dirname, '..', 'index.html');\n",
        "const LOCAL_POS = path.join(__dirname, '..', 'index.html');\nconst SPLASH_POS = path.join(__dirname, 'splash.html');\n"
    ),
    (
        "let mainWindow;\nlet fiscalQueue = Promise.resolve();\n",
        "let mainWindow;\nlet splashWindow;\nlet splashShownAt = 0;\nlet fiscalQueue = Promise.resolve();\n"
    ),
    (
        "function createWindow() {\n",
        "function createSplashWindow() {\n"
        "  splashShownAt = Date.now();\n"
        "  splashWindow = new BrowserWindow({\n"
        "    width: 520, height: 320, frame: false, transparent: true, resizable: false,\n"
        "    center: true, alwaysOnTop: true, skipTaskbar: true, show: false, hasShadow: true,\n"
        "    backgroundColor: '#00000000',\n"
        "    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false }\n"
        "  });\n"
        "  splashWindow.loadFile(SPLASH_POS);\n"
        "  splashWindow.once('ready-to-show', () => {\n"
        "    if (splashWindow && !splashWindow.isDestroyed()) {\n"
        "      splashShownAt = Date.now();\n"
        "      splashWindow.show();\n"
        "    }\n"
        "  });\n"
        "  splashWindow.on('closed', () => { splashWindow = null; });\n"
        "}\n\n"
        "function revealMainWindow() {\n"
        "  if (!mainWindow || mainWindow.isDestroyed()) return;\n"
        "  const minimumSplashMs = 900;\n"
        "  const elapsed = splashShownAt ? Date.now() - splashShownAt : minimumSplashMs;\n"
        "  const delay = Math.max(0, minimumSplashMs - elapsed);\n"
        "  setTimeout(() => {\n"
        "    if (mainWindow && !mainWindow.isDestroyed()) {\n"
        "      mainWindow.show();\n"
        "      mainWindow.focus();\n"
        "    }\n"
        "    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();\n"
        "  }, delay);\n"
        "}\n\n"
        "function createWindow() {\n"
    ),
    (
        "    autoHideMenuBar: true,\n    icon: path.join(__dirname, '..', 'assets', 'riflessa-icon.png'),\n",
        "    autoHideMenuBar: true, show: false, backgroundColor: '#f6f2ee',\n    icon: path.join(__dirname, '..', 'assets', 'riflessa-icon.png'),\n"
    ),
    (
        "  mainWindow.webContents.on('will-navigate', (event, url) => {\n    const allowed = url.startsWith('file://') || url.startsWith(HOSTED_POS);\n    if (!allowed) event.preventDefault();\n  });\n\n",
        "  mainWindow.webContents.on('will-navigate', (event, url) => {\n    const allowed = url.startsWith('file://') || url.startsWith(HOSTED_POS);\n    if (!allowed) event.preventDefault();\n  });\n  mainWindow.webContents.once('did-finish-load', revealMainWindow);\n  mainWindow.on('closed', () => { mainWindow = null; });\n  setTimeout(revealMainWindow, 12000);\n\n"
    ),
    (
        "  appendMaster(paths().masterTxt, 'app.started', { version: app.getVersion(), localUi: process.env.RIFLESSA_HOSTED_UI !== '1', rtHost: RT_HOST });\n  createWindow();\n",
        "  appendMaster(paths().masterTxt, 'app.started', { version: app.getVersion(), localUi: process.env.RIFLESSA_HOSTED_UI !== '1', rtHost: RT_HOST });\n  createSplashWindow();\n  createWindow();\n"
    ),
]

for old, new in repls:
    if old not in text:
        raise SystemExit(f'Pattern non trovato in main.js: {old[:90]!r}')
    text = text.replace(old, new, 1)

main.write_text(text, encoding='utf-8')

splash = app / 'electron' / 'splash.html'
splash.write_text(r'''<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Riflessa Hair & Beauty</title>
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
    body {
      display: grid;
      place-items: center;
      font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
      color: #312a27;
      user-select: none;
    }
    .panel {
      width: 492px;
      height: 292px;
      border-radius: 26px;
      background: linear-gradient(145deg, rgba(255,255,255,.98), rgba(247,240,234,.98));
      border: 1px solid rgba(92,71,59,.12);
      box-shadow: 0 24px 70px rgba(48,34,27,.24), 0 4px 14px rgba(48,34,27,.10);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 34px 44px 28px;
      position: relative;
      overflow: hidden;
    }
    .panel::before {
      content: "";
      position: absolute;
      inset: -80px auto auto -80px;
      width: 220px;
      height: 220px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(188,151,126,.16), transparent 68%);
    }
    .logo-wrap {
      width: 286px;
      height: 94px;
      display: grid;
      place-items: center;
      margin-bottom: 18px;
      z-index: 1;
    }
    .logo { max-width: 100%; max-height: 100%; object-fit: contain; filter: drop-shadow(0 2px 3px rgba(0,0,0,.06)); }
    .product {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .22em;
      color: #8a6d5c;
      text-transform: uppercase;
      margin-bottom: 8px;
      z-index: 1;
    }
    .status {
      font-size: 14px;
      color: #625650;
      margin-bottom: 22px;
      z-index: 1;
    }
    .track {
      width: 100%;
      height: 5px;
      border-radius: 99px;
      background: rgba(92,71,59,.10);
      overflow: hidden;
      z-index: 1;
    }
    .bar {
      width: 42%;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, #9e7b67, #c9a58e, #8b6957);
      animation: loading 1.25s cubic-bezier(.4,0,.2,1) infinite;
      transform: translateX(-115%);
    }
    .foot {
      position: absolute;
      bottom: 14px;
      font-size: 10px;
      letter-spacing: .06em;
      color: rgba(71,56,49,.52);
    }
    @keyframes loading {
      0% { transform: translateX(-115%); }
      100% { transform: translateX(340%); }
    }
    @media (prefers-reduced-motion: reduce) { .bar { animation-duration: 2.4s; } }
  </style>
</head>
<body>
  <main class="panel" role="status" aria-label="Avvio di Riflessa Hair & Beauty">
    <div class="logo-wrap"><img class="logo" src="../assets/riflessa-logo.png" alt="Riflessa Hair & Beauty"></div>
    <div class="product">Registratore</div>
    <div class="status">Preparazione ambiente di lavoro…</div>
    <div class="track" aria-hidden="true"><div class="bar"></div></div>
    <div class="foot">Riflessa Hair &amp; Beauty</div>
  </main>
</body>
</html>
''', encoding='utf-8')

test = app / 'tests' / 'startup-splash.test.js'
test.write_text(r'''const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
const splash = fs.readFileSync(path.join(root, 'electron', 'splash.html'), 'utf8');

test('avvio usa splash professionale e mostra la finestra principale solo a caricamento completato', () => {
  assert.match(main, /createSplashWindow\(\)/);
  assert.match(main, /show:\s*false/);
  assert.match(main, /did-finish-load/);
  assert.match(main, /revealMainWindow/);
  assert.match(splash, /riflessa-logo\.png/);
  assert.match(splash, /Preparazione ambiente di lavoro/);
  assert.match(splash, /@keyframes loading/);
});
''', encoding='utf-8')

print('Splash professionale 3.5.4 applicato')
