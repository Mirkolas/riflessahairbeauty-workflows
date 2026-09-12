const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');

const OUTPUT_DIR = process.env.OUTPUT_DIR;
const PART_LIMIT = 15 * 1024 * 1024;
if (!OUTPUT_DIR) throw new Error('OUTPUT_DIR non impostata');

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(path.join(OUTPUT_DIR, 'firestore'), { recursive: true });

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
    if (cfg[key] === undefined || cfg[key] === null || cfg[key] === '') {
      throw new Error(`Parametro hash mancante: ${key}`);
    }
  }
  return {
    algorithm: String(cfg.algorithm).toUpperCase(),
    base64_signer_key: String(cfg.base64_signer_key),
    base64_salt_separator: String(cfg.base64_salt_separator),
    rounds: Number(cfg.rounds),
    mem_cost: Number(cfg.mem_cost)
  };
}

const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
admin.initializeApp({
  credential: admin.credential.cert(credentials),
  projectId: process.env.PROJECT_ID
});
const db = admin.firestore();

function encode(value) {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof admin.firestore.Timestamp) {
    return { __firestoreType: 'timestamp', seconds: value.seconds, nanoseconds: value.nanoseconds };
  }
  if (value instanceof admin.firestore.GeoPoint) {
    return { __firestoreType: 'geopoint', latitude: value.latitude, longitude: value.longitude };
  }
  if (value instanceof admin.firestore.DocumentReference) {
    return { __firestoreType: 'reference', path: value.path };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { __firestoreType: 'bytes', base64: Buffer.from(value).toString('base64') };
  }
  if (Array.isArray(value)) return value.map(encode);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = encode(child);
    return out;
  }
  return value;
}

let partNo = 1;
let partBytes = 0;
let partLines = [];
let documentCount = 0;
let logDocumentCount = 0;
const rootCollections = new Set();
const partFiles = [];

function flushPart() {
  if (!partLines.length) return;
  const name = `part-${String(partNo).padStart(4, '0')}.jsonl`;
  fs.writeFileSync(path.join(OUTPUT_DIR, 'firestore', name), partLines.join(''), 'utf8');
  partFiles.push(name);
  partNo += 1;
  partBytes = 0;
  partLines = [];
}

function appendDocument(item) {
  const line = JSON.stringify(item) + '\n';
  const bytes = Buffer.byteLength(line);
  if (partLines.length && partBytes + bytes > PART_LIMIT) flushPart();
  partLines.push(line);
  partBytes += bytes;
  documentCount += 1;
  const root = item.path.split('/')[0];
  rootCollections.add(root);
  if (root === 'registratoreLogFiles') logDocumentCount += 1;
}

async function walkCollection(collectionRef) {
  const snapshot = await collectionRef.get();
  for (const document of snapshot.docs) {
    appendDocument({ path: document.ref.path, data: encode(document.data()) });
    const subcollections = await document.ref.listCollections();
    for (const subcollection of subcollections) await walkCollection(subcollection);
  }
}

function serializeUser(user) {
  return {
    uid: user.uid,
    email: user.email || null,
    emailVerified: !!user.emailVerified,
    displayName: user.displayName || null,
    photoURL: user.photoURL || null,
    phoneNumber: user.phoneNumber || null,
    disabled: !!user.disabled,
    customClaims: user.customClaims || null,
    tenantId: user.tenantId || null,
    providerData: (user.providerData || []).map(provider => ({
      uid: provider.uid || null,
      displayName: provider.displayName || null,
      email: provider.email || null,
      photoURL: provider.photoURL || null,
      providerId: provider.providerId || null,
      phoneNumber: provider.phoneNumber || null
    })),
    metadata: {
      creationTime: user.metadata?.creationTime || null,
      lastSignInTime: user.metadata?.lastSignInTime || null,
      lastRefreshTime: user.metadata?.lastRefreshTime || null
    },
    passwordHash: user.passwordHash ? Buffer.from(user.passwordHash).toString('base64') : null,
    passwordSalt: user.passwordSalt ? Buffer.from(user.passwordSalt).toString('base64') : null,
    tokensValidAfterTime: user.tokensValidAfterTime || null
  };
}

function encryptAuthentication(payload, hashConfig) {
  const canonical = JSON.stringify(hashConfig);
  const key = crypto.createHash('sha256').update(canonical).digest();
  const fingerprint = crypto.createHash('sha256').update(canonical).digest('hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    format: 'riflessa-firebase-auth-aes256gcm-v1',
    configFingerprint: fingerprint,
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    accountCount: payload.users.length,
    hashedPasswordCount: payload.users.filter(user => user.passwordHash && user.passwordSalt).length
  };
}

async function exportAuthentication() {
  const users = [];
  let pageToken;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    users.push(...page.users.map(serializeUser));
    pageToken = page.pageToken;
  } while (pageToken);

  const payload = {
    format: 'riflessa-firebase-auth-v1',
    projectId: process.env.PROJECT_ID,
    createdAt: new Date().toISOString(),
    users
  };
  const hashConfig = normalizedHashConfig(process.env.AUTH_HASH_CONFIG);
  const encrypted = encryptAuthentication(payload, hashConfig);
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'authentication.enc.json'),
    JSON.stringify(encrypted, null, 2) + '\n'
  );
  return {
    accountCount: users.length,
    hashedPasswordCount: encrypted.hashedPasswordCount,
    hashAlgorithm: hashConfig.algorithm
  };
}

async function main() {
  const roots = await db.listCollections();
  for (const collection of roots) await walkCollection(collection);
  flushPart();

  const firestoreManifest = {
    format: 'riflessa-firestore-jsonl-v2',
    projectId: process.env.PROJECT_ID,
    databaseId: '(default)',
    createdAt: new Date().toISOString(),
    documentCount,
    logDocumentCount,
    rootCollections: [...rootCollections].sort(),
    parts: partFiles
  };
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'firestore', 'manifest.json'),
    JSON.stringify(firestoreManifest, null, 2) + '\n'
  );

  const authentication = await exportAuthentication();
  const overall = {
    format: 'riflessa-registratore-backup-v2',
    projectId: process.env.PROJECT_ID,
    createdAt: new Date().toISOString(),
    sourceCommit: process.env.SOURCE_COMMIT || null,
    firestore: firestoreManifest,
    authentication
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'manifest.json'), JSON.stringify(overall, null, 2) + '\n');

  console.log(`Firestore: ${documentCount} documenti (${logDocumentCount} documenti log).`);
  console.log(`Authentication: ${authentication.accountCount} account (${authentication.hashedPasswordCount} con hash password).`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
