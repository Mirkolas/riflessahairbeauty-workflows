from pathlib import Path
import json
import shutil
import sys

root = Path(sys.argv[1]).resolve()

updater = r'''const { dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const http = require('http');
const crypto = require('crypto');
const { Readable } = require('stream');

const UPDATE_BUCKET = 'riflessa-15a20.firebasestorage.app';
const UPDATE_PREFIX = 'registratore-updates/current';
const INSTALLER_RE = /^RiflessaRegistratore-Setup-\d+\.\d+\.\d+-x64\.exe(?:\.blockmap)?$/;

function cleanMessage(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function allowedAsset(value) {
  const name = String(value || '');
  return name === 'latest.yml' || INSTALLER_RE.test(name) ? name : '';
}

function storageUrl(asset) {
  const objectName = `${UPDATE_PREFIX}/${asset}`;
  return `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(UPDATE_BUCKET)}/o/${encodeURIComponent(objectName)}?alt=media`;
}

function setupRiflessaAutoUpdater({ app, getMainWindow, getSafetyState, log = console }) {
  const supported = app.isPackaged && process.platform === 'win32';
  let downloadedInfo = null;
  let promptTimer = null;
  let authCheckTimer = null;
  let checking = false;
  let authToken = '';
  let proxyServer = null;
  let proxyUrl = '';
  const proxySecret = crypto.randomBytes(32).toString('hex');
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

  async function proxyRequest(req, res) {
    try {
      const parsed = new URL(req.url || '/', 'http://127.0.0.1');
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length !== 2 || parts[0] !== proxySecret) {
        res.writeHead(404, { 'Cache-Control':'no-store' });
        res.end('Not found');
        return;
      }
      const asset = allowedAsset(decodeURIComponent(parts[1] || ''));
      if (!asset) {
        res.writeHead(404, { 'Cache-Control':'no-store' });
        res.end('Not found');
        return;
      }
      if (!['GET','HEAD'].includes(req.method || '')) {
        res.writeHead(405, { Allow:'GET, HEAD', 'Cache-Control':'no-store' });
        res.end();
        return;
      }
      if (!authToken) {
        res.writeHead(401, { 'Cache-Control':'no-store' });
        res.end('Authentication required');
        return;
      }

      const headers = {
        Authorization: `Bearer ${authToken}`,
        'Cache-Control': 'no-cache'
      };
      if (req.headers.range) headers.Range = String(req.headers.range);

      const upstream = await fetch(storageUrl(asset), {
        method: req.method,
        headers,
        redirect: 'follow'
      });

      const responseHeaders = { 'Cache-Control':'private, no-store, max-age=0' };
      for (const name of ['content-type','content-length','content-range','accept-ranges','etag','last-modified']) {
        const value = upstream.headers.get(name);
        if (value) responseHeaders[name] = value;
      }
      res.writeHead(upstream.status, responseHeaders);
      if (req.method === 'HEAD' || !upstream.body) {
        res.end();
        return;
      }
      const body = Readable.fromWeb(upstream.body);
      body.on('error', error => {
        write('update.proxy.stream.error', { asset, message:cleanMessage(error?.message || error) });
        if (!res.destroyed) res.destroy(error);
      });
      body.pipe(res);
    } catch (error) {
      const message = cleanMessage(error?.message || error);
      write('update.proxy.error', { message });
      if (!res.headersSent) res.writeHead(502, { 'Cache-Control':'no-store' });
      if (!res.writableEnded) res.end('Update proxy error');
    }
  }

  async function ensureProxy() {
    if (proxyUrl) return proxyUrl;
    if (!supported) return '';
    if (proxyServer) {
      await new Promise(resolve => proxyServer.once('listening', resolve));
      return proxyUrl;
    }
    proxyServer = http.createServer((req, res) => { proxyRequest(req, res); });
    proxyServer.on('clientError', (_error, socket) => {
      try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
    });
    await new Promise((resolve, reject) => {
      const onError = error => { proxyServer?.off('listening', onListening); reject(error); };
      const onListening = () => { proxyServer?.off('error', onError); resolve(); };
      proxyServer.once('error', onError);
      proxyServer.once('listening', onListening);
      proxyServer.listen(0, '127.0.0.1');
    });
    const address = proxyServer.address();
    if (!address || typeof address === 'string') throw new Error('Proxy aggiornamenti non avviato');
    proxyUrl = `http://127.0.0.1:${address.port}/${proxySecret}/`;
    write('update.proxy.ready', { host:'127.0.0.1', port:address.port });
    return proxyUrl;
  }

  async function configureFeed() {
    if (!supported || !authToken) return;
    const url = await ensureProxy();
    autoUpdater.setFeedURL({ provider:'generic', url, useMultipleRangeRequest:false });
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
      if (authCheckTimer) clearTimeout(authCheckTimer);
      if (promptTimer) clearTimeout(promptTimer);
      setState({ status:'auth-required' });
      write('update.auth.cleared');
      return snapshot();
    }
    await configureFeed();
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
    if (!downloadedInfo || !authToken) return;
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
    await configureFeed();
    checking = true;
    setState({ status:'checking', lastCheckAt:new Date().toISOString(), lastError:'' });
    try {
      write('update.check.start', { currentVersion:app.getVersion(), channel:'private-firebase-storage' });
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
      if (!status.safe) {
        setState({ status:'download-deferred' });
        write('update.download.deferred', { version:info?.version, reasons:status.reasons });
        return;
      }
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
  app.once('before-quit', () => {
    try { proxyServer?.close(); } catch {}
  });
  return { check, setAuthToken, getState:snapshot };
}

module.exports = { setupRiflessaAutoUpdater, UPDATE_BUCKET, UPDATE_PREFIX, allowedAsset, storageUrl };
'''
(root / 'electron' / 'auto-updater.js').write_text(updater, encoding='utf-8')

