const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { spawnSync } = require('child_process');
const admin = require('firebase-admin');

const backupPathInput = process.env.BACKUP_PATH;
const requestedFormat = process.env.BACKUP_FORMAT || '';
const TARGET_PROJECT_ID = process.env.PROJECT_ID;
const BACKUP_PROJECT_ID = process.env.BACKUP_PROJECT_ID || TARGET_PROJECT_ID;
const FIRESTORE_MODE = String(process.env.FIRESTORE_MODE || 'merge').toLowerCase();
const VERIFY_RESTORE = String(process.env.VERIFY_RESTORE || '1') !== '0';
const RESTORE_HOSTING_DIR = process.env.RESTORE_HOSTING_DIR || '';
const PRESERVE_ROOTS = new Set(String(process.env.FIRESTORE_PRESERVE_ROOTS || '_backupChanges').split(',').map(x => x.trim()).filter(Boolean));
if (!backupPathInput) throw new Error('BACKUP_PATH non impostata');
if (!['merge', 'exact'].includes(FIRESTORE_MODE)) throw new Error(`FIRESTORE_MODE non valida: ${FIRESTORE_MODE}`);

function parseHashConfig(raw) {
  try { return JSON.parse(raw); } catch {}
  const cfg = {};
  for (const key of ['algorithm','base64_signer_key','base64_salt_separator','rounds','mem_cost']) {
    const re = new RegExp(`${key}\\s*[:=]\\s*(?:"([^"]*)"|'([^']*)'|([^,\\s}]+))`, 'i');
    const m = String(raw || '').match(re); if (m) cfg[key] = m[1] ?? m[2] ?? m[3];
  }
  if (cfg.rounds !== undefined) cfg.rounds = Number(cfg.rounds);
  if (cfg.mem_cost !== undefined) cfg.mem_cost = Number(cfg.mem_cost);
  return cfg;
}
function normalizedHashConfig(raw) {
  const cfg = parseHashConfig(raw);
  for (const key of ['algorithm','base64_signer_key','base64_salt_separator','rounds','mem_cost']) {
    if (cfg[key] === undefined || cfg[key] === null || cfg[key] === '') throw new Error(`Parametro hash mancante: ${key}`);
  }
  return { algorithm: String(cfg.algorithm).toUpperCase(), base64_signer_key: String(cfg.base64_signer_key), base64_salt_separator: String(cfg.base64_salt_separator), rounds: Number(cfg.rounds), mem_cost: Number(cfg.mem_cost) };
}
function canonicalHashConfig() { return JSON.stringify(normalizedHashConfig(process.env.AUTH_HASH_CONFIG)); }
function deriveKey(domain) { return crypto.createHash('sha256').update(`${domain}\0${canonicalHashConfig()}`).digest(); }
function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function rootOf(documentPath) { return String(documentPath || '').split('/')[0]; }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
  return out;
}
function canonical(value) { return JSON.stringify(stable(value)); }
function listFilesRecursive(root, prefix = '') {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(root, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFilesRecursive(absolute, relative));
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}
function hashTree(root) {
  const hash = crypto.createHash('sha256');
  const files = listFilesRecursive(root);
  for (const relative of files) {
    hash.update(relative); hash.update('\0'); hash.update(fs.readFileSync(path.join(root, relative))); hash.update('\0');
  }
  return { sha256: hash.digest('hex'), fileCount: files.length, files };
}

const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
if (!TARGET_PROJECT_ID) throw new Error('PROJECT_ID target non impostato');
if (credentials.project_id && credentials.project_id !== TARGET_PROJECT_ID) throw new Error(`Service account ${credentials.project_id} non corrisponde al target ${TARGET_PROJECT_ID}`);
if (String(process.env.REQUIRE_DIFFERENT_TARGET || '') === '1' && TARGET_PROJECT_ID === BACKUP_PROJECT_ID) throw new Error('Blocco sicurezza: il progetto test coincide con il progetto sorgente');
admin.initializeApp({ credential: admin.credential.cert(credentials), projectId: TARGET_PROJECT_ID });
const db = admin.firestore();
const auth = admin.auth();

