# riflessahairbeauty-workflows

Workflow separati dalla repository applicativa `Mirkolas/riflessahairbeauty`.

## Registratore

- **Firebase backup - registratore**: backup giornaliero Firestore. I backup sono salvati sotto `registratore/daily/`. Quando il numero dei backup arriva a 5, vengono eliminati i precedenti e rimane soltanto il piu recente.
- **Firebase deploy - registratore**: deploy manuale o tramite `repository_dispatch` della versione scelta della repo applicativa. Prima del deploy esegue `npm test` e `npm run check`, quindi pubblica le regole Firestore e il target Hosting `hairbeauty`.
- **Firebase ripristino - registratore**: ripristino manuale Firestore dal backup indicato oppure, se non viene indicato, dal backup piu recente. Richiede la conferma testuale `RIPRISTINA`.

## Sicurezza

Nessuna credenziale e nessun valore sensibile e presente nei file dei workflow. I workflow leggono esclusivamente GitHub Actions Secrets/Variables configurati nelle impostazioni della repository.

Secret supportati, in ordine di priorita:

- credenziali Google/Firebase: `FIREBASE_SERVICE_ACCOUNT_RIFLESSA_15A20`, `FIREBASE_SERVICE_ACCOUNT`, `GCP_CREDENTIALS` oppure `GOOGLE_CREDENTIALS`;
- PAT per leggere la repository applicativa: `RIFLESSA_PAT`, `REPO_PAT`, `GH_PAT` oppure `PAT`;
- in alternativa alle credenziali Google, il deploy supporta anche `FIREBASE_TOKEN`.

Variabili opzionali:

- `FIREBASE_PROJECT_ID` oppure `GCP_PROJECT_ID` (fallback: `riflessa-15a20`);
- `FIRESTORE_BACKUP_BUCKET` oppure `BACKUP_BUCKET` (fallback: `riflessa-15a20-firestore-backups`);
- `APP_REPOSITORY` (fallback: `Mirkolas/riflessahairbeauty`).

Il ripristino Firestore utilizza l'import gestito da Google Cloud. L'import sovrascrive i documenti presenti nel backup ma non elimina automaticamente eventuali documenti extra creati dopo il backup.
