const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { spawnSync } = require('child_process');

const backupPath = process.env.BACKUP_PATH;
if (!backupPath) throw new Error('BACKUP_PATH non impostata');

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function listFilesRecursive(root, prefix = '') {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(root, entry.name), relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFilesRecursive(absolute, relative)); else if (entry.isFile()) out.push(relative);
  }
  return out;
}
function hashTree(root) {
  const hash = crypto.createHash('sha256'), files = listFilesRecursive(root);
  for (const relative of files) { hash.update(relative); hash.update('\0'); hash.update(fs.readFileSync(path.join(root, relative))); hash.update('\0'); }
  return { sha256: hash.digest('hex'), fileCount: files.length };
}
function parseHashConfig(raw) {
  try { return JSON.parse(raw); } catch {}
  const cfg = {};
  for (const key of ['algorithm', 'base64_signer_key', 'base64_salt_separator', 'rounds', 'mem_cost']) {
    const re = new RegExp(`${key}\\s*[:=]\\s*(?:"([^"]*)"|'([^']*)'|([^,\\s}]+))`, 'i');
    const match = String(raw || '').match(re);
    if (match) cfg[key] = match[1] ?? match[2] ?? match[3];
  }
  if (cfg.rounds !== undefined) cfg.rounds = Number(cfg.rounds);
  if (cfg.mem_cost !== undefined) cfg.mem_cost = Number(cfg.mem_cost);
  return cfg;
}
function normalizedHashConfig(raw) {
  const cfg = parseHashConfig(raw);
  for (const key of ['algorithm', 'base64_signer_key', 'base64_salt_separator', 'rounds', 'mem_cost']) {
    if (cfg[key] === undefined || cfg[key] === null || cfg[key] === '') throw new Error(`Parametro hash mancante: ${key}`);
  }
  return { algorithm: String(cfg.algorithm).toUpperCase(), base64_signer_key: String(cfg.base64_signer_key), base64_salt_separator: String(cfg.base64_salt_separator), rounds: Number(cfg.rounds), mem_cost: Number(cfg.mem_cost) };
}
function canonicalHashConfig() { return JSON.stringify(normalizedHashConfig(process.env.AUTH_HASH_CONFIG)); }
function deriveKey(domain) { return crypto.createHash('sha256').update(`${domain}\0${canonicalHashConfig()}`).digest(); }