function decode(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(decode);
  if (typeof value !== 'object') return value;
  if (value.__firestoreType === 'timestamp') return new admin.firestore.Timestamp(value.seconds, value.nanoseconds);
  if (value.__firestoreType === 'geopoint') return new admin.firestore.GeoPoint(value.latitude, value.longitude);
  if (value.__firestoreType === 'reference') return db.doc(value.path);
  if (value.__firestoreType === 'bytes') return Buffer.from(value.base64, 'base64');
  const out = {}; for (const [k, v] of Object.entries(value)) out[k] = decode(v); return out;
}
function encode(value) {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof admin.firestore.Timestamp) return { __firestoreType: 'timestamp', seconds: value.seconds, nanoseconds: value.nanoseconds };
  if (value instanceof admin.firestore.GeoPoint) return { __firestoreType: 'geopoint', latitude: value.latitude, longitude: value.longitude };
  if (value instanceof admin.firestore.DocumentReference) return { __firestoreType: 'reference', path: value.path };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { __firestoreType: 'bytes', base64: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(encode);
  if (typeof value === 'object') { const out = {}; for (const [key, child] of Object.entries(value)) out[key] = encode(child); return out; }
  return value;
}
function readSnapshotDir(dir) {
  const manifest = readJson(path.join(dir, 'manifest.json'));
  const documents = new Map();
  for (const part of manifest.parts || []) {
    const rows = fs.readFileSync(path.join(dir, part), 'utf8').split('\n').filter(Boolean);
    for (const row of rows) {
      const item = JSON.parse(row);
      if (!item.path || item.data === undefined) throw new Error(`Documento Firestore non valido in ${part}`);
      if (!PRESERVE_ROOTS.has(rootOf(item.path))) documents.set(item.path, item.data);
    }
  }
  const preservedInSnapshot = Number(manifest.documentCount || 0) - documents.size;
  if (documents.size + preservedInSnapshot !== Number(manifest.documentCount || 0)) throw new Error(`Conteggio snapshot incoerente: ${dir}`);
  return { manifest, documents, preservedInSnapshot };
}
async function writeDocuments(documents) {
  let batch = db.batch(), pending = 0, restored = 0;
  for (const [documentPath, data] of documents) {
    batch.set(db.doc(documentPath), decode(data), { merge: false }); pending += 1; restored += 1;
    if (pending >= 400) { await batch.commit(); batch = db.batch(); pending = 0; }
  }
  if (pending) await batch.commit();
  return restored;
}
async function walkCurrentCollection(collectionRef, paths) {
  const snapshot = await collectionRef.get();
  for (const document of snapshot.docs) {
    paths.add(document.ref.path);
    for (const child of await document.ref.listCollections()) await walkCurrentCollection(child, paths);
  }
}
async function listCurrentDataPaths() {
  const paths = new Set();
  for (const root of await db.listCollections()) {
    if (PRESERVE_ROOTS.has(root.id)) continue;
    await walkCurrentCollection(root, paths);
  }
  return paths;
}
async function deleteExtraDocuments(targetPaths) {
  const current = await listCurrentDataPaths();
  const extras = [...current].filter(p => !targetPaths.has(p)).sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b));
  let batch = db.batch(), pending = 0, deleted = 0;
  for (const documentPath of extras) {
    batch.delete(db.doc(documentPath)); pending += 1; deleted += 1;
    if (pending >= 400) { await batch.commit(); batch = db.batch(); pending = 0; }
  }
  if (pending) await batch.commit();
  console.log(`Firestore exact: eliminati ${deleted} documenti non presenti nel backup.`);
  return deleted;
}
async function verifyFirestore(targetDocuments, exactMode) {
  const targetPaths = new Set(targetDocuments.keys());
  let checked = 0;
  const entries = [...targetDocuments.entries()];
  for (let i = 0; i < entries.length; i += 300) {
    const chunk = entries.slice(i, i + 300);
    const snapshots = await db.getAll(...chunk.map(([p]) => db.doc(p)));
    for (let j = 0; j < snapshots.length; j += 1) {
      const [documentPath, expected] = chunk[j], snapshot = snapshots[j];
      if (!snapshot.exists) throw new Error(`Verifica restore: documento assente ${documentPath}`);
      if (canonical(encode(snapshot.data())) !== canonical(expected)) throw new Error(`Verifica restore: contenuto diverso ${documentPath}`);
      checked += 1;
    }
  }
  if (exactMode) {
    const current = await listCurrentDataPaths();
    const missing = [...targetPaths].filter(p => !current.has(p));
    const extra = [...current].filter(p => !targetPaths.has(p));
    if (missing.length || extra.length) throw new Error(`Verifica exact fallita: ${missing.length} mancanti, ${extra.length} extra`);
  }
  console.log(`Verifica Firestore OK: ${checked} documenti riletti${exactMode ? ', insieme documenti esatto' : ''}.`);
}
async function restoreFirestore(targetDocuments) {
  const restored = await writeDocuments(targetDocuments);
  let deleted = 0;
  if (FIRESTORE_MODE === 'exact') deleted = await deleteExtraDocuments(new Set(targetDocuments.keys()));
  if (VERIFY_RESTORE) await verifyFirestore(targetDocuments, FIRESTORE_MODE === 'exact');
  return { restored, deleted };
}

