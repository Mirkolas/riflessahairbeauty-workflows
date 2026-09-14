from pathlib import Path
import json
import sys

if len(sys.argv) != 2:
    raise SystemExit('uso: harden-desktop-3516.py <app_dir>')

root = Path(sys.argv[1])
main = root / 'electron' / 'main.js'
pkg_path = root / 'package.json'
firebase_path = root / 'firebase.json'
firebaserc_path = root / '.firebaserc'
check_path = root / 'scripts' / 'check-project.js'
test_path = root / 'tests' / 'desktop-only-security-v3516.test.js'
note_path = root / 'VERSIONE_3_5_16_DESKTOP_ONLY.txt'

# ---------------------------------------------------------------------------
# Electron: nessuna UI remota/Hosting, solo file locali inclusi nel pacchetto.
# ---------------------------------------------------------------------------
s = main.read_text(encoding='utf-8')
s = s.replace("const { app, BrowserWindow, ipcMain, session } = require('electron');", "const { app, BrowserWindow, ipcMain, session } = require('electron');")
if "const { fileURLToPath } = require('url');" not in s:
    s = s.replace("const crypto = require('crypto');", "const crypto = require('crypto');\nconst { fileURLToPath } = require('url');", 1)
s = s.replace("const HOSTED_POS = 'https://riflessa-15a20.web.app/';\n", "")
s = s.replace(
    "const LOCAL_POS = path.join(__dirname, '..', 'index.html');",
    "const APP_ROOT = path.resolve(__dirname, '..');\nconst LOCAL_POS = path.join(APP_ROOT, 'index.html');",
    1
)

anchor = "function createSplashWindow() {"
helper = r'''function isInsideAppRoot(filePath) {
  const candidate = path.resolve(filePath);
  const relative = path.relative(APP_ROOT, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isTrustedRendererUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'file:') return false;
    return isInsideAppRoot(fileURLToPath(parsed));
  } catch {
    return false;
  }
}

'''
if helper.strip() not in s:
    if anchor not in s:
        raise SystemExit('anchor createSplashWindow non trovato')
    s = s.replace(anchor, helper + anchor, 1)

old_nav = """  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));\n  mainWindow.webContents.on('will-navigate', (event, url) => {\n    const allowed = url.startsWith('file://') || url.startsWith(HOSTED_POS);\n    if (!allowed) event.preventDefault();\n  });"""
new_nav = """  if (app.isPackaged) mainWindow.removeMenu();\n  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));\n  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());\n  mainWindow.webContents.on('will-navigate', (event, url) => {\n    if (!isTrustedRendererUrl(url)) event.preventDefault();\n  });\n  mainWindow.webContents.on('devtools-opened', () => {\n    if (app.isPackaged && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.closeDevTools();\n  });\n  mainWindow.webContents.on('before-input-event', (event, input) => {\n    if (!app.isPackaged) return;\n    const key = String(input?.key || '').toUpperCase();\n    const modifier = Boolean(input?.control || input?.meta);\n    const blocked = key === 'F12' || (modifier && input?.shift && ['I','J','C'].includes(key));\n    if (blocked) event.preventDefault();\n  });"""
if old_nav in s:
    s = s.replace(old_nav, new_nav, 1)
elif new_nav not in s:
    raise SystemExit('blocco navigazione atteso non trovato')

old_load = """  if (process.env.RIFLESSA_HOSTED_UI === '1') {\n    const hostedUrl = `${HOSTED_POS}?appVersion=${encodeURIComponent(app.getVersion())}&ts=${Date.now()}`;\n    mainWindow.loadURL(hostedUrl, { extraHeaders: 'Cache-Control: no-cache\\r\\nPragma: no-cache\\r\\n' });\n    mainWindow.webContents.once('did-fail-load', (_e, code) => {\n      if (code !== -3 && !mainWindow?.isDestroyed()) mainWindow.loadFile(LOCAL_POS);\n    });\n  } else {\n    mainWindow.loadFile(LOCAL_POS);\n  }"""
if old_load in s:
    s = s.replace(old_load, "  mainWindow.loadFile(LOCAL_POS);", 1)
elif "process.env.RIFLESSA_HOSTED_UI" in s or "HOSTED_POS" in s:
    raise SystemExit('modalita hosted residua in main.js')

