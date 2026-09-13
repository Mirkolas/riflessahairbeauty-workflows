const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { spawnSync } = require('child_process');
const admin = require('firebase-admin');

const backupPathInput = process.env.BACKUP_PATH;
const requestedFormat = process.env.BACKUP_FORMAT || '';
if (!backupPathInput) throw new Error('BACKUP_PATH non impostata');

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

const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
admin.initializeApp({ credential: admin.credential.cert(credentials), projectId: process.env.PROJECT_ID });
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
async function writeDocuments(documents) {
  let batch = db.batch(), pending = 0, restored = 0;
  for (const item of documents) {
    if (!item.path || item.data === undefined) throw new Error('Documento Firestore non valido');
    batch.set(db.doc(item.path), decode(item.data), { merge: false }); pending += 1; restored += 1;
    if (pending >= 400) { await batch.commit(); batch = db.batch(); pending = 0; }
  }
  if (pending) await batch.commit();
  return restored;
}
async function restoreSnapshotDir(dir) {
  const manifest = readJson(path.join(dir, 'manifest.json'));
  let restored = 0;
  for (const part of manifest.parts || []) {
    const docs = fs.readFileSync(path.join(dir, part), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    restored += await writeDocuments(docs);
  }
  if (restored !== Number(manifest.documentCount)) throw new Error(`Conteggio Firestore incoerente: ${restored}/${manifest.documentCount}`);
  return restored;
}
function decryptAuth(root) {
  const envelope = readJson(path.join(root, 'authentication.enc.json'));
  if (envelope.format !== 'riflessa-firebase-auth-aes256gcm-v1') throw new Error('Formato Authentication non valido');
  const hashCfg = normalizedHashConfig(process.env.AUTH_HASH_CONFIG), canonical = JSON.stringify(hashCfg);
  if (crypto.createHash('sha256').update(canonical).digest('hex') !== envelope.configFingerprint) throw new Error('FIREBASE_AUTH_HASH_CONFIG non corrisponde al backup');
  const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(canonical).digest(), Buffer.from(envelope.iv, 'base64'));
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
async function restoreAuth(root, mode) {
  const { payload, hashCfg } = decryptAuth(root), users = payload.users || [];
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
}
async function prepareV3() {
  const manifest = readJson(path.join(backupPathInput, 'manifest.json'));
  if (manifest.format !== 'riflessa-registratore-encrypted-v3' || manifest.projectId !== process.env.PROJECT_ID) throw new Error('Manifest backup v3 non valido');
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
async function main() {
  let root = backupPathInput, format = requestedFormat, temp = null;
  try {
    if (format === 'v3') { const prepared = await prepareV3(); root = prepared.root; temp = prepared.temp; }
    if (format === 'v1') {
      const old = readJson(path.join(root, 'firestore.json'));
      const restored = await writeDocuments(old.documents || []); console.log(`Ripristinati ${restored} documenti Firestore.`); console.log('Backup v1: Authentication non disponibile.'); return;
    }
    if (format === 'v2') {
      const restored = await restoreSnapshotDir(path.join(root, 'firestore')); console.log(`Ripristinati ${restored} documenti Firestore.`); await restoreAuth(root, process.env.AUTH_MODE || 'merge'); return;
    }
    if (format === 'v3') {
      const payload = readJson(path.join(root, 'manifest.json'));
      if (payload.format !== 'riflessa-registratore-payload-v3' || payload.projectId !== process.env.PROJECT_ID) throw new Error('Payload v3 non valido');
      const core = await restoreSnapshotDir(path.join(root, 'firestore'));
      const logs = await restoreSnapshotDir(path.join(root, 'logs'));
      console.log(`Ripristinati ${core} documenti Firestore core e ${logs} documenti log.`);
      await restoreAuth(root, process.env.AUTH_MODE || 'merge');
      console.log(`Snapshot Hosting incluso nel backup (${payload.hosting?.fileCount || 0} file); il restore dati non esegue deploy Hosting automatico.`);
      return;
    }
    throw new Error(`Formato backup non supportato: ${format}`);
  } finally { if (temp) fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exit(1); });