function decryptAuth(root) {
  const envelope = readJson(path.join(root, 'authentication.enc.json'));
  if (envelope.format !== 'riflessa-firebase-auth-aes256gcm-v1') throw new Error('Formato Authentication non valido');
  const hashCfg = normalizedHashConfig(process.env.AUTH_HASH_CONFIG), canonicalCfg = JSON.stringify(hashCfg);
  if (crypto.createHash('sha256').update(canonicalCfg).digest('hex') !== envelope.configFingerprint) throw new Error('FIREBASE_AUTH_HASH_CONFIG non corrisponde al backup');
  const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(canonicalCfg).digest(), Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  const payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
  if (payload.format !== 'riflessa-firebase-auth-v1' || !Array.isArray(payload.users)) throw new Error('Payload Authentication non valido');
  return { payload, hashCfg };
}
function importRecord(u) {
  const out = { uid: u.uid, emailVerified: !!u.emailVerified, disabled: !!u.disabled };
  if (u.email) out.email = u.email; if (u.displayName) out.displayName = u.displayName; if (u.photoURL) out.photoURL = u.photoURL; if (u.phoneNumber) out.phoneNumber = u.phoneNumber; if (u.customClaims) out.customClaims = u.customClaims;
  if (Array.isArray(u.providerData) && u.providerData.length) out.providerData = u.providerData.filter(p => p.providerId && p.uid).map(p => ({ uid: p.uid, displayName: p.displayName || undefined, email: p.email || undefined, photoURL: p.photoURL || undefined, providerId: p.providerId }));
  if (u.passwordHash) out.passwordHash = Buffer.from(u.passwordHash, 'base64'); if (u.passwordSalt) out.passwordSalt = Buffer.from(u.passwordSalt, 'base64');
  return out;
}
function scryptOptions(cfg) {
  if (cfg.algorithm !== 'SCRYPT') throw new Error(`Algoritmo hash non supportato automaticamente: ${cfg.algorithm}`);
  return { algorithm: 'SCRYPT', key: Buffer.from(cfg.base64_signer_key, 'base64'), saltSeparator: Buffer.from(cfg.base64_salt_separator, 'base64'), rounds: cfg.rounds, memoryCost: cfg.mem_cost };
}
async function deleteAllAuthUsers() {
  let total = 0;
  while (true) {
    const page = await auth.listUsers(1000); if (!page.users.length) break;
    for (let i = 0; i < page.users.length; i += 1000) {
      const result = await auth.deleteUsers(page.users.slice(i, i + 1000).map(u => u.uid));
      if (result.failureCount) throw new Error(`Errore eliminazione Authentication: ${result.failureCount} account`); total += result.successCount;
    }
  }
  console.log(`Authentication corrente eliminata: ${total} account.`);
}
async function listAllAuthUsers() {
  const users = []; let pageToken;
  do { const page = await auth.listUsers(1000, pageToken); users.push(...page.users); pageToken = page.pageToken; } while (pageToken);
  return users;
}
async function verifyAuthRestore(root, mode) {
  const { payload } = decryptAuth(root);
  const expected = new Map(payload.users.map(u => [u.uid, u]));
  const current = new Map((await listAllAuthUsers()).map(u => [u.uid, u]));
  for (const [uid, wanted] of expected) {
    const got = current.get(uid); if (!got) throw new Error(`Verifica Auth: account assente ${uid}`);
    if ((got.email || null) !== (wanted.email || null) || !!got.disabled !== !!wanted.disabled || !!got.emailVerified !== !!wanted.emailVerified) throw new Error(`Verifica Auth: dati base diversi per ${uid}`);
    if (canonical(got.customClaims || null) !== canonical(wanted.customClaims || null)) throw new Error(`Verifica Auth: custom claims diversi per ${uid}`);
  }
  if (mode === 'replace' && current.size !== expected.size) throw new Error(`Verifica Auth exact: ${current.size} account correnti contro ${expected.size} nel backup`);
  console.log(`Verifica Authentication OK: ${expected.size} account${mode === 'replace' ? ', insieme account esatto' : ''}.`);
}
async function restoreAuth(root, mode) {
  const { payload, hashCfg } = decryptAuth(root), users = payload.users || [];
  if (!['merge', 'replace'].includes(mode)) throw new Error(`AUTH_MODE non valida: ${mode}`);
  if (mode === 'replace') await deleteAllAuthUsers();
  const existing = new Map();
  if (mode === 'merge') {
    for (let i = 0; i < users.length; i += 100) {
      const result = await auth.getUsers(users.slice(i, i + 100).map(u => ({ uid: u.uid })));
      for (const u of result.users) existing.set(u.uid, u);
    }
  }
  const missing = []; let updated = 0;
  for (const u of users) {
    if (!existing.has(u.uid)) { missing.push(importRecord(u)); continue; }
    const changes = { disabled: !!u.disabled, emailVerified: !!u.emailVerified, displayName: u.displayName || null, photoURL: u.photoURL || null };
    if (u.email) changes.email = u.email; if (u.phoneNumber) changes.phoneNumber = u.phoneNumber;
    await auth.updateUser(u.uid, changes); await auth.setCustomUserClaims(u.uid, u.customClaims || null); updated += 1;
  }
  let imported = 0;
  for (let i = 0; i < missing.length; i += 1000) {
    const chunk = missing.slice(i, i + 1000), hasHashes = chunk.some(u => u.passwordHash);
    const result = await auth.importUsers(chunk, hasHashes ? { hash: scryptOptions(hashCfg) } : undefined);
    if (result.failureCount) throw new Error(`Import Authentication parziale: ${result.failureCount} errori`); imported += result.successCount;
  }
  console.log(`Authentication: ${imported} account importati, ${updated} aggiornati.`);
  if (VERIFY_RESTORE) await verifyAuthRestore(root, mode);
}

