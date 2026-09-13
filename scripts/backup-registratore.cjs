const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');

const OUTPUT_DIR = process.env.OUTPUT_DIR;
const PREVIOUS_BACKUP_DIR = process.env.PREVIOUS_BACKUP_DIR || '';
const PREVIOUS_BACKUP_NAME = process.env.PREVIOUS_BACKUP_NAME || null;
const PART_LIMIT = 15 * 1024 * 1024;
const JOURNAL_COLLECTION = '_backupChanges';
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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readPreviousSnapshot(previousDir) {
  const overallFile = path.join(previousDir, 'manifest.json');
  const firestoreDir = path.join(previousDir, 'firestore');
  const manifestFile = path.join(firestoreDir, 'manifest.json');
  if (!fs.existsSync(overallFile) || !fs.existsSync(manifestFile)) {
    throw new Error('Backup precedente privo dei manifest v2');
  }

  const overall = readJson(overallFile);
  const manifest = readJson(manifestFile);
  if (overall.format !== 'riflessa-registratore-backup-v2' || manifest.format !== 'riflessa-firestore-jsonl-v2') {
    throw new Error('Formato backup precedente non compatibile');
  }
  if (manifest.projectId && manifest.projectId !== process.env.PROJECT_ID) {
    throw new Error('Backup precedente relativo a un progetto Firebase diverso');
  }
  if (!manifest.journalCursor) {
    throw new Error('Backup precedente senza journalCursor: serve una nuova base completa');
  }

  const documents = new Map();
  for (const part of manifest.parts || []) {
    const file = path.join(firestoreDir, part);
    if (!fs.existsSync(file)) throw new Error(`Parte precedente assente: ${part}`);
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (const row of rows) {
      const item = JSON.parse(row);
      if (!item.path || item.data === undefined) throw new Error(`Documento non valido in ${part}`);
      if (item.path.split('/')[0] === JOURNAL_COLLECTION) continue;
      documents.set(item.path, item.data);
    }
  }
  if (documents.size !== Number(manifest.documentCount || 0)) {
    throw new Error(`Snapshot precedente incoerente: ${documents.size}/${manifest.documentCount}`);
  }
  return { documents, manifest };
}

async function walkCollectionIntoMap(collectionRef, documents) {
  const snapshot = await collectionRef.get();
  for (const document of snapshot.docs) {
    documents.set(document.ref.path, encode(document.data()));
    const subcollections = await document.ref.listCollections();
    for (const subcollection of subcollections) {
      await walkCollectionIntoMap(subcollection, documents);
    }
  }
}

async function fullSnapshot() {
  const documents = new Map();
  const roots = await db.listCollections();
  for (const collection of roots) {
    if (collection.id === JOURNAL_COLLECTION) continue;
    await walkCollectionIntoMap(collection, documents);
  }
  return {
    documents,
    backupMode: 'full',
    baseBackup: null,
    journalDocumentsRead: 0,
    changedPaths: documents.size,
    changedDocuments: documents.size,
    deletedDocuments: 0
  };
}

function cursorTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`journalCursor non valido: ${value}`);
  return admin.firestore.Timestamp.fromDate(date);
}

async function incrementalSnapshot(previous, boundary) {
  const from = cursorTimestamp(previous.manifest.journalCursor);
  const journal = await db.collection(JOURNAL_COLLECTION)
    .where('changedAt', '>', from)
    .where('changedAt', '<=', boundary)
    .orderBy('changedAt', 'asc')
    .get();

  const latestChanges = new Map();
  for (const journalDocument of journal.docs) {
    const data = journalDocument.data() || {};
    if (Number(data.schemaVersion || 0) !== 1 || !Array.isArray(data.changes)) {
      throw new Error(`Journal non valido: ${journalDocument.ref.path}`);
    }
    for (const change of data.changes) {
      const documentPath = String(change?.path || '');
      if (!documentPath || documentPath.split('/')[0] === JOURNAL_COLLECTION) continue;
      latestChanges.set(documentPath, String(change.operation || 'update'));
    }
  }

  const documents = new Map(previous.documents);
  const changedPaths = [...latestChanges.keys()].sort();
  let changedDocuments = 0;
  let deletedDocuments = 0;

  for (let i = 0; i < changedPaths.length; i += 300) {
    const chunk = changedPaths.slice(i, i + 300);
    const snapshots = await db.getAll(...chunk.map(documentPath => db.doc(documentPath)));
    for (let j = 0; j < snapshots.length; j += 1) {
      const snapshot = snapshots[j];
      const documentPath = chunk[j];
      if (snapshot.exists) {
        documents.set(documentPath, encode(snapshot.data()));
        changedDocuments += 1;
      } else {
        if (documents.delete(documentPath)) deletedDocuments += 1;
      }
    }
  }

  return {
    documents,
    backupMode: 'incremental',
    baseBackup: PREVIOUS_BACKUP_NAME,
    journalDocumentsRead: journal.size,
    changedPaths: changedPaths.length,
    changedDocuments,
    deletedDocuments
  };
}

