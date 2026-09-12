# riflessahairbeauty-workflows

Workflow separati dalla repository applicativa privata `Mirkolas/riflessahairbeauty`.

## Hosting Firebase

- **Registratore**: target Firebase `registratore` -> site ID `riflessa-15a20` -> `riflessa-15a20.web.app`.
- **Futura web app**: target Firebase `hairbeauty` -> site ID `riflessa-hair-beauty` -> `riflessa-hair-beauty.web.app`.

## Workflow registratore

- **Firebase backup - registratore**: esecuzione giornaliera alle `02:17 UTC` e avvio manuale. Legge Firestore tramite Firebase Admin SDK e crea un backup JSON completo nella repository privata sotto `backup-registratore/backup-YYYYMMDD-HHMMSS/`.
- **Tentativi backup**: ogni esecuzione prova fino a 5 volte l'intero ciclo lettura Firestore -> validazione JSON -> commit -> push. Il tentativo e considerato riuscito solo dopo il push nella repository privata.
- **Retention backup**: quando il numero di cartelle backup raggiunge 5, vengono eliminati i backup precedenti e viene conservato soltanto il backup appena creato.
- **Firebase deploy - registratore**: deploy manuale o tramite `repository_dispatch`; esegue `npm test` e `npm run check`, quindi pubblica esclusivamente il target Hosting `registratore` sul progetto `riflessa-15a20`.
- **Firebase ripristino - registratore**: ripristino manuale dal file `firestore.json` presente in una cartella `backup-registratore/backup-YYYYMMDD-HHMMSS/`. Se non viene indicato un nome usa il backup piu recente. Richiede la conferma testuale esatta `RIPRISTINA`.

Il backup e il ripristino JSON non richiedono un bucket Google Cloud Storage e non richiedono l'attivazione del billing GCP.

## Configurazione GitHub Actions

I workflow usano esclusivamente questi nomi configurati nella repository pubblica `Mirkolas/riflessahairbeauty-workflows`:

### Secrets

- `FIREBASE_SERVICE_ACCOUNT`: JSON del service account Firebase/GCP.
- `PUBLIC_REPO_TOKEN`: fine-grained PAT con accesso alla repository privata `Mirkolas/riflessahairbeauty`; per il backup deve avere `Contents: Read and write`.

### Variables

- `FIREBASE_PROJECT_ID`: `riflessa-15a20`.
- `FIREBASE_HOSTING_TARGET`: `registratore`.

Nessun valore sensibile viene inserito nei file pubblici.

## Verifiche eseguite

La configurazione e stata provata con GitHub Actions reale:

- accesso della repository pubblica alla repository privata tramite `PUBLIC_REPO_TOKEN`;
- mapping `registratore` -> `riflessa-15a20`;
- test applicativi e controllo progetto;
- autenticazione con `FIREBASE_SERVICE_ACCOUNT`;
- lettura Firestore;
- backup JSON reale con commit e push nella repository privata;
- validazione del formato di ripristino senza modificare i dati;
- verifica del sito Firebase Hosting `riflessa-15a20`;
- deploy Hosting reale sul target `registratore`.

## Regole Firestore

Il service account attuale consente l'accesso a Firestore e il deploy Firebase Hosting, ma il test di deploy delle regole Firestore ha restituito `403` sull'API Firebase Rules. Per questo il workflow di deploy definitivo pubblica il solo Hosting `registratore`, evitando esecuzioni che risultino fallite dopo un deploy valido del sito.

Quando al service account verra assegnato il permesso IAM necessario per amministrare Firebase Rules, il deploy delle `firestore:rules` potra essere riattivato nel workflow.
