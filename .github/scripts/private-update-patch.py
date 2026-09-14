from pathlib import Path
import json
import sys

root = Path(sys.argv[1]).resolve()

updater = r'''const { dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

const UPDATE_BASE_URL = 'https://europe-west1-riflessa-15a20.cloudfunctions.net/privateUpdates/';

function cleanMessage(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function setupRiflessaAutoUpdater({ app, getMainWindow, getSafetyState, log = console }) {
  const supported = app.isPackaged && process.platform === 'win32';
  let downloadedInfo = null;
  let promptTimer = null;
  let authCheckTimer = null;
  let checking = false;
  let authToken = '';
  const state = {
    supported,
    authenticated: false,
    status: supported ? 'auth-required' : 'disabled',
    currentVersion: app.getVersion(),
    availableVersion: '',
    downloadedVersion: '',
    lastCheckAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: '',
    downloadPercent: null
  };
  const snapshot = () => ({ ...state });
  const write = (event, data = {}) => { try { log(event, data); } catch {} };
  const setState = (patch = {}) => Object.assign(state, patch);

  function configureFeed() {
    if (!supported || !authToken) return;
    const requestHeaders = { Authorization: `Bearer ${authToken}`, 'Cache-Control': 'no-cache' };
    autoUpdater.requestHeaders = requestHeaders;
    autoUpdater.setFeedURL({ provider:'generic', url:UPDATE_BASE_URL, useMultipleRangeRequest:false, requestHeaders });
  }

  function scheduleAuthenticatedCheck(delay = 1500) {
    if (!supported || !authToken) return;
    if (authCheckTimer) clearTimeout(authCheckTimer);
    authCheckTimer = setTimeout(() => check().catch(() => {}), delay);
    authCheckTimer.unref?.();
  }

  async function setAuthToken(value) {
    authToken = String(value || '').trim();
    setState({ authenticated:Boolean(authToken) });
    if (!supported) return snapshot();
    if (!authToken) {
      setState({ status:'auth-required' });
      write('update.auth.cleared');
      return snapshot();
    }
    configureFeed();
    if (!downloadedInfo) setState({ status:'idle', lastError:'' });
    write('update.auth.ready');
    scheduleAuthenticatedCheck();
    return snapshot();
  }

  async function safety() {
    try {
      const result = await getSafetyState();
      return result && typeof result === 'object' ? result : { safe:false, reasons:['Stato sicurezza non disponibile'] };
    } catch (error) {
      return { safe:false, reasons:[`Controllo sicurezza non riuscito: ${cleanMessage(error?.message || error)}`] };
    }
  }

  function schedulePrompt(delay) {
    if (promptTimer) clearTimeout(promptTimer);
    promptTimer = setTimeout(() => { promptInstall().catch(error => {
      const message = cleanMessage(error?.message || error);
      setState({ status:'error', lastErrorAt:new Date().toISOString(), lastError:message });
      write('update.prompt.error',{message});
    }); }, delay);
    promptTimer.unref?.();
  }

  async function promptInstall() {
    if (!downloadedInfo) return;
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    const status = await safety();
    if (!status.safe) {
      setState({ status:'install-blocked' });
      write('update.install.blocked', { version:downloadedInfo.version, reasons:status.reasons });
      await dialog.showMessageBox(win, { type:'warning', title:'Aggiornamento pronto ma non installabile', message:`Riflessabeautyapp ${downloadedInfo.version} è stato scaricato, ma l'installazione è bloccata per sicurezza.`, detail:(status.reasons || []).join('\n') || 'Completa prima le operazioni fiscali aperte.', buttons:['OK'] });
      schedulePrompt(30 * 60 * 1000);
      return;
    }
    const answer = await dialog.showMessageBox(win, { type:'info', title:'Aggiornamento Riflessabeautyapp', message:`È pronto l'aggiornamento ${downloadedInfo.version}.`, detail:'L’app verrà chiusa, aggiornata e riavviata. Nessuna operazione fiscale risulta pendente.', buttons:['Installa e riavvia','Più tardi'], defaultId:0, cancelId:1, noLink:true });
    if (answer.response !== 0) {
      setState({ status:'downloaded' });
      write('update.install.deferred', { version:downloadedInfo.version });
      schedulePrompt(30 * 60 * 1000);
      return;
    }
    const finalStatus = await safety();
    if (!finalStatus.safe) {
      setState({ status:'install-blocked' });
      write('update.install.blocked.final', { version:downloadedInfo.version, reasons:finalStatus.reasons });
      await dialog.showMessageBox(win, { type:'warning', title:'Aggiornamento rinviato', message:'Nel frattempo è iniziata un’operazione fiscale. L’aggiornamento non verrà installato.', detail:(finalStatus.reasons || []).join('\n'), buttons:['OK'] });
      schedulePrompt(30 * 60 * 1000);
      return;
    }
    setState({ status:'installing' });
    write('update.install.start', { version:downloadedInfo.version });
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
  }

  async function check() {
    if (!supported || checking) return;
    if (!authToken) {
      setState({ status:'auth-required', authenticated:false });
      return;
    }
    configureFeed();
    checking = true;
    setState({ status:'checking', lastCheckAt:new Date().toISOString(), lastError:'' });
    try {
      write('update.check.start', { currentVersion:app.getVersion(), channel:'private-firebase' });
      await autoUpdater.checkForUpdates();
    } catch (error) {
      const message = cleanMessage(error?.message || error);
      setState({ status:'error', lastErrorAt:new Date().toISOString(), lastError:message });
      write('update.check.error', { message });
    } finally { checking = false; }
  }

  if (!supported) {
    write('update.disabled', { packaged:app.isPackaged, platform:process.platform });
    return { check, setAuthToken, getState:snapshot };
  }
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  if ('disableWebInstaller' in autoUpdater) autoUpdater.disableWebInstaller = true;
  autoUpdater.on('checking-for-update', () => { setState({ status:'checking' }); write('update.checking'); });
  autoUpdater.on('update-not-available', info => {
    setState({ status:'up-to-date', availableVersion:'', downloadPercent:null, lastSuccessAt:new Date().toISOString() });
    write('update.none', { version:info?.version || app.getVersion() });
  });
  autoUpdater.on('update-available', async info => {
    setState({ status:'available', availableVersion:String(info?.version || ''), downloadPercent:0 });
    write('update.available', { version:info?.version });
    try {
      const status = await safety();
      if (!status.safe) { setState({ status:'download-deferred' }); write('update.download.deferred', { version:info?.version, reasons:status.reasons }); return; }
      setState({ status:'downloading' });
      await autoUpdater.downloadUpdate();
    } catch (error) {
      const message = cleanMessage(error?.message || error);
      setState({ status:'error', lastErrorAt:new Date().toISOString(), lastError:message });
      write('update.download.error', { message });
    }
  });
  autoUpdater.on('download-progress', progress => {
    const percent = Math.round(Number(progress?.percent || 0));
    setState({ status:'downloading', downloadPercent:percent });
    write('update.download.progress', { percent });
  });
  autoUpdater.on('update-downloaded', info => {
    downloadedInfo = { version:info?.version || '', releaseName:info?.releaseName || '' };
    setState({ status:'downloaded', downloadedVersion:downloadedInfo.version, downloadPercent:100, lastSuccessAt:new Date().toISOString() });
    write('update.downloaded', downloadedInfo);
    schedulePrompt(500);
  });
  autoUpdater.on('error', error => {
    const message = cleanMessage(error?.message || error);
    setState({ status:'error', lastErrorAt:new Date().toISOString(), lastError:message });
    write('update.error', { message });
  });
  const periodic = setInterval(() => { if (authToken) check().catch(() => {}); }, 6 * 60 * 60 * 1000);
  periodic.unref?.();
  return { check, setAuthToken, getState:snapshot };
}

module.exports = { setupRiflessaAutoUpdater, UPDATE_BASE_URL };
'''
(root/'electron/auto-updater.js').write_text(updater, encoding='utf-8')

