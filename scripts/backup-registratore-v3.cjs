const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { spawnSync } = require('child_process');
const admin = require('firebase-admin');

const CHECKPOINT_DIR = process.env.CHECKPOINT_DIR;
const FINAL_DIR = process.env.FINAL_DIR;
const PREVIOUS_BACKUP_DIR = process.env.PREVIOUS_BACKUP_DIR || '';
const PREVIOUS_BACKUP_NAME = process.env.PREVIOUS_BACKUP_NAME || null;
const SOURCE_APP_DIR = process.env.SOURCE_APP_DIR;
const SOURCE_COMMIT = process.env.SOURCE_COMMIT || null;
const BACKUP_NAME = process.env.BACKUP_NAME;
const PROJECT_ID = process.env.PROJECT_ID;
const AUTH_HASH_CONFIG = process.env.AUTH_HASH_CONFIG;
const ATTEMPT = Number(process.env.ATTEMPT || 1);
const BACKUP_REPO_DIR = process.env.BACKUP_REPO_DIR || process.cwd();
const PERSISTENT_CHECKPOINT_DIR = process.env.PERSISTENT_CHECKPOINT_DIR || '';
const TEST_STOP_AFTER_PHASE = String(process.env.TEST_STOP_AFTER_PHASE || '').trim();
const ALLOW_TEST_FAILPOINTS = String(process.env.ALLOW_TEST_FAILPOINTS || '') === '1';
const JOURNAL_COLLECTION = '_backupChanges';
const LOG_ROOT = 'registratoreLogFiles';
const PART_LIMIT = 15 * 1024 * 1024;

for (const [key, value] of Object.entries({ CHECKPOINT_DIR, FINAL_DIR, SOURCE_APP_DIR, BACKUP_NAME, PROJECT_ID, AUTH_HASH_CONFIG })) {
  if (!value) throw new Error(`${key} non impostata`);
}

const PAYLOAD_DIR = path.join(CHECKPOINT_DIR, 'payload');
const STATE_FILE = path.join(CHECKPOINT_DIR, 'checkpoint.json');
const CORE_DIR = path.join(PAYLOAD_DIR, 'firestore');
const LOG_DIR = path.join(PAYLOAD_DIR, 'logs');
const AUTH_FILE = path.join(PAYLOAD_DIR, 'authentication.enc.json');
const HOSTING_DIR = path.join(PAYLOAD_DIR, 'hosting');
const APP_CONFIG_DIR = path.join(PAYLOAD_DIR, 'app-config');
const LOG_CHANGES_FILE = path.join(CHECKPOINT_DIR, 'log-changes.json');
const PHASE_PATHS = {
  firestore: ['payload/firestore', 'log-changes.json'],
  auth: ['payload/authentication.enc.json'],
  hosting: ['payload/hosting', 'payload/app-config', 'payload/hosting-manifest.json'],
  logs: ['payload/logs']
};

fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
fs.mkdirSync(PAYLOAD_DIR, { recursive: true });

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
function sha256Buffer(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
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
function removeAndCreate(dir) { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); }
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} fallito: ${(result.stderr || result.stdout || '').trim()}`);
  return result;
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
  return {
    algorithm: String(cfg.algorithm).toUpperCase(), base64_signer_key: String(cfg.base64_signer_key),
    base64_salt_separator: String(cfg.base64_salt_separator), rounds: Number(cfg.rounds), mem_cost: Number(cfg.mem_cost)
  };
}
function authCanonical() { return JSON.stringify(normalizedHashConfig(AUTH_HASH_CONFIG)); }
function deriveKey(domain) { return crypto.createHash('sha256').update(`${domain}\0${authCanonical()}`).digest(); }
function encryptJson(value, domain) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(domain), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), 'utf8')), cipher.final()]);
  return { format: 'riflessa-checkpoint-json-aes256gcm-v1', iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
function decryptJson(envelope, domain) {
  if (envelope.format !== 'riflessa-checkpoint-json-aes256gcm-v1') throw new Error('Envelope checkpoint non valido');
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(domain), Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
}
async function encryptFileWithDomain(input, output, domain) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(domain), iv);
  await pipeline(fs.createReadStream(input), cipher, fs.createWriteStream(output));
  return { iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), plainSha256: sha256File(input), cipherSha256: sha256File(output), bytes: fs.statSync(output).size };
}
async function decryptFileWithDomain(input, output, meta, domain) {
  if (sha256File(input) !== meta.cipherSha256) throw new Error(`Hash checkpoint cifrato non valido: ${path.basename(input)}`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(domain), Buffer.from(meta.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(meta.authTag, 'base64'));
  await pipeline(fs.createReadStream(input), decipher, fs.createWriteStream(output));
  if (sha256File(output) !== meta.plainSha256) throw new Error(`Hash checkpoint decifrato non valido: ${path.basename(input)}`);
}

function persistentEnabled() { return Boolean(PERSISTENT_CHECKPOINT_DIR); }
function checkpointRelativePath() {
  const rel = path.relative(BACKUP_REPO_DIR, PERSISTENT_CHECKPOINT_DIR).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..')) throw new Error('PERSISTENT_CHECKPOINT_DIR deve essere dentro BACKUP_REPO_DIR');
  return rel;
}
async function persistCheckpoint(state, phaseName) {
  if (!persistentEnabled()) return;
  const rel = checkpointRelativePath();
  fs.mkdirSync(PERSISTENT_CHECKPOINT_DIR, { recursive: true });
  const paths = PHASE_PATHS[phaseName];
  if (!paths) throw new Error(`Fase checkpoint sconosciuta: ${phaseName}`);
  for (const item of paths) if (!fs.existsSync(path.join(CHECKPOINT_DIR, item))) throw new Error(`Artefatto checkpoint assente: ${item}`);

  const tempTar = path.join(CHECKPOINT_DIR, `persist-${phaseName}.tar.gz`);
  fs.rmSync(tempTar, { force: true });
  const tar = spawnSync('tar', ['-czf', tempTar, '-C', CHECKPOINT_DIR, ...paths], { stdio: 'inherit' });
  if (tar.status !== 0) throw new Error(`Creazione checkpoint persistente ${phaseName} non riuscita`);
  const encrypted = path.join(PERSISTENT_CHECKPOINT_DIR, `${phaseName}.enc`);
  const meta = await encryptFileWithDomain(tempTar, encrypted, `riflessa-checkpoint-phase-v1:${phaseName}`);
  writeJsonAtomic(path.join(PERSISTENT_CHECKPOINT_DIR, `${phaseName}.manifest.json`), { format: 'riflessa-checkpoint-phase-v1', phase: phaseName, ...meta });
  fs.rmSync(tempTar, { force: true });

  writeJsonAtomic(path.join(PERSISTENT_CHECKPOINT_DIR, 'state.enc.json'), encryptJson(state, 'riflessa-checkpoint-state-v1'));
  writeJsonAtomic(path.join(PERSISTENT_CHECKPOINT_DIR, 'resume.json'), {
    format: 'riflessa-persistent-checkpoint-v1', projectId: PROJECT_ID, backupName: BACKUP_NAME,
    sourceCommit: SOURCE_COMMIT, previousBackupName: PREVIOUS_BACKUP_NAME, boundary: state.boundary,
    completedPhases: Object.keys(state.phases || {}).filter(name => state.phases[name]?.completedAt), updatedAt: new Date().toISOString()
  });

  run('git', ['-C', BACKUP_REPO_DIR, 'add', '-A', '--', rel]);
  const diff = spawnSync('git', ['-C', BACKUP_REPO_DIR, 'diff', '--cached', '--quiet', '--', rel]);
  if (diff.status === 0) return;
  run('git', ['-C', BACKUP_REPO_DIR, 'commit', '-m', `Checkpoint backup registratore ${BACKUP_NAME} - ${phaseName}`, '--', rel], { stdio: 'pipe' });
  run('git', ['-C', BACKUP_REPO_DIR, 'push', 'origin', 'HEAD:main'], { stdio: 'pipe' });
  console.log(`CHECKPOINT PERSISTENTE ${phaseName}: cifrato e salvato nel repository privato.`);
}
async function restorePersistentCheckpoint() {
  if (!persistentEnabled() || fs.existsSync(STATE_FILE)) return;
  const resumeFile = path.join(PERSISTENT_CHECKPOINT_DIR, 'resume.json');
  const stateEnvelopeFile = path.join(PERSISTENT_CHECKPOINT_DIR, 'state.enc.json');
  if (!fs.existsSync(resumeFile) && !fs.existsSync(stateEnvelopeFile)) return;
  if (!fs.existsSync(resumeFile) || !fs.existsSync(stateEnvelopeFile)) throw new Error('Checkpoint persistente incompleto');
  const resume = readJson(resumeFile);
  if (resume.format !== 'riflessa-persistent-checkpoint-v1' || resume.projectId !== PROJECT_ID || resume.backupName !== BACKUP_NAME || resume.sourceCommit !== SOURCE_COMMIT) {
    throw new Error('Checkpoint persistente riferito a progetto/backup/commit diverso');
  }
  const state = decryptJson(readJson(stateEnvelopeFile), 'riflessa-checkpoint-state-v1');
  if (state.projectId !== PROJECT_ID || state.backupName !== BACKUP_NAME || state.sourceCommit !== SOURCE_COMMIT) throw new Error('Stato checkpoint persistente non coerente');
  writeJsonAtomic(STATE_FILE, state);

  for (const phaseName of Object.keys(PHASE_PATHS)) {
    if (!state.phases?.[phaseName]?.completedAt) continue;
    const encrypted = path.join(PERSISTENT_CHECKPOINT_DIR, `${phaseName}.enc`);
    const manifestFile = path.join(PERSISTENT_CHECKPOINT_DIR, `${phaseName}.manifest.json`);
    if (!fs.existsSync(encrypted) || !fs.existsSync(manifestFile)) throw new Error(`Checkpoint persistente ${phaseName} mancante`);
    const meta = readJson(manifestFile);
    if (meta.format !== 'riflessa-checkpoint-phase-v1' || meta.phase !== phaseName) throw new Error(`Manifest checkpoint ${phaseName} non valido`);
    const tempTar = path.join(CHECKPOINT_DIR, `restore-${phaseName}.tar.gz`);
    await decryptFileWithDomain(encrypted, tempTar, meta, `riflessa-checkpoint-phase-v1:${phaseName}`);
    const tar = spawnSync('tar', ['-xzf', tempTar, '-C', CHECKPOINT_DIR], { stdio: 'inherit' });
    fs.rmSync(tempTar, { force: true });
    if (tar.status !== 0) throw new Error(`Estrazione checkpoint persistente ${phaseName} non riuscita`);
  }
  console.log(`RESUME CROSS-RUN: checkpoint ${BACKUP_NAME} ricostruito dal repository privato.`);
}

function initializeState() {
  if (fs.existsSync(STATE_FILE)) {
    const state = readJson(STATE_FILE);
    if (state.format !== 'riflessa-backup-checkpoint-v1') throw new Error('Checkpoint con formato non valido');
    if (state.projectId !== PROJECT_ID || state.backupName !== BACKUP_NAME || state.sourceCommit !== SOURCE_COMMIT) throw new Error('Checkpoint riferito a progetto/backup/commit diverso');
    return state;
  }
  const state = {
    format: 'riflessa-backup-checkpoint-v1', projectId: PROJECT_ID, backupName: BACKUP_NAME,
    sourceCommit: SOURCE_COMMIT, previousBackupName: PREVIOUS_BACKUP_NAME, createdAt: new Date().toISOString(),
    boundary: null, phases: {}, lastAttempt: ATTEMPT
  };
  writeJsonAtomic(STATE_FILE, state);
  return state;
}
function saveState(state) { state.lastAttempt = ATTEMPT; state.updatedAt = new Date().toISOString(); writeJsonAtomic(STATE_FILE, state); }
function phaseValid(state, name, validator) {
  const phase = state.phases?.[name];
  if (!phase?.completedAt) return false;
  try { return validator(phase); } catch { return false; }
}
async function markPhase(state, name, metadata) {
  state.phases[name] = { ...metadata, completedAt: new Date().toISOString(), attempt: ATTEMPT };
  state.lastAttempt = ATTEMPT;
  state.updatedAt = new Date().toISOString();
  await persistCheckpoint(state, name);
  writeJsonAtomic(STATE_FILE, state);
  console.log(`CHECKPOINT ${name}: completato.`);
}

const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON || '{}');
admin.initializeApp({ credential: admin.credential.cert(credentials), projectId: PROJECT_ID });
const db = admin.firestore();

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
function writeSnapshot(documents, outputDir, format) {
  removeAndCreate(outputDir);
  let partNo = 1, partBytes = 0, partLines = [];
  const parts = [], roots = new Set();
  const flush = () => {
    if (!partLines.length) return;
    const name = `part-${String(partNo++).padStart(4, '0')}.jsonl`;
    fs.writeFileSync(path.join(outputDir, name), partLines.join(''), 'utf8');
    parts.push(name); partBytes = 0; partLines = [];
  };
  for (const documentPath of [...documents.keys()].sort()) {
    const line = JSON.stringify({ path: documentPath, data: documents.get(documentPath) }) + '\n';
    const bytes = Buffer.byteLength(line);
    if (partLines.length && partBytes + bytes > PART_LIMIT) flush();
    partLines.push(line); partBytes += bytes; roots.add(documentPath.split('/')[0]);
  }
  flush();
  const manifest = { format, projectId: PROJECT_ID, documentCount: documents.size, rootCollections: [...roots].sort(), parts };
  writeJsonAtomic(path.join(outputDir, 'manifest.json'), manifest);
  return manifest;
}
function readSnapshot(outputDir) {
  const manifest = readJson(path.join(outputDir, 'manifest.json'));
  const documents = new Map();
  for (const part of manifest.parts || []) {
    const rows = fs.readFileSync(path.join(outputDir, part), 'utf8').split('\n').filter(Boolean);
    for (const row of rows) { const item = JSON.parse(row); documents.set(item.path, item.data); }
  }
  if (documents.size !== Number(manifest.documentCount || 0)) throw new Error(`Snapshot incoerente ${outputDir}`);
  return { manifest, documents };
}
async function walkCollectionIntoMap(collectionRef, documents) {
  const snapshot = await collectionRef.get();
  for (const document of snapshot.docs) {
    documents.set(document.ref.path, encode(document.data()));
    for (const subcollection of await document.ref.listCollections()) await walkCollectionIntoMap(subcollection, documents);
  }
}
async function applyChangedPaths(documents, changedPaths) {
  let changedDocuments = 0, deletedDocuments = 0;
  for (let i = 0; i < changedPaths.length; i += 300) {
    const chunk = changedPaths.slice(i, i + 300);
    const snapshots = await db.getAll(...chunk.map(p => db.doc(p)));
    for (let j = 0; j < snapshots.length; j += 1) {
      const snapshot = snapshots[j], documentPath = chunk[j];
      if (snapshot.exists) { documents.set(documentPath, encode(snapshot.data())); changedDocuments += 1; }
      else if (documents.delete(documentPath)) deletedDocuments += 1;
    }
  }
  return { changedDocuments, deletedDocuments };
}

async function decryptArchive(backupDir, manifest, destination) {
  const encrypted = path.join(backupDir, manifest.archive.file || 'backup.enc');
  if (sha256File(encrypted) !== manifest.archive.cipherSha256) throw new Error('Hash archivio cifrato precedente non valido');
  fs.mkdirSync(destination, { recursive: true });
  const plainArchive = path.join(destination, 'payload.tar.gz');
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey('riflessa-full-backup-v3'), Buffer.from(manifest.archive.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(manifest.archive.authTag, 'base64'));
  await pipeline(fs.createReadStream(encrypted), decipher, fs.createWriteStream(plainArchive));
  if (sha256File(plainArchive) !== manifest.archive.plainSha256) throw new Error('Hash archivio decifrato precedente non valido');
  const extractDir = path.join(destination, 'extracted');
  removeAndCreate(extractDir);
  const tar = spawnSync('tar', ['-xzf', plainArchive, '-C', extractDir], { stdio: 'inherit' });
  if (tar.status !== 0) throw new Error('Estrazione backup precedente non riuscita');
  return path.join(extractDir, 'payload');
}
async function previousPayloadRoot() {
  if (!PREVIOUS_BACKUP_DIR || !fs.existsSync(PREVIOUS_BACKUP_DIR)) return null;
  const publicManifestFile = path.join(PREVIOUS_BACKUP_DIR, 'manifest.json');
  if (!fs.existsSync(publicManifestFile)) return null;
  const manifest = readJson(publicManifestFile);
  if (manifest.format === 'riflessa-registratore-backup-v2') return { format: 'v2', root: PREVIOUS_BACKUP_DIR };
  if (manifest.format !== 'riflessa-registratore-encrypted-v3') return null;
  const cache = path.join(CHECKPOINT_DIR, 'previous-base');
  const marker = path.join(cache, 'archive.sha256');
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === manifest.archive.cipherSha256 && fs.existsSync(path.join(cache, 'extracted', 'payload', 'manifest.json'))) {
    return { format: 'v3', root: path.join(cache, 'extracted', 'payload') };
  }
  fs.rmSync(cache, { recursive: true, force: true });
  const root = await decryptArchive(PREVIOUS_BACKUP_DIR, manifest, cache);
  fs.writeFileSync(marker, manifest.archive.cipherSha256 + '\n');
  return { format: 'v3', root };
}
function readPreviousMaps(previous) {
  if (!previous) return null;
  if (previous.format === 'v2') {
    const fm = readJson(path.join(previous.root, 'firestore', 'manifest.json'));
    const all = readSnapshot(path.join(previous.root, 'firestore')).documents;
    const core = new Map(), logs = new Map();
    for (const [p, d] of all) (p.split('/')[0] === LOG_ROOT ? logs : core).set(p, d);
    return { core, logs, journalCursor: fm.journalCursor || null };
  }
  const pm = readJson(path.join(previous.root, 'manifest.json'));
  return { core: readSnapshot(path.join(previous.root, 'firestore')).documents, logs: readSnapshot(path.join(previous.root, 'logs')).documents, journalCursor: pm.firestore?.journalCursor || null };
}
async function loadPreviousBaseOrNull(label) {
  try { return readPreviousMaps(await previousPayloadRoot()); }
  catch (error) {
    console.warn(`${label}: base locale/archivio precedente non utilizzabile (${error.message || error}). E consentito il fallback full.`);
    return null;
  }
}
function timestampFromIso(value) {
  const d = new Date(value); if (Number.isNaN(d.getTime())) throw new Error(`Timestamp non valido: ${value}`);
  return admin.firestore.Timestamp.fromDate(d);
}

async function phaseFirestore(state) {
  if (phaseValid(state, 'firestore', phase => fs.existsSync(path.join(CORE_DIR, 'manifest.json')) && hashTree(CORE_DIR).sha256 === phase.sha256 && fs.existsSync(LOG_CHANGES_FILE))) {
    console.log('RESUME: Firestore gia completato e verificato.'); return;
  }
  fs.rmSync(CORE_DIR, { recursive: true, force: true });
  fs.rmSync(LOG_CHANGES_FILE, { force: true });
  const boundary = state.boundary ? timestampFromIso(state.boundary) : admin.firestore.Timestamp.now();
  if (!state.boundary) { state.boundary = boundary.toDate().toISOString(); saveState(state); }
  let mode = 'full', journalDocumentsRead = 0, changedCore = [], changedLogs = [], documents;
  const previous = await loadPreviousBaseOrNull('Firestore incrementale');
  if (previous?.journalCursor) {
    const from = timestampFromIso(previous.journalCursor);
    const journal = await db.collection(JOURNAL_COLLECTION).where('changedAt', '>', from).where('changedAt', '<=', boundary).orderBy('changedAt', 'asc').get();
    journalDocumentsRead = journal.size;
    const latestCore = new Map(), latestLogs = new Map();
    for (const jd of journal.docs) {
      const data = jd.data() || {};
      if (Number(data.schemaVersion || 0) !== 1 || !Array.isArray(data.changes)) throw new Error(`Journal Firestore non valido: ${jd.ref.path}`);
      for (const change of data.changes) {
        const p = String(change?.path || ''); if (!p || p.split('/')[0] === JOURNAL_COLLECTION) continue;
        (p.split('/')[0] === LOG_ROOT ? latestLogs : latestCore).set(p, String(change.operation || 'update'));
      }
    }
    changedCore = [...latestCore.keys()].sort(); changedLogs = [...latestLogs.keys()].sort();
    documents = new Map(previous.core);
    const applied = await applyChangedPaths(documents, changedCore);
    mode = 'incremental';
    state.incremental = { mode, journalDocumentsRead, changedCorePaths: changedCore.length, changedLogPaths: changedLogs.length, coreChangedDocuments: applied.changedDocuments, coreDeletedDocuments: applied.deletedDocuments };
  }
  if (mode === 'full') {
    documents = new Map();
    for (const root of await db.listCollections()) {
      if (root.id === JOURNAL_COLLECTION || root.id === LOG_ROOT) continue;
      await walkCollectionIntoMap(root, documents);
    }
    changedLogs = [];
    state.incremental = { mode: 'full', journalDocumentsRead: 0, changedCorePaths: documents.size, changedLogPaths: 0, coreChangedDocuments: documents.size, coreDeletedDocuments: 0 };
  }
  const manifest = writeSnapshot(documents, CORE_DIR, 'riflessa-firestore-core-jsonl-v3');
  writeJsonAtomic(LOG_CHANGES_FILE, { mode, boundary: state.boundary, previousBackupName: PREVIOUS_BACKUP_NAME, paths: changedLogs });
  const tree = hashTree(CORE_DIR);
  await markPhase(state, 'firestore', { sha256: tree.sha256, documentCount: manifest.documentCount, mode, journalDocumentsRead, changedCorePaths: changedCore.length, changedLogPaths: changedLogs.length });
}

function serializeUser(user) {
  return {
    uid: user.uid, email: user.email || null, emailVerified: !!user.emailVerified, displayName: user.displayName || null,
    photoURL: user.photoURL || null, phoneNumber: user.phoneNumber || null, disabled: !!user.disabled,
    customClaims: user.customClaims || null, tenantId: user.tenantId || null,
    providerData: (user.providerData || []).map(p => ({ uid: p.uid || null, displayName: p.displayName || null, email: p.email || null, photoURL: p.photoURL || null, providerId: p.providerId || null, phoneNumber: p.phoneNumber || null })),
    metadata: { creationTime: user.metadata?.creationTime || null, lastSignInTime: user.metadata?.lastSignInTime || null, lastRefreshTime: user.metadata?.lastRefreshTime || null },
    passwordHash: user.passwordHash ? Buffer.from(user.passwordHash).toString('base64') : null,
    passwordSalt: user.passwordSalt ? Buffer.from(user.passwordSalt).toString('base64') : null,
    tokensValidAfterTime: user.tokensValidAfterTime || null
  };
}
function encryptAuthentication(payload) {
  const canonical = authCanonical();
  const key = crypto.createHash('sha256').update(canonical).digest();
  const fingerprint = crypto.createHash('sha256').update(canonical).digest('hex');
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')), cipher.final()]);
  return { format: 'riflessa-firebase-auth-aes256gcm-v1', configFingerprint: fingerprint, iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'), accountCount: payload.users.length, hashedPasswordCount: payload.users.filter(u => u.passwordHash && u.passwordSalt).length };
}
function decryptAuthentication(file) {
  const envelope = readJson(file), canonical = authCanonical();
  if (envelope.format !== 'riflessa-firebase-auth-aes256gcm-v1') throw new Error('Formato Authentication non valido');
  if (sha256Buffer(canonical) !== envelope.configFingerprint) throw new Error('Fingerprint Authentication non corrispondente');
  const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(canonical).digest(), Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  const payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
  if (!Array.isArray(payload.users) || payload.users.length !== Number(envelope.accountCount)) throw new Error('Authentication incoerente');
  return { payload, envelope };
}
async function phaseAuth(state) {
  if (phaseValid(state, 'auth', phase => fs.existsSync(AUTH_FILE) && sha256File(AUTH_FILE) === phase.sha256 && decryptAuthentication(AUTH_FILE).payload.users.length === phase.accountCount)) {
    console.log('RESUME: Auth gia completato e verificato.'); return;
  }
  fs.rmSync(AUTH_FILE, { force: true });
  const users = []; let pageToken;
  do { const page = await admin.auth().listUsers(1000, pageToken); users.push(...page.users.map(serializeUser)); pageToken = page.pageToken; } while (pageToken);
  const payload = { format: 'riflessa-firebase-auth-v1', projectId: PROJECT_ID, createdAt: new Date().toISOString(), users };
  writeJsonAtomic(AUTH_FILE, encryptAuthentication(payload));
  const verified = decryptAuthentication(AUTH_FILE);
  await markPhase(state, 'auth', { sha256: sha256File(AUTH_FILE), accountCount: verified.envelope.accountCount, hashedPasswordCount: verified.envelope.hashedPasswordCount, hashAlgorithm: normalizedHashConfig(AUTH_HASH_CONFIG).algorithm });
}

function copyFilePreserve(src, dest) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(src, dest); }
function hostingIgnored(relative, isDirectory) {
  const normalized = relative.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (parts.some(p => p.startsWith('.'))) return true;
  if (parts.includes('node_modules')) return true;
  const top = parts[0];
  if (isDirectory && ['electron', 'scripts', 'tests', 'config', 'dist', '.firebase'].includes(top)) return true;
  if (!isDirectory && parts.length === 1 && ['firebase.json', 'firestore.rules', '.firebaserc', 'package.json', 'package-lock.json', 'README.md'].includes(top)) return true;
  if (!isDirectory && normalized.endsWith('.txt')) return true;
  return false;
}
function copyHostingTree(srcRoot, destRoot, relative = '') {
  for (const entry of fs.readdirSync(path.join(srcRoot, relative), { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (hostingIgnored(rel, entry.isDirectory())) continue;
    if (entry.isDirectory()) copyHostingTree(srcRoot, destRoot, rel);
    else if (entry.isFile()) copyFilePreserve(path.join(srcRoot, rel), path.join(destRoot, rel));
  }
}
function copyAppConfig() {
  const files = [
    ['.firebaserc', '.firebaserc'], ['firebase.json', 'firebase.json'], ['firestore.rules', 'firestore.rules'], ['package.json', 'package.json'],
    ['config/default-axon-profile.json', 'config/default-axon-profile.json'], ['js/firebase-config.js', 'js/firebase-config.js']
  ];
  for (const [src, dest] of files) {
    const source = path.join(SOURCE_APP_DIR, src); if (!fs.existsSync(source)) throw new Error(`Config sorgente assente: ${src}`);
    copyFilePreserve(source, path.join(APP_CONFIG_DIR, dest));
  }
}
async function phaseHosting(state) {
  if (phaseValid(state, 'hosting', phase => fs.existsSync(HOSTING_DIR) && fs.existsSync(APP_CONFIG_DIR) && hashTree(HOSTING_DIR).sha256 === phase.hostingSha256 && hashTree(APP_CONFIG_DIR).sha256 === phase.appConfigSha256)) {
    console.log('RESUME: Hosting gia completato e verificato.'); return;
  }
  removeAndCreate(HOSTING_DIR); removeAndCreate(APP_CONFIG_DIR);
  copyHostingTree(SOURCE_APP_DIR, HOSTING_DIR); copyAppConfig();
  const hosting = hashTree(HOSTING_DIR), appConfig = hashTree(APP_CONFIG_DIR);
  writeJsonAtomic(path.join(PAYLOAD_DIR, 'hosting-manifest.json'), { format: 'riflessa-hosting-snapshot-v1', sourceCommit: SOURCE_COMMIT, fileCount: hosting.fileCount, sha256: hosting.sha256, files: hosting.files });
  await markPhase(state, 'hosting', { hostingSha256: hosting.sha256, hostingFileCount: hosting.fileCount, appConfigSha256: appConfig.sha256, appConfigFileCount: appConfig.fileCount });
}

async function phaseLogs(state) {
  if (phaseValid(state, 'logs', phase => fs.existsSync(path.join(LOG_DIR, 'manifest.json')) && hashTree(LOG_DIR).sha256 === phase.sha256)) {
    console.log('RESUME: Log gia completati e verificati.'); return;
  }
  const changeInfo = readJson(LOG_CHANGES_FILE);
  let documents = new Map(), mode = changeInfo.mode, changedDocuments = 0, deletedDocuments = 0;
  if (mode === 'incremental') {
    const previous = await loadPreviousBaseOrNull('Log incrementali');
    if (!previous) {
      console.warn('Base log precedente incompatibile: e consentito il fallback full dei soli log.');
      mode = 'full';
    } else {
      documents = new Map(previous.logs);
      const applied = await applyChangedPaths(documents, Array.isArray(changeInfo.paths) ? changeInfo.paths : []);
      changedDocuments = applied.changedDocuments; deletedDocuments = applied.deletedDocuments;
    }
  }
  if (mode === 'full') {
    documents = new Map();
    await walkCollectionIntoMap(db.collection(LOG_ROOT), documents);
    changedDocuments = documents.size; deletedDocuments = 0;
  }
  const manifest = writeSnapshot(documents, LOG_DIR, 'riflessa-firestore-logs-jsonl-v3');
  const tree = hashTree(LOG_DIR);
  await markPhase(state, 'logs', { sha256: tree.sha256, documentCount: manifest.documentCount, mode, changedDocuments, deletedDocuments });
}

function countSnapshotDocs(dir) { return readSnapshot(dir).documents.size; }
function verifyPayload(root) {
  const manifest = readJson(path.join(root, 'manifest.json'));
  if (manifest.format !== 'riflessa-registratore-payload-v3' || manifest.projectId !== PROJECT_ID) throw new Error('Manifest payload v3 non valido');
  const coreCount = countSnapshotDocs(path.join(root, 'firestore'));
  const logCount = countSnapshotDocs(path.join(root, 'logs'));
  if (coreCount !== Number(manifest.firestore.coreDocumentCount) || logCount !== Number(manifest.firestore.logDocumentCount)) throw new Error('Conteggio Firestore/log payload non coerente');
  const auth = decryptAuthentication(path.join(root, 'authentication.enc.json'));
  if (auth.payload.users.length !== Number(manifest.authentication.accountCount)) throw new Error('Conteggio Auth payload non coerente');
  const hm = readJson(path.join(root, 'hosting-manifest.json')), hosting = hashTree(path.join(root, 'hosting'));
  if (hm.sha256 !== hosting.sha256 || Number(hm.fileCount) !== hosting.fileCount) throw new Error('Hosting payload non coerente');
  for (const rel of ['app-config/.firebaserc', 'app-config/firebase.json', 'app-config/firestore.rules', 'app-config/package.json', 'app-config/config/default-axon-profile.json', 'app-config/js/firebase-config.js', 'SOURCE_COMMIT.txt', 'BACKUP_INFO.txt']) {
    if (!fs.existsSync(path.join(root, rel))) throw new Error(`File payload assente: ${rel}`);
  }
  return { manifest, coreCount, logCount, authCount: auth.payload.users.length, hostingFiles: hosting.fileCount };
}
async function encryptFile(input, output) { return encryptFileWithDomain(input, output, 'riflessa-full-backup-v3'); }
async function decryptFinalForVerification(publicManifest, destination) {
  removeAndCreate(destination);
  const encrypted = path.join(FINAL_DIR, publicManifest.archive.file);
  if (sha256File(encrypted) !== publicManifest.archive.cipherSha256) throw new Error('Hash archivio cifrato finale non valido');
  const archive = path.join(destination, 'payload.tar.gz');
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey('riflessa-full-backup-v3'), Buffer.from(publicManifest.archive.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(publicManifest.archive.authTag, 'base64'));
  await pipeline(fs.createReadStream(encrypted), decipher, fs.createWriteStream(archive));
  if (sha256File(archive) !== publicManifest.archive.plainSha256) throw new Error('Hash archivio finale decifrato non valido');
  const tar = spawnSync('tar', ['-xzf', archive, '-C', destination], { stdio: 'inherit' });
  if (tar.status !== 0) throw new Error('Rilettura archivio finale non riuscita');
  return verifyPayload(path.join(destination, 'payload'));
}
async function finalize(state) {
  if (!phaseValid(state, 'firestore', p => hashTree(CORE_DIR).sha256 === p.sha256)) throw new Error('Checkpoint Firestore non valido');
  if (!phaseValid(state, 'auth', p => sha256File(AUTH_FILE) === p.sha256)) throw new Error('Checkpoint Auth non valido');
  if (!phaseValid(state, 'hosting', p => hashTree(HOSTING_DIR).sha256 === p.hostingSha256 && hashTree(APP_CONFIG_DIR).sha256 === p.appConfigSha256)) throw new Error('Checkpoint Hosting non valido');
  if (!phaseValid(state, 'logs', p => hashTree(LOG_DIR).sha256 === p.sha256)) throw new Error('Checkpoint Log non valido');

  const auth = decryptAuthentication(AUTH_FILE).envelope;
  const hosting = readJson(path.join(PAYLOAD_DIR, 'hosting-manifest.json'));
  const core = readSnapshot(CORE_DIR).manifest, logs = readSnapshot(LOG_DIR).manifest;
  const createdAt = new Date().toISOString();
  const payloadManifest = {
    format: 'riflessa-registratore-payload-v3', projectId: PROJECT_ID, createdAt, sourceCommit: SOURCE_COMMIT,
    backupName: BACKUP_NAME, baseBackup: PREVIOUS_BACKUP_NAME, backupMode: state.phases.firestore.mode,
    firestore: {
      journalCursor: state.boundary, journalDocumentsRead: state.phases.firestore.journalDocumentsRead || 0,
      changedCorePaths: state.phases.firestore.changedCorePaths || 0, changedLogPaths: state.phases.firestore.changedLogPaths || 0,
      coreDocumentCount: core.documentCount, logDocumentCount: logs.documentCount, totalDocumentCount: Number(core.documentCount) + Number(logs.documentCount)
    },
    authentication: { accountCount: auth.accountCount, hashedPasswordCount: auth.hashedPasswordCount, hashAlgorithm: state.phases.auth.hashAlgorithm },
    hosting: { fileCount: hosting.fileCount, sha256: hosting.sha256 },
    checkpoints: { firestore: state.phases.firestore.completedAt, auth: state.phases.auth.completedAt, hosting: state.phases.hosting.completedAt, logs: state.phases.logs.completedAt }
  };
  writeJsonAtomic(path.join(PAYLOAD_DIR, 'manifest.json'), payloadManifest);
  fs.writeFileSync(path.join(PAYLOAD_DIR, 'SOURCE_COMMIT.txt'), `${SOURCE_COMMIT || ''}\n`, 'utf8');
  fs.writeFileSync(path.join(PAYLOAD_DIR, 'BACKUP_INFO.txt'), [
    'Backup registratore cifrato v3', `Data UTC: ${createdAt}`, `Progetto: ${PROJECT_ID}`, `Commit applicazione: ${SOURCE_COMMIT || '-'}`,
    `Modalita Firestore: ${payloadManifest.backupMode}`, `Base precedente: ${PREVIOUS_BACKUP_NAME || 'nessuna'}`,
    `Firestore core: ${core.documentCount}`, `Log: ${logs.documentCount}`, `Auth: ${auth.accountCount}`, `Hosting: ${hosting.fileCount} file`,
    `Tentativo riuscito: ${ATTEMPT}/4`, 'Checkpoint di fase cifrati persistenti nel repository privato fino al push del backup definitivo.'
  ].join('\n') + '\n');
  verifyPayload(PAYLOAD_DIR);

  fs.rmSync(FINAL_DIR, { recursive: true, force: true }); fs.mkdirSync(FINAL_DIR, { recursive: true });
  const archive = path.join(CHECKPOINT_DIR, 'payload-final.tar.gz'); fs.rmSync(archive, { force: true });
  const tar = spawnSync('tar', ['-czf', archive, '-C', CHECKPOINT_DIR, 'payload'], { stdio: 'inherit' });
  if (tar.status !== 0) throw new Error('Creazione archivio finale non riuscita');
  const encryptedFile = path.join(FINAL_DIR, 'backup.enc');
  const archiveMeta = await encryptFile(archive, encryptedFile);
  const publicManifest = {
    format: 'riflessa-registratore-encrypted-v3', projectId: PROJECT_ID, createdAt, sourceCommit: SOURCE_COMMIT,
    backupName: BACKUP_NAME, backupMode: payloadManifest.backupMode, baseBackup: PREVIOUS_BACKUP_NAME,
    firestore: payloadManifest.firestore, authentication: payloadManifest.authentication, hosting: payloadManifest.hosting,
    archive: { file: 'backup.enc', cipher: 'AES-256-GCM', keyDerivation: 'SHA-256 domain-separated FIREBASE_AUTH_HASH_CONFIG', ...archiveMeta }
  };
  writeJsonAtomic(path.join(FINAL_DIR, 'manifest.json'), publicManifest);
  const verified = await decryptFinalForVerification(publicManifest, path.join(CHECKPOINT_DIR, 'final-reread'));
  console.log(`Backup finale cifrato, riletto e verificato: ${verified.coreCount} core + ${verified.logCount} log, ${verified.authCount} account, ${verified.hostingFiles} file Hosting.`);
}

function testStopAfter(phaseName) {
  if (!TEST_STOP_AFTER_PHASE) return;
  if (!ALLOW_TEST_FAILPOINTS) throw new Error('TEST_STOP_AFTER_PHASE richiede ALLOW_TEST_FAILPOINTS=1');
  if (TEST_STOP_AFTER_PHASE === phaseName) {
    const error = new Error(`TEST_FAILPOINT_AFTER_${phaseName.toUpperCase()}: arresto intenzionale dopo checkpoint persistito`);
    error.code = 'RIFLESSA_TEST_FAILPOINT';
    throw error;
  }
}

async function main() {
  await restorePersistentCheckpoint();
  const state = initializeState();
  await phaseFirestore(state); testStopAfter('firestore');
  await phaseAuth(state); testStopAfter('auth');
  await phaseHosting(state); testStopAfter('hosting');
  await phaseLogs(state); testStopAfter('logs');
  await finalize(state);
}
main().catch(error => { console.error(error); process.exit(1); });
