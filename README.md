# riflessahairbeauty-workflows

Workflow separati dalla repository applicativa privata `Mirkolas/riflessahairbeauty`.

## Hosting Firebase

- **Registratore**: target Firebase `registratore` -> site ID `riflessa-15a20` -> `riflessa-15a20.web.app`.
- **Futura web app**: target Firebase `hairbeauty` -> site ID `riflessa-hair-beauty` -> `riflessa-hair-beauty.web.app`.

## Workflow registratore

- **Firebase backup - registratore**: esecuzione giornaliera e manuale. Ogni esecuzione prova fino a 5 volte l'intero ciclo Firestore export -> copia locale -> commit -> push. Il tentativo e considerato riuscito solo quando il backup e presente nella repository privata sotto `backup-registratore/backup-YYYYMMDD-HHMMSS/`.
- **Retention backup**: quando il numero di cartelle backup raggiunge 5, vengono eliminati i backup precedenti e viene conservato soltanto il backup appena creato.
- **Firebase deploy - registratore**: deploy manuale o tramite `repository_dispatch`; esegue `npm test` e `npm run check`, quindi pubblica `firestore:rules` e soltanto `hosting:registratore`.
- **Firebase ripristino - registratore**: ripristino manuale da una cartella presente in `backup-registratore/`; se non viene indicato un nome usa il backup piu recente. Richiede la conferma testuale `RIPRISTINA`. Il workflow carica temporaneamente i file del backup su Cloud Storage, esegue l'import Firestore e poi rimuove la copia temporanea.

## Sicurezza

Nessuna credenziale e nessun valore sensibile e presente nei file pubblici dei workflow. I workflow leggono esclusivamente GitHub Actions Secrets/Variables configurati nelle impostazioni della repository.

Secret supportati, in ordine di priorita:

- credenziali Google/Firebase: `FIREBASE_SERVICE_ACCOUNT_RIFLESSA_15A20`, `FIREBASE_SERVICE_ACCOUNT`, `GCP_CREDENTIALS` oppure `GOOGLE_CREDENTIALS`;
- PAT per leggere e, per il backup, scrivere nella repository privata: `RIFLESSA_PAT`, `REPO_PAT`, `GH_PAT` oppure `PAT`;
- in alternativa alle credenziali Google, il solo workflow di deploy supporta anche `FIREBASE_TOKEN`.

Variabili opzionali:

- `FIREBASE_PROJECT_ID` oppure `GCP_PROJECT_ID` (fallback: `riflessa-15a20`);
- `FIRESTORE_BACKUP_BUCKET` oppure `BACKUP_BUCKET` (fallback: `riflessa-15a20-firestore-backups`, usato come area temporanea per export/import);
- `APP_REPOSITORY` (fallback: `Mirkolas/riflessahairbeauty`).

Il ripristino Firestore usa l'import gestito da Google Cloud. L'import ripristina i documenti inclusi nel backup ma non elimina automaticamente eventuali documenti extra creati dopo il backup.