preload_path = root/'electron/preload.js'
preload = preload_path.read_text(encoding='utf-8')
old = "  getOperationalState: () => ipcRenderer.invoke('axon:getOperationalState'),\n"
new = old + "  setUpdateAuthToken: token => ipcRenderer.invoke('axon:setUpdateAuthToken', token),\n"
if old not in preload:
    raise SystemExit('marker preload non trovato')
preload_path.write_text(preload.replace(old, new, 1), encoding='utf-8')

main_path = root/'electron/main.js'
main = main_path.read_text(encoding='utf-8')
marker = "function logger(name) { return new JsonlLogger(paths().logs, name, paths().masterTxt); }\n"
insert = "ipcMain.handle('axon:setUpdateAuthToken', async (event, token) => {\n  trusted(event);\n  if (!autoUpdateController?.setAuthToken) return { supported:false, status:'disabled' };\n  return autoUpdateController.setAuthToken(String(token || ''));\n});\n\n"
if marker not in main:
    raise SystemExit('marker main non trovato')
main_path.write_text(main.replace(marker, insert + marker, 1), encoding='utf-8')

app_path = root/'js/app.js'
app = app_path.read_text(encoding='utf-8')
old_state = "  rtStatusTimer: null\n};"
if old_state not in app:
    raise SystemExit('marker stato app non trovato')