pkg_path = root / 'package.json'
pkg = json.loads(pkg_path.read_text(encoding='utf-8'))
if pkg.get('version') != '3.5.11':
    raise SystemExit(f"Versione inattesa: {pkg.get('version')}")
pkg['build']['publish'] = {'provider':'generic', 'url':'http://127.0.0.1/'}
pkg_path.write_text(json.dumps(pkg, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

firebase_path = root / 'firebase.json'
firebase = json.loads(firebase_path.read_text(encoding='utf-8'))
firebase.pop('functions', None)
firebase['storage'] = {'rules':'storage.rules'}
ignore = firebase.get('hosting', {}).get('ignore', [])
if 'storage.rules' not in ignore:
    try:
        idx = ignore.index('firestore.rules') + 1
    except ValueError:
        idx = 0
    ignore.insert(idx, 'storage.rules')
firebase_path.write_text(json.dumps(firebase, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

storage_rules = """rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /registratore-updates/{allPaths=**} {
      allow read: if request.auth != null;
      allow write: if false;
    }

    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}
"""
(root / 'storage.rules').write_text(storage_rules, encoding='utf-8')

functions_dir = root / 'functions'
if functions_dir.exists():
    shutil.rmtree(functions_dir)

auto_test = r'''const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const updater = fs.readFileSync(path.join(root,'electron','auto-updater.js'),'utf8');
const main = fs.readFileSync(path.join(root,'electron','main.js'),'utf8');

test('auto update usa proxy locale e Firebase Storage privato', () => {
  assert.equal(pkg.version, '3.5.11');
  assert.equal(pkg.build.publish.provider, 'generic');
  assert.equal(pkg.build.publish.url, 'http://127.0.0.1/');
  assert.match(updater, /127\.0\.0\.1/);
  assert.match(updater, /crypto\.randomBytes\(32\)/);
  assert.match(updater, /firebasestorage\.googleapis\.com/);
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
(root / 'tests' / 'auto-update.test.js').write_text(auto_test, encoding='utf-8')

private_test = r'''const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const updater = fs.readFileSync(path.join(root,'electron','auto-updater.js'),'utf8');
const preload = fs.readFileSync(path.join(root,'electron','preload.js'),'utf8');
const app = fs.readFileSync(path.join(root,'js','app.js'),'utf8');
const rules = fs.readFileSync(path.join(root,'storage.rules'),'utf8');
const firebase = require('../firebase.json');

test('canale privato non contiene credenziali GitHub nel client', () => {
  for (const source of [preload, app, updater]) {
    assert.doesNotMatch(source, /GH_TOKEN|github_pat|PUBLIC_REPO_TOKEN/);
  }
  assert.match(preload, /setUpdateAuthToken/);
  assert.match(app, /getIdToken/);
  assert.match(updater, /Authorization: `Bearer \$\{authToken\}`/);
});

test('proxy updater è limitato a localhost, path casuale e asset allowlist', () => {
  assert.match(updater, /listen\(0, '127\.0\.0\.1'\)/);
  assert.match(updater, /proxySecret = crypto\.randomBytes\(32\)/);
  assert.match(updater, /parts\.length !== 2 \|\| parts\[0\] !== proxySecret/);
  assert.match(updater, /name === 'latest\.yml' \|\| INSTALLER_RE\.test\(name\)/);
  assert.match(updater, /useMultipleRangeRequest:false/);
});

test('Storage consente solo lettura autenticata del canale update', () => {
  assert.equal(firebase.storage.rules, 'storage.rules');
  assert.match(rules, /match \/registratore-updates\/\{allPaths=\*\*\}/);
  assert.match(rules, /allow read: if request\.auth != null/);
  assert.match(rules, /allow write: if false/);
  assert.match(rules, /match \/\{allPaths=\*\*\}/);
  assert.match(rules, /allow read, write: if false/);
});
'''
(root / 'tests' / 'private-update-channel.test.js').write_text(private_test, encoding='utf-8')
