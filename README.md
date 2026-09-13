# riflessahairbeauty-workflows

Workflow separati dalla repository applicativa privata `Mirkolas/riflessahairbeauty`.

## Hosting Firebase

- **Registratore**: target Firebase `registratore` -> site ID `riflessa-15a20` -> `riflessa-15a20.web.app`.
- **Web app futura**: verra collegata a un progetto Firebase separato; il vecchio site ID `riflessa-hair-beauty` non viene piu usato.

## Firebase backup - registratore

Esecuzione automatica **ogni domenica a mezzanotte, ora italiana (`Europe/Rome`)**, con gestione automatica di ora legale/solare, e avvio manuale disponibile. Ogni esecuzione prova fino a 5 volte e viene considerata riuscita soltanto dopo il push nella repository privata.

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

Il client controlla i log ogni 5 minuti; le append piccole possono essere accumulate fino a 15 minuti. I chunk sono allineati al limite del bridge Electron (240 KiB), quindi un file in crescita non viene riscritto interamente ad ogni controllo. Le Firestore Rules consentono la scrittura all'utente autenticato soltanto quando `operatorUid` coincide con il suo UID.

## Build automatica EXE Windows

Il workflow `build-exe-registratore.yml` gira nella repository pubblica per non usare runner della repository privata, ma legge il sorgente esclusivamente da `Mirkolas/riflessahairbeauty` tramite `PUBLIC_REPO_TOKEN`.

Ogni 5 minuti controlla il campo `version` del `package.json` del registratore. Se nella repository privata non esiste ancora la Release `registratore-vVERSION` con l'installer atteso, avvia un runner Windows x64 e:

1. esegue `npm install`;
2. esegue tutti i test;
3. esegue `npm run check`;
4. crea l'installer NSIS con `electron-builder`;
5. pubblica il file **solo** nella Release della repository privata.

Il file segue il formato:

`RiflessaRegistratore-Setup-VERSION-x64.exe`

Per creare una nuova versione basta modificare nel `package.json`:

```json
"version": "3.5.3"
```

e fare push su `main`. Non serve rinominare la cartella dell'app. Il workflow e anche avviabile manualmente da GitHub Actions.

La build `3.5.2` e stata verificata realmente su Windows: 38/38 test superati, `npm run check` superato e installer NSIS generato con successo. La Release privata `registratore-v3.5.2` contiene `RiflessaRegistratore-Setup-3.5.2-x64.exe`.

**Firma Windows:** l'installer attuale e tecnicamente valido ma non e ancora firmato con un certificato Authenticode commerciale; Windows SmartScreen puo quindi mostrare "Autore sconosciuto". La firma puo essere aggiunta successivamente tramite Secret GitHub senza inserire il certificato nel repository.

## Configurazione GitHub Actions

La repository pubblica `Mirkolas/riflessahairbeauty-workflows` usa questi nomi esatti.

### Secrets

- `FIREBASE_SERVICE_ACCOUNT`: JSON del service account Firebase/GCP.
- `PUBLIC_REPO_TOKEN`: fine-grained PAT con `Contents: Read and write` sulla repository privata `Mirkolas/riflessahairbeauty`; viene usato anche per pubblicare le Release EXE private.
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
- sincronizzazione log incrementale;
- lettura ricorsiva Firestore;
- lettura Firebase Authentication con password hash;
- riconoscimento configurazione SCRYPT (`rounds=8`, `mem_cost=14`);
- backup completo reale con commit e push nella repository privata;
- decrittazione Authentication e dry-run non distruttivo del ripristino;
- pubblicazione reale delle Firestore Rules con ruolo IAM `Firebase Rules Admin`;
- deploy reale combinato `firestore:rules,hosting:registratore` completato con successo;
- build Windows x64 reale dell'installer Electron/NSIS;
- pubblicazione reale dell'EXE nella Release privata della repository applicativa.