async function prepareV3() {
  const manifest = readJson(path.join(backupPathInput, 'manifest.json'));
  if (manifest.format !== 'riflessa-registratore-encrypted-v3' || manifest.projectId !== BACKUP_PROJECT_ID) throw new Error('Manifest backup v3 non valido');
  const encrypted = path.join(backupPathInput, manifest.archive.file || 'backup.enc');
  if (sha256File(encrypted) !== manifest.archive.cipherSha256) throw new Error('Hash archivio cifrato non valido');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'riflessa-restore-'));
  const archive = path.join(temp, 'payload.tar.gz');
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey('riflessa-full-backup-v3'), Buffer.from(manifest.archive.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(manifest.archive.authTag, 'base64'));
  await pipeline(fs.createReadStream(encrypted), decipher, fs.createWriteStream(archive));
  if (sha256File(archive) !== manifest.archive.plainSha256) throw new Error('Hash archivio decifrato non valido');
  const tar = spawnSync('tar', ['-xzf', archive, '-C', temp], { stdio: 'inherit' });
  if (tar.status !== 0) throw new Error('Estrazione backup v3 non riuscita');
  return { root: path.join(temp, 'payload'), temp };
}
function reconstructHosting(root) {
  if (!RESTORE_HOSTING_DIR) return;
  fs.rmSync(RESTORE_HOSTING_DIR, { recursive: true, force: true });
  fs.mkdirSync(RESTORE_HOSTING_DIR, { recursive: true });
  for (const rel of ['hosting', 'app-config']) fs.cpSync(path.join(root, rel), path.join(RESTORE_HOSTING_DIR, rel), { recursive: true });
  for (const rel of ['hosting-manifest.json', 'SOURCE_COMMIT.txt', 'BACKUP_INFO.txt']) fs.copyFileSync(path.join(root, rel), path.join(RESTORE_HOSTING_DIR, rel));
  const expected = readJson(path.join(root, 'hosting-manifest.json'));
  const actual = hashTree(path.join(RESTORE_HOSTING_DIR, 'hosting'));
  if (expected.sha256 !== actual.sha256 || Number(expected.fileCount) !== actual.fileCount) throw new Error('Ricostruzione Hosting non coerente');
  console.log(`Hosting ricostruito e verificato in ${RESTORE_HOSTING_DIR}: ${actual.fileCount} file.`);
}