function writeSnapshot(documents) {
  let partNo = 1;
  let partBytes = 0;
  let partLines = [];
  const partFiles = [];
  const rootCollections = new Set();
  let logDocumentCount = 0;

  function flushPart() {
    if (!partLines.length) return;
    const name = `part-${String(partNo).padStart(4, '0')}.jsonl`;
    fs.writeFileSync(path.join(OUTPUT_DIR, 'firestore', name), partLines.join(''), 'utf8');
    partFiles.push(name);
    partNo += 1;
    partBytes = 0;
    partLines = [];
  }

  for (const documentPath of [...documents.keys()].sort()) {
    const root = documentPath.split('/')[0];
    if (root === JOURNAL_COLLECTION) continue;
    const line = JSON.stringify({ path: documentPath, data: documents.get(documentPath) }) + '\n';
    const bytes = Buffer.byteLength(line);
    if (partLines.length && partBytes + bytes > PART_LIMIT) flushPart();
    partLines.push(line);
    partBytes += bytes;
    rootCollections.add(root);
    if (root === 'registratoreLogFiles') logDocumentCount += 1;
  }
  flushPart();

  return {
    partFiles,
    rootCollections: [...rootCollections].sort(),
    logDocumentCount
  };
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
  const boundary = admin.firestore.Timestamp.now();
  let result;

  if (PREVIOUS_BACKUP_DIR) {
    try {
      const previous = readPreviousSnapshot(PREVIOUS_BACKUP_DIR);
      result = await incrementalSnapshot(previous, boundary);
      console.log(`Backup incrementale da ${PREVIOUS_BACKUP_NAME || PREVIOUS_BACKUP_DIR}: ${result.journalDocumentsRead} record journal, ${result.changedPaths} path unici.`);
    } catch (error) {
      console.warn(`Incrementale non utilizzabile (${error.message || error}). Eseguo fallback completo.`);
      result = await fullSnapshot();
    }
  } else {
    console.log('Nessun backup precedente disponibile: creo una nuova base completa.');
    result = await fullSnapshot();
  }

  const written = writeSnapshot(result.documents);
  const createdAt = new Date().toISOString();
  const firestoreManifest = {
    format: 'riflessa-firestore-jsonl-v2',
    projectId: process.env.PROJECT_ID,
    databaseId: '(default)',
    createdAt,
    backupMode: result.backupMode,
    baseBackup: result.baseBackup,
    journalCursor: boundary.toDate().toISOString(),
    journalDocumentsRead: result.journalDocumentsRead,
    changedPaths: result.changedPaths,
    changedDocuments: result.changedDocuments,
    deletedDocuments: result.deletedDocuments,
    documentCount: result.documents.size,
    logDocumentCount: written.logDocumentCount,
    rootCollections: written.rootCollections,
    parts: written.partFiles
  };
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'firestore', 'manifest.json'),
    JSON.stringify(firestoreManifest, null, 2) + '\n'
  );

  const authentication = await exportAuthentication();
  const overall = {
    format: 'riflessa-registratore-backup-v2',
    projectId: process.env.PROJECT_ID,
    createdAt,
    sourceCommit: process.env.SOURCE_COMMIT || null,
    firestore: firestoreManifest,
    authentication
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'manifest.json'), JSON.stringify(overall, null, 2) + '\n');

  console.log(`Firestore: ${result.documents.size} documenti finali (${written.logDocumentCount} documenti log), modalita ${result.backupMode}.`);
  if (result.backupMode === 'incremental') {
    console.log(`Incrementale: ${result.journalDocumentsRead} letture journal + ${result.changedPaths} documenti modificati da verificare.`);
  }
  console.log(`Authentication: ${authentication.accountCount} account (${authentication.hashedPasswordCount} con hash password).`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
