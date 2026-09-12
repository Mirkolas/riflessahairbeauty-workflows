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

Il deploy e manuale o tramite `repository_dispatch`. Esegue prima `npm test` e `npm run check`, quindi pubblica insieme:

- `firestore:rules` sul progetto `riflessa-15a20`;
- `hosting:registratore` sul sito `riflessa-15a20.web.app`.

L'interfaccia registratore e responsive anche sulla versione Hosting: desktop, PC da banco, tablet e schermi piccoli. L'app Electron e ridimensionabile fino a 360 px e utilizza lo stesso foglio `responsive.css`.

## Sincronizzazione log locali

La sincronizzazione cloud dei log e attiva. Dopo il login nell'app Electron, se la postazione e online, `js/log-sync.js` legge i file locali esposti dal preload Electron e li salva a blocchi nella collection `registratoreLogFiles` e nelle relative subcollection `chunks`.

La sincronizzazione parte poco dopo l'autenticazione e viene ripetuta periodicamente; vengono risincronizzati soltanto i file modificati. Le Firestore Rules consentono la scrittura all'utente autenticato soltanto quando `operatorUid` coincide con il suo UID.

Il primo backup completo v2 eseguito prima dell'attivazione definitiva delle Rules conteneva ancora `0` documenti log. Dopo che l'app Electron viene aperta e autenticata almeno una volta con connessione disponibile, i log locali vengono caricati su Firestore e rientrano automaticamente nei backup successivi.

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
- responsive CSS;
- codice di sincronizzazione log e relativo caricamento nell'app;
- lettura ricorsiva Firestore;
- lettura Firebase Authentication con password hash;
- riconoscimento configurazione SCRYPT (`rounds=8`, `mem_cost=14`);
- backup completo reale con commit e push nella repository privata;
- decrittazione Authentication e dry-run non distruttivo del ripristino;
- pubblicazione reale delle Firestore Rules con ruolo IAM `Firebase Rules Admin`;
- deploy reale combinato `firestore:rules,hosting:registratore` completato con successo.

Il backup reale del 12 settembre 2026 ha prodotto il formato `riflessa-registratore-backup-v2`, con 6 documenti Firestore e 1 account Authentication con hash password. In quel momento la sincronizzazione log non era ancora attiva nel client; la versione successivamente distribuita include il caricamento automatico di `js/log-sync.js`.