async function main() {
  let root = backupPathInput, format = requestedFormat, temp = null;
  try {
    if (format === 'v3') { const prepared = await prepareV3(); root = prepared.root; temp = prepared.temp; }
    if (format === 'v1') {
      const old = readJson(path.join(root, 'firestore.json'));
      const target = new Map((old.documents || []).filter(x => x?.path && !PRESERVE_ROOTS.has(rootOf(x.path))).map(x => [x.path, x.data]));
      const result = await restoreFirestore(target);
      console.log(`Ripristinati ${result.restored} documenti Firestore${FIRESTORE_MODE === 'exact' ? `; eliminati ${result.deleted} extra` : ''}.`);
      console.log('Backup v1: Authentication non disponibile.'); return;
    }
    if (format === 'v2') {
      const snapshot = readSnapshotDir(path.join(root, 'firestore'));
      const result = await restoreFirestore(snapshot.documents);
      console.log(`Ripristinati ${result.restored} documenti Firestore${FIRESTORE_MODE === 'exact' ? `; eliminati ${result.deleted} extra` : ''}.`);
      await restoreAuth(root, process.env.AUTH_MODE || 'merge'); return;
    }
    if (format === 'v3') {
      const payload = readJson(path.join(root, 'manifest.json'));
      if (payload.format !== 'riflessa-registratore-payload-v3' || payload.projectId !== BACKUP_PROJECT_ID) throw new Error('Payload v3 non valido');
      const core = readSnapshotDir(path.join(root, 'firestore'));
      const logs = readSnapshotDir(path.join(root, 'logs'));
      const target = new Map([...core.documents, ...logs.documents]);
      const result = await restoreFirestore(target);
      console.log(`Ripristinati ${core.documents.size} documenti Firestore core e ${logs.documents.size} documenti log${FIRESTORE_MODE === 'exact' ? `; eliminati ${result.deleted} extra` : ''}.`);
      await restoreAuth(root, process.env.AUTH_MODE || 'merge');
      reconstructHosting(root);
      console.log(`Snapshot Hosting incluso nel backup (${payload.hosting?.fileCount || 0} file).`);
      return;
    }
    throw new Error(`Formato backup non supportato: ${format}`);
  } finally { if (temp) fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exit(1); });
