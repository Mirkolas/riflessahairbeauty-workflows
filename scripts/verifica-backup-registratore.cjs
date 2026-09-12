const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const backupPath = process.env.BACKUP_PATH;
if (!backupPath) throw new Error('BACKUP_PATH non impostata');

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
  return {
    algorithm: String(cfg.algorithm).toUpperCase(),
    base64_signer_key: String(cfg.base64_signer_key),
    base64_salt_separator: String(cfg.base64_salt_separator),
    rounds: Number(cfg.rounds),
    mem_cost: Number(cfg.mem_cost)
  };
}

function verifyFirestore(manifest) {
  let count = 0;
  for (const part of manifest.parts || []) {
    const file = path.join(backupPath, 'firestore', part);
    if (!fs.existsSync(file)) throw new Error(`Parte Firestore assente: ${part}`);
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (const row of rows) {
      const doc = JSON.parse(row);
      if (!doc.path || doc.data === undefined) throw new Error(`Documento Firestore non valido in ${part}`);
      count += 1;
    }
  }
  if (count !== Number(manifest.documentCount)) {
    throw new Error(`Conteggio Firestore incoerente: ${count}/${manifest.documentCount}`);
  }
  return count;
}

function decryptAuthentication() {
  const envelope = JSON.parse(fs.readFileSync(path.join(backupPath, 'authentication.enc.json'), 'utf8'));
  if (envelope.format !== 'riflessa-firebase-auth-aes256gcm-v1') throw new Error('Formato Authentication non valido');
  const cfg = normalizedHashConfig(process.env.AUTH_HASH_CONFIG);
  const canonical = JSON.stringify(cfg);
  const fingerprint = crypto.createHash('sha256').update(canonical).digest('hex');
  if (fingerprint !== envelope.configFingerprint) throw new Error('Fingerprint hash config non corrispondente');
  const key = crypto.createHash('sha256').update(canonical).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final()
  ]);
  const payload = JSON.parse(plaintext.toString('utf8'));
  if (payload.format !== 'riflessa-firebase-auth-v1') throw new Error('Payload Authentication non valido');
  if (!Array.isArray(payload.users)) throw new Error('Elenco utenti Authentication non valido');
  const hashed = payload.users.filter(user => user.passwordHash && user.passwordSalt).length;
  if (payload.users.length !== Number(envelope.accountCount)) throw new Error('Conteggio account Authentication incoerente');
  if (hashed !== Number(envelope.hashedPasswordCount)) throw new Error('Conteggio password hash incoerente');
  return { accounts: payload.users.length, hashed, algorithm: cfg.algorithm };
}

const manifest = JSON.parse(fs.readFileSync(path.join(backupPath, 'manifest.json'), 'utf8'));
if (manifest.format !== 'riflessa-registratore-backup-v2') throw new Error('Manifest backup non valido');
if (manifest.projectId !== process.env.PROJECT_ID) throw new Error('Progetto backup non corrispondente');
const firestoreManifest = JSON.parse(fs.readFileSync(path.join(backupPath, 'firestore', 'manifest.json'), 'utf8'));
const documents = verifyFirestore(firestoreManifest);
const auth = decryptAuthentication();

for (const relative of [
  'app-config/.firebaserc',
  'app-config/firebase.json',
  'app-config/firestore.rules',
  'app-config/package.json',
  'app-config/config/default-axon-profile.json',
  'app-config/js/firebase-config.js',
  'SOURCE_COMMIT.txt',
  'BACKUP_INFO.txt'
]) {
  if (!fs.existsSync(path.join(backupPath, relative))) throw new Error(`File backup assente: ${relative}`);
}

console.log(`Backup verificato: ${documents} documenti Firestore.`);
console.log(`Authentication verificata e decrittata: ${auth.accounts} account, ${auth.hashed} password hash, algoritmo ${auth.algorithm}.`);
console.log(`Documenti log sincronizzati presenti nel backup: ${Number(firestoreManifest.logDocumentCount || 0)}.`);
console.log('Configurazione applicazione: completa. Dry-run restore: OK.');
