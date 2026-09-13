const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const BACKUP_PATH = process.env.BACKUP_PATH;
const PROJECT_ID = process.env.PROJECT_ID;
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON || '{}');
if (!BACKUP_PATH || !PROJECT_ID || !credentials.project_id) throw new Error('Configurazione pulizia journal incompleta');

const manifestFile = path.join(BACKUP_PATH, 'manifest.json');
if (!fs.existsSync(manifestFile)) throw new Error('Manifest backup verificato assente');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
if (manifest.format !== 'riflessa-registratore-encrypted-v3') throw new Error('Pulizia journal consentita solo dopo backup v3 verificato');
if (manifest.projectId !== PROJECT_ID) throw new Error('Project ID del backup non corrispondente');
const cursor = manifest.firestore?.journalCursor;
if (!cursor) throw new Error('Cursor journal assente nel backup verificato');
const cursorDate = new Date(cursor);
if (Number.isNaN(cursorDate.getTime())) throw new Error('Cursor journal non valido');

admin.initializeApp({ credential: admin.credential.cert(credentials), projectId: PROJECT_ID });
const db = admin.firestore();
const boundary = admin.firestore.Timestamp.fromDate(cursorDate);

async function main() {
  let deleted = 0;
  while (true) {
    const snapshot = await db.collection('_backupChanges')
      .where('changedAt', '<=', boundary)
      .orderBy('changedAt', 'asc')
      .limit(400)
      .get();
    if (snapshot.empty) break;
    const batch = db.batch();
    for (const document of snapshot.docs) batch.delete(document.ref);
    await batch.commit();
    deleted += snapshot.size;
    console.log(`Journal: eliminate ${deleted} entry gia comprese nel backup verificato.`);
  }
  console.log(`Pulizia journal completata fino a ${cursor}: ${deleted} entry eliminate. Entry successive preservate.`);
}

main().catch(error => { console.error(error); process.exit(1); });