app = app.replace(old_state, "  rtStatusTimer: null,\n  updateAuthTimer: null\n};", 1)
auth_marker = '$("logoutBtn").onclick = () => signOut(auth);\n\nonAuthStateChanged(auth, async user => {'
auth_insert = '''$("logoutBtn").onclick = () => signOut(auth);

async function syncUpdaterAuth(user, forceRefresh = false) {
  try {
    const token = user ? await user.getIdToken(forceRefresh) : "";
    await window.axonPrinter?.setUpdateAuthToken?.(token);
  } catch (error) {
    console.warn("Autenticazione auto-update non disponibile:", error?.message || error);
  }
}

onAuthStateChanged(auth, async user => {'''
if auth_marker not in app:
    raise SystemExit('marker auth app non trovato')
app = app.replace(auth_marker, auth_insert, 1)
no_user = '''  if (!user) {
    state.cashSessionsLoaded=false; state.fiscalClosuresLoaded=false; state.autoCashInitialDone=false; state.autoCashOpening=false;'''
if no_user not in app:
    raise SystemExit('marker no-user non trovato')
app = app.replace(no_user, '''  if (!user) {
    await syncUpdaterAuth(null);
    state.cashSessionsLoaded=false; state.fiscalClosuresLoaded=false; state.autoCashInitialDone=false; state.autoCashOpening=false;''', 1)
ui_marker = '''  $("currentUser").textContent = user.email || "Operatore";
  $("loginView").classList.add("hidden");'''
if ui_marker not in app:
    raise SystemExit('marker UI auth non trovato')
app = app.replace(ui_marker, '''  await syncUpdaterAuth(user);
  clearInterval(state.updateAuthTimer);
  state.updateAuthTimer = setInterval(() => syncUpdaterAuth(user, true), 45 * 60 * 1000);

  $("currentUser").textContent = user.email || "Operatore";
  $("loginView").classList.add("hidden");''', 1)
cleanup_marker = '''  clearInterval(state.rtStatusTimer);
  state.rtStatusTimer = null;
}'''
if cleanup_marker not in app:
    raise SystemExit('marker cleanup non trovato')
app = app.replace(cleanup_marker, '''  clearInterval(state.rtStatusTimer);
  state.rtStatusTimer = null;
  clearInterval(state.updateAuthTimer);
  state.updateAuthTimer = null;
}''', 1)
app_path.write_text(app, encoding='utf-8')