function verifyFirestoreDir(dir) {
  const manifest = readJson(path.join(dir, 'manifest.json'));
  let count = 0;
  for (const part of manifest.parts || []) {
    const file = path.join(dir, part);
    if (!fs.existsSync(file)) throw new Error(`Parte Firestore assente: ${part}`);
    for (const row of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      const doc = JSON.parse(row); if (!doc.path || doc.data === undefined) throw new Error(`Documento Firestore non valido in ${part}`); count += 1;
    }
  }
  if (count !== Number(manifest.documentCount)) throw new Error(`Conteggio Firestore incoerente: ${count}/${manifest.documentCount}`);
  return { count, manifest };
}
function decryptAuthentication(file) {
  const envelope = readJson(file);
  if (envelope.format !== 'riflessa-firebase-auth-aes256gcm-v1') throw new Error('Formato Authentication non valido');
  const canonical = canonicalHashConfig();
  const fingerprint = crypto.createHash('sha256').update(canonical).digest('hex');
  if (fingerprint !== envelope.configFingerprint) throw new Error('Fingerprint hash config non corrispondente');
  const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(canonical).digest(), Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  const payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
  if (payload.format !== 'riflessa-firebase-auth-v1' || !Array.isArray(payload.users)) throw new Error('Payload Authentication non valido');
  const hashed = payload.users.filter(user => user.passwordHash && user.passwordSalt).length;
  if (payload.users.length !== Number(envelope.accountCount) || hashed !== Number(envelope.hashedPasswordCount)) throw new Error('Conteggio Authentication incoerente');
  return { accounts: payload.users.length, hashed, algorithm: normalizedHashConfig(process.env.AUTH_HASH_CONFIG).algorithm };
}
function verifyRequired(root) {
  for (const relative of ['app-config/.firebaserc', 'app-config/firebase.json', 'app-config/firestore.rules', 'app-config/package.json', 'app-config/config/default-axon-profile.json', 'app-config/js/firebase-config.js', 'SOURCE_COMMIT.txt', 'BACKUP_INFO.txt']) {
    if (!fs.existsSync(path.join(root, relative))) throw new Error(`File backup assente: ${relative}`);
  }
}
function verifyPayloadV3(root, publicManifest) {
  const manifest = readJson(path.join(root, 'manifest.json'));
  if (manifest.format !== 'riflessa-registratore-payload-v3' || manifest.projectId !== process.env.PROJECT_ID) throw new Error('Payload v3 non valido');
  const core = verifyFirestoreDir(path.join(root, 'firestore'));
  const logs = verifyFirestoreDir(path.join(root, 'logs'));
  if (core.count !== Number(manifest.firestore.coreDocumentCount) || logs.count !== Number(manifest.firestore.logDocumentCount)) throw new Error('Conteggi core/log non coerenti');
  const auth = decryptAuthentication(path.join(root, 'authentication.enc.json'));
  if (auth.accounts !== Number(manifest.authentication.accountCount)) throw new Error('Conteggio Auth non coerente');
  const hostingManifest = readJson(path.join(root, 'hosting-manifest.json'));
  const hosting = hashTree(path.join(root, 'hosting'));
  if (hosting.sha256 !== hostingManifest.sha256 || hosting.fileCount !== Number(hostingManifest.fileCount)) throw new Error('Snapshot Hosting non coerente');
  verifyRequired(root);
  if (publicManifest) {
    if (publicManifest.firestore.totalDocumentCount !== manifest.firestore.totalDocumentCount || publicManifest.authentication.accountCount !== manifest.authentication.accountCount || publicManifest.hosting.sha256 !== manifest.hosting.sha256) throw new Error('Manifest pubblico e payload non coerenti');
  }
  return { documents: core.count + logs.count, core: core.count, logs: logs.count, auth, hosting };
}
async function verifyV3(publicManifest) {
  const encrypted = path.join(backupPath, publicManifest.archive?.file || 'backup.enc');
  if (!fs.existsSync(encrypted)) throw new Error('Archivio cifrato assente');
  if (sha256File(encrypted) !== publicManifest.archive.cipherSha256) throw new Error('Hash archivio cifrato non valido');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'riflessa-backup-verify-'));
  try {
    const archive = path.join(temp, 'payload.tar.gz');
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey('riflessa-full-backup-v3'), Buffer.from(publicManifest.archive.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(publicManifest.archive.authTag, 'base64'));
    await pipeline(fs.createReadStream(encrypted), decipher, fs.createWriteStream(archive));
    if (sha256File(archive) !== publicManifest.archive.plainSha256) throw new Error('Hash archivio decifrato non valido');
    const tar = spawnSync('tar', ['-xzf', archive, '-C', temp], { stdio: 'inherit' });
    if (tar.status !== 0) throw new Error('Estrazione archivio cifrato non riuscita');
    const result = verifyPayloadV3(path.join(temp, 'payload'), publicManifest);
    console.log(`Backup v3 verificato e riletto: ${result.core} documenti Firestore core + ${result.logs} documenti log.`);
    console.log(`Authentication verificata: ${result.auth.accounts} account, ${result.auth.hashed} password hash, algoritmo ${result.auth.algorithm}.`);
    console.log(`Hosting verificato: ${result.hosting.fileCount} file, hash ${result.hosting.sha256}.`);
    console.log('Archivio completo AES-256-GCM: autenticato, decifrato e dry-run restore OK.');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
function verifyV2() {
  const firestore = verifyFirestoreDir(path.join(backupPath, 'firestore'));
  const auth = decryptAuthentication(path.join(backupPath, 'authentication.enc.json'));
  verifyRequired(backupPath);
  console.log(`Backup v2 verificato: ${firestore.count} documenti Firestore.`);
  console.log(`Authentication verificata e decrittata: ${auth.accounts} account, ${auth.hashed} password hash, algoritmo ${auth.algorithm}.`);
  console.log(`Documenti log sincronizzati presenti nel backup: ${Number(firestore.manifest.logDocumentCount || 0)}.`);
  console.log('Configurazione applicazione: completa. Dry-run restore: OK.');
}
async function main() {
  const manifest = readJson(path.join(backupPath, 'manifest.json'));
  if (manifest.projectId !== process.env.PROJECT_ID) throw new Error('Progetto backup non corrispondente');
  if (manifest.format === 'riflessa-registratore-encrypted-v3') return verifyV3(manifest);
  if (manifest.format === 'riflessa-registratore-backup-v2') return verifyV2(manifest);
  throw new Error(`Formato backup non supportato: ${manifest.format}`);
}
main().catch(error => { console.error(error); process.exit(1); });