s = s.replace(
    "appendMaster(paths().masterTxt, 'app.started', { version: app.getVersion(), localUi: process.env.RIFLESSA_HOSTED_UI !== '1', rtHost: RT_HOST });",
    "appendMaster(paths().masterTxt, 'app.started', { version: app.getVersion(), localUi: true, rtHost: RT_HOST });",
    1
)
old_trusted = """function trusted(event) {\n  const url = event?.senderFrame?.url || event?.sender?.getURL?.() || '';\n  if (url.startsWith('file://') || url.startsWith(HOSTED_POS)) return true;\n  throw new Error('Origine UI non autorizzata per operazioni fiscali');\n}"""
new_trusted = """function trusted(event) {\n  const url = event?.senderFrame?.url || event?.sender?.getURL?.() || '';\n  if (isTrustedRendererUrl(url)) return true;\n  throw new Error('Origine UI non autorizzata per operazioni fiscali');\n}"""
if old_trusted in s:
    s = s.replace(old_trusted, new_trusted, 1)
elif new_trusted not in s:
    raise SystemExit('trusted(event) atteso non trovato')

for forbidden in ['HOSTED_POS', 'RIFLESSA_HOSTED_UI']:
    if forbidden in s:
        raise SystemExit(f'{forbidden} ancora presente in main.js')
main.write_text(s, encoding='utf-8')

# ---------------------------------------------------------------------------
# Package: build desktop-only + Electron fuses + UI 3.5.15 realmente inclusa.
# ---------------------------------------------------------------------------
pkg = json.loads(pkg_path.read_text(encoding='utf-8'))
scripts = pkg.setdefault('scripts', {})
scripts.pop('start:hosted', None)
scripts['firebase:rules'] = 'firebase deploy --only firestore:rules'
scripts.pop('firebase:deploy', None)
pkg.setdefault('devDependencies', {})['@electron/fuses'] = '^2.1.2'
build = pkg.setdefault('build', {})
build['asar'] = {'disableIntegrity': False}
build['electronFuses'] = {
    'runAsNode': False,
    'enableCookieEncryption': True,
    'enableNodeOptionsEnvironmentVariable': False,
    'enableNodeCliInspectArguments': False,
    'enableEmbeddedAsarIntegrityValidation': True,
    'onlyLoadAppFromAsar': True
}
files = build.setdefault('files', [])
if 'ui-v3515.css' not in files:
    try:
        idx = files.index('ui-v3513.css') + 1
    except ValueError:
        idx = len(files)
    files.insert(idx, 'ui-v3515.css')