pkg_path = root/'package.json'
pkg = json.loads(pkg_path.read_text(encoding='utf-8'))
pkg['build']['publish'] = {
    'provider':'generic',
    'url':'https://europe-west1-riflessa-15a20.cloudfunctions.net/privateUpdates/'
}
pkg_path.write_text(json.dumps(pkg, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

firebase_path = root/'firebase.json'
firebase = json.loads(firebase_path.read_text(encoding='utf-8'))
firebase['functions'] = {'source':'functions','runtime':'nodejs22'}
firebase_path.write_text(json.dumps(firebase, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

functions = root/'functions'
functions.mkdir(exist_ok=True)
(functions/'package.json').write_text(json.dumps({
    'name':'riflessa-private-updates',
    'private':True,
    'main':'index.js',
    'engines':{'node':'22'},
    'dependencies':{
        '@google-cloud/storage':'^7.16.0',
        'firebase-admin':'^13.0.0',
        'firebase-functions':'^6.3.0'
    }
}, indent=2) + '\n', encoding='utf-8')

function_code = r'''const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { Storage } = require('@google-cloud/storage');

initializeApp();
const UPDATE_SIGNER_SERVICE_ACCOUNT = defineSecret('UPDATE_SIGNER_SERVICE_ACCOUNT');
const UPDATE_BUCKET = 'riflessa-15a20.firebasestorage.app';
const UPDATE_PREFIX = 'registratore-updates/current';
const INSTALLER_RE = /^RiflessaRegistratore-Setup-\d+\.\d+\.\d+-x64\.exe(?:\.blockmap)?$/;
let signingStorage = null;

function assetFromPath(pathname) {
  const parts = String(pathname || '').split('/').filter(Boolean);
  const asset = decodeURIComponent(parts[parts.length - 1] || '');
  if (asset === 'latest.yml' || INSTALLER_RE.test(asset)) return asset;
  return '';
}

async function authorizedUser(req) {
  const header = String(req.get('authorization') || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return { ok:false, status:401, message:'Autenticazione richiesta' };
  try {
    const decoded = await getAuth().verifyIdToken(match[1], true);
    const snap = await getFirestore().doc(`users/${decoded.uid}`).get();
    const role = snap.exists ? String(snap.data()?.role || '') : '';
    if (!['admin','staff'].includes(role)) return { ok:false, status:403, message:'Account non autorizzato' };
    return { ok:true, uid:decoded.uid, role };
  } catch {
    return { ok:false, status:401, message:'Sessione non valida o scaduta' };
  }
}

function storageClient() {
  if (signingStorage) return signingStorage;
  const credentials = JSON.parse(UPDATE_SIGNER_SERVICE_ACCOUNT.value());
  signingStorage = new Storage({ projectId:credentials.project_id, credentials });
  return signingStorage;
}

exports.privateUpdates = onRequest({
  region:'europe-west1',
  secrets:[UPDATE_SIGNER_SERVICE_ACCOUNT],
  timeoutSeconds:30,
  memory:'256MiB',
  maxInstances:5
}, async (req, res) => {
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.set('Vary', 'Authorization');
  if (!['GET','HEAD'].includes(req.method)) return res.status(405).send('Metodo non consentito');

  const auth = await authorizedUser(req);
  if (!auth.ok) return res.status(auth.status).send(auth.message);

  const asset = assetFromPath(req.path);
  if (!asset) return res.status(404).send('Asset update non valido');

  const file = storageClient().bucket(UPDATE_BUCKET).file(`${UPDATE_PREFIX}/${asset}`);
  const [exists] = await file.exists();
  if (!exists) return res.status(404).send('Aggiornamento non disponibile');

  if (req.method === 'HEAD') {
    const [metadata] = await file.getMetadata();
    if (metadata.size) res.set('Content-Length', String(metadata.size));
    if (metadata.contentType) res.set('Content-Type', metadata.contentType);
    return res.status(200).end();
  }

  const [signedUrl] = await file.getSignedUrl({
    version:'v4',
    action:'read',
    expires:Date.now() + 10 * 60 * 1000,
    responseDisposition:`attachment; filename="${asset}"`
  });
  return res.redirect(302, signedUrl);
});

module.exports.assetFromPath = assetFromPath;
'''
(functions/'index.js').write_text(function_code, encoding='utf-8')

auto_test = r'''const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const updater = fs.readFileSync(path.join(root,'electron','auto-updater.js'),'utf8');
const main = fs.readFileSync(path.join(root,'electron','main.js'),'utf8');

test('auto update usa endpoint Firebase privato autenticato', () => {
  assert.equal(pkg.version, '3.5.11');
  assert.equal(pkg.build.publish.provider, 'generic');
  assert.match(pkg.build.publish.url, /privateUpdates\/$/);
  assert.match(updater, /Authorization: `Bearer \$\{authToken\}`/);
  assert.match(updater, /setAuthToken/);
  assert.match(main, /axon:setUpdateAuthToken/);
  assert.equal(pkg.build.nsis.perMachine, false);
  assert.ok(pkg.dependencies['electron-updater']);
});

test('installazione update richiede conferma e doppio preflight fiscale', () => {
  assert.match(updater, /Installa e riavvia/);
  assert.match(updater, /const finalStatus = await safety\(\)/);
  assert.match(updater, /autoInstallOnAppQuit = false/);
  assert.match(updater, /quitAndInstall\(false, true\)/);
  assert.match(main, /riflessaFiscalActiveIntentV356/);
  assert.match(main, /riflessaFiscalRecoveryV355/);
  assert.match(main, /idem\.uncertain/);
});
'''
(root/'tests/auto-update.test.js').write_text(auto_test, encoding='utf-8')

private_test = r'''const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const fn = fs.readFileSync(path.join(root,'functions','index.js'),'utf8');
const preload = fs.readFileSync(path.join(root,'electron','preload.js'),'utf8');
const app = fs.readFileSync(path.join(root,'js','app.js'),'utf8');

test('canale privato non contiene token GitHub nel client', () => {
  assert.doesNotMatch(preload, /GH_TOKEN|github_pat|PUBLIC_REPO_TOKEN/);
  assert.doesNotMatch(app, /GH_TOKEN|github_pat|PUBLIC_REPO_TOKEN/);
  assert.match(preload, /setUpdateAuthToken/);
  assert.match(app, /getIdToken/);
});

test('endpoint update verifica Firebase Auth e ruolo staff admin', () => {
  assert.match(fn, /verifyIdToken/);
  assert.match(fn, /\['admin','staff'\]/);
  assert.match(fn, /getSignedUrl/);
  assert.match(fn, /10 \* 60 \* 1000/);
  assert.match(fn, /INSTALLER_RE/);
});
'''
(root/'tests/private-update-channel.test.js').write_text(private_test, encoding='utf-8')

check_path = root/'scripts/check-project.js'
check = check_path.read_text(encoding='utf-8')
check = check.replace('pkg.version !== "3.5.10"', 'pkg.version !== "3.5.11"')
check = check.replace('Versione candidata attesa: 3.5.10', 'Versione candidata attesa: 3.5.11')
check_path.write_text(check, encoding='utf-8')
