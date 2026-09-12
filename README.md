# riflessahairbeauty-workflows

Workflow separati dalla repository applicativa privata `Mirkolas/riflessahairbeauty`.

## Hosting Firebase

- **Registratore**: target Firebase `registratore` -> site ID `riflessa-15a20` -> `riflessa-15a20.web.app`.
- **Futura web app**: target Firebase `hairbeauty` -> site ID `riflessa-hair-beauty` -> `riflessa-hair-beauty.web.app`.

## Firebase backup - registratore

Esecuzione giornaliera alle `02:17 UTC` e avvio manuale. Ogni esecuzione prova fino a 5 volte e viene considerata riuscita soltanto dopo il push nella repository privata.

Il backup viene salvato in `Mirkolas/riflessahairbeauty/backup-registratore/backup-YYYYMMDD-HHMMSS/` e contiene:

- **Firestore completo**, con scansione ricorsiva di tutte le collection e subcollection. Include quindi scontrini, utenti/profili, operatori, prodotti, categorie, sessioni di cassa, chiusure, resi, movimenti, impostazioni e qualsiasi altra collection presente nel progetto.
- **Firebase Authentication**, inclusi UID, email, provider, custom claims, stato account, `passwordHash` e `passwordSalt` quando presenti. I dati Authentication vengono cifrati con AES-256-GCM prima di essere salvati nella repository privata.
- **Configurazione necessaria alle password Firebase SCRYPT** tramite il Secret `FIREBASE_AUTH_HASH_CONFIG`; il valore del secret non viene mai scritto nel backup.
- **Log locali del registratore** sincronizzati dall'app Electron nella collection Firestore `registratoreLogFiles`, inclusi `RIFLESSA_SERVICE_LOG.txt`, i log JSONL e il profilo locale presenti nella cartella `RiflessaAxon`.
- **Configurazione dell'applicazione**: `.firebaserc`, `firebase.json`, `firestore.rules`, `package.json`, profilo AXON predefinito e configurazione Firebase web.
- **Commit sorgente** dell'app dal quale e stato eseguito il backup.

I dati Firestore vengono divisi in file JSONL da circa 15 MB per evitare il limite dei singoli file GitHub quando i log cresceranno.

### Retention

La regola richiesta e mantenuta: quando il numero delle cartelle backup raggiunge 5, vengono eliminati i backup precedenti e viene conservato soltanto il backup appena creato.

## Firebase ripristino - registratore

Il ripristino e manuale e richiede la conferma esatta `RIPRISTINA`. Se il nome del backup viene lasciato vuoto usa quello piu recente.

Il formato v2 ripristina Firestore e Firebase Authentication. Per Authentication sono disponibili:

- `merge`: aggiorna gli account esistenti e importa quelli mancanti;
- `replace`: elimina gli account Authentication correnti e ricrea quelli presenti nel backup.

Gli hash password Firebase SCRYPT vengono importati usando `FIREBASE_AUTH_HASH_CONFIG`, in modo da conservare le password esistenti. E supportato anche il vecchio backup Firestore-only v1.

## Firebase deploy - registratore

Il deploy e manuale o tramite `repository_dispatch`. Esegue prima `npm test` e `npm run check`, poi pubblica esclusivamente `hosting:registratore` sul progetto `riflessa-15a20`.

L'interfaccia registratore e responsive anche sulla versione Hosting: desktop, PC da banco, tablet e schermi piccoli. L'app Electron e ridimensionabile fino a 360 px e utilizza lo stesso foglio `responsive.css`.

## Configurazione GitHub Actions

La repository pubblica `Mirkolas/riflessahairbeauty-workflows` usa questi nomi esatti.

### Secrets

- `FIREBASE_SERVICE_ACCOUNT`: JSON del service account Firebase/GCP.
- `PUBLIC_REPO_TOKEN`: fine-grained PAT con `Contents: Read and write` sulla repository privata `Mirkolas/riflessahairbeauty`.
- `FIREBASE_AUTH_HASH_CONFIG`: parametri hash Firebase Authentication; sono accettati sia JSON sia il formato nativo `hash_config { ... }` mostrato dalla console Firebase.

### Variables

- `FIREBASE_PROJECT_ID`: `riflessa-15a20`.
- `FIREBASE_HOSTING_TARGET`: `registratore`.

Nessun valore sensibile viene inserito nei file pubblici.

## Verifiche reali eseguite

Sono stati verificati con GitHub Actions reale:

- accesso read/write alla repository privata con `PUBLIC_REPO_TOKEN`;
- test applicativi e `npm run check`;
- responsive CSS e codice di sincronizzazione log;
- lettura ricorsiva Firestore;
- lettura Firebase Authentication con password hash;
- riconoscimento configurazione SCRYPT (`rounds=8`, `mem_cost=14`);
- backup completo reale con commit e push nella repository privata;
- decrittazione Authentication e dry-run non distruttivo del ripristino;
- deploy Hosting reale sul target `registratore`.

Il backup reale del 12 settembre 2026 ha prodotto il formato `riflessa-registratore-backup-v2`, con 6 documenti Firestore e 1 account Authentication con hash password. In quel momento non erano ancora presenti documenti `registratoreLogFiles`, perche le nuove regole Firestore non erano ancora state pubblicate.

## Regole Firestore e sincronizzazione log

Il codice e le regole per `registratoreLogFiles` sono gia presenti nella repository privata. Il service account attuale, pero, non dispone del permesso per pubblicare Firebase Security Rules e il test dell'API `firebaserules` ha restituito `403`. Inoltre non e configurato un Secret `FIREBASE_TOKEN` alternativo.

Per attivare la sincronizzazione cloud dei log locali occorre assegnare al service account il ruolo IAM **Firebase Rules Admin** (`roles/firebaserules.admin`) sul progetto `riflessa-15a20`, quindi pubblicare `firestore.rules`. Fino a quel momento Firestore/Auth/config vengono regolarmente salvati, mentre i file locali `RiflessaAxon` non possono ancora essere caricati nel cloud.