pkg_path.write_text(json.dumps(pkg, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

# Firebase Hosting non fa piu parte del progetto distribuibile.
firebase_path.write_text(json.dumps({'firestore': {'rules': 'firestore.rules'}}, indent=2) + '\n', encoding='utf-8')
firebaserc_path.write_text(json.dumps({'projects': {'default': 'riflessa-15a20'}, 'etags': {}}, indent=2) + '\n', encoding='utf-8')

# Check permanente: impedisce di riattivare per errore Hosting o UI remota.
check = check_path.read_text(encoding='utf-8')
old_firebase_check = """const firebase = JSON.parse(fs.readFileSync(path.join(root, \"firebase.json\"), \"utf8\"));\nif (firebase.storage) { console.error(\"Firebase Storage non deve essere richiesto: il progetto resta compatibile Spark\"); ok = false; }\nif (firebase.firestore?.rules !== \"firestore.rules\") { console.error(\"Firestore Rules non configurate\"); ok = false; }"""
new_firebase_check = old_firebase_check + """\nif (firebase.hosting) { console.error(\"Firebase Hosting vietato: il registratore deve essere desktop-only\"); ok = false; }\nconst mainJs = fs.readFileSync(path.join(root, \"electron/main.js\"), \"utf8\");\nif (mainJs.includes(\"RIFLESSA_HOSTED_UI\") || mainJs.includes(\"HOSTED_POS\") || mainJs.includes(\"riflessa-15a20.web.app\")) {\n  console.error(\"UI remota vietata nel main process\"); ok = false;\n}\nif (!mainJs.includes(\"isTrustedRendererUrl\") || !mainJs.includes(\"closeDevTools\") || !mainJs.includes(\"before-input-event\")) {\n  console.error(\"Hardening renderer Electron incompleto\"); ok = false;\n}\nif (pkg.scripts?.[\"start:hosted\"] || pkg.scripts?.[\"firebase:deploy\"] || !pkg.scripts?.[\"firebase:rules\"]) {\n  console.error(\"Script package non desktop-only\"); ok = false;\n}\nif (!pkg.build?.electronFuses?.enableEmbeddedAsarIntegrityValidation || !pkg.build?.electronFuses?.onlyLoadAppFromAsar || pkg.build?.electronFuses?.runAsNode !== false || pkg.build?.electronFuses?.enableNodeCliInspectArguments !== false) {\n  console.error(\"Electron fuses di sicurezza incompleti\"); ok = false;\n}\nif (!pkg.build?.files?.includes(\"ui-v3515.css\")) { console.error(\"ui-v3515.css non incluso nel pacchetto\"); ok = false; }"""
if old_firebase_check in check and 'Firebase Hosting vietato' not in check:
    check = check.replace(old_firebase_check, new_firebase_check, 1)
check_path.write_text(check, encoding='utf-8')

# Test specifici regressione sicurezza.
test_path.write_text(r'''const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const firebase = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8'));
const firebaserc = JSON.parse(fs.readFileSync(path.join(root, '.firebaserc'), 'utf8'));

test('registratore non contiene piu modalita UI hosted', () => {
  assert.doesNotMatch(main, /HOSTED_POS|RIFLESSA_HOSTED_UI|riflessa-15a20\.web\.app/);
  assert.doesNotMatch(main, /mainWindow\.loadURL\(/);
  assert.match(main, /mainWindow\.loadFile\(LOCAL_POS\)/);
  assert.match(main, /isTrustedRendererUrl/);
});

test('produzione blocca DevTools e navigazioni fuori dal pacchetto', () => {
  assert.match(main, /devTools:\s*!app\.isPackaged/);
  assert.match(main, /devtools-opened/);
  assert.match(main, /closeDevTools\(\)/);
  assert.match(main, /before-input-event/);
  assert.match(main, /will-attach-webview/);
  assert.match(main, /if \(!isTrustedRendererUrl\(url\)\) event\.preventDefault\(\)/);
});

test('Firebase Hosting e target Hosting sono rimossi dalla sorgente', () => {
  assert.equal(firebase.hosting, undefined);
  assert.equal(firebase.firestore?.rules, 'firestore.rules');
  assert.equal(firebaserc.targets, undefined);
  assert.equal(pkg.scripts['start:hosted'], undefined);
  assert.equal(pkg.scripts['firebase:deploy'], undefined);
  assert.equal(pkg.scripts['firebase:rules'], 'firebase deploy --only firestore:rules');
});

test('build usa ASAR integrity e fuses anti-tampering', () => {
  assert.equal(pkg.build?.asar?.disableIntegrity, false);
  assert.equal(pkg.build?.electronFuses?.runAsNode, false);
  assert.equal(pkg.build?.electronFuses?.enableCookieEncryption, true);
  assert.equal(pkg.build?.electronFuses?.enableNodeOptionsEnvironmentVariable, false);
  assert.equal(pkg.build?.electronFuses?.enableNodeCliInspectArguments, false);
  assert.equal(pkg.build?.electronFuses?.enableEmbeddedAsarIntegrityValidation, true);
  assert.equal(pkg.build?.electronFuses?.onlyLoadAppFromAsar, true);
  assert.ok(pkg.build?.files?.includes('ui-v3515.css'));
});
''', encoding='utf-8')

note_path.write_text('''Riflessa Registratore 3.5.16 - desktop only / hardening\n\n- Firebase Hosting rimosso dalla configurazione dell'app.\n- Modalita RIFLESSA_HOSTED_UI rimossa: Electron carica solo index.html locale.\n- IPC fiscale accetta esclusivamente renderer file:// contenuti nella directory dell'app.\n- Navigazioni esterne, nuove finestre e webview bloccate.\n- DevTools e relative scorciatoie bloccati nel pacchetto production.\n- Electron fuses: RunAsNode off, NODE_OPTIONS off, inspect CLI off, cookie encryption on, ASAR integrity on, OnlyLoadAppFromAsar on.\n- ui-v3515.css incluso esplicitamente nel pacchetto.\n- Nessuna credenziale privilegiata viene aggiunta al client; Firebase Web config resta un identificatore client e la sicurezza dei dati continua a essere applicata dalle Firestore Rules.\n- Nessuna modifica ai comandi fiscali DADO RT30.\n''', encoding='utf-8')

print('Hardening desktop-only 3.5.16 applicato')
