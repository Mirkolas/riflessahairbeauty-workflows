# Riflessa — workflow di rilascio

Questa repository contiene i workflow pubblici di automazione. Il codice applicativo e gli eseguibili del registratore restano nella repository privata autorizzata.

## Rilascio Windows

Il workflow `build-exe-registratore.yml` rileva una nuova versione e costruisce il commit sorgente esatto. Esegue installazione riproducibile delle dipendenze, audit per vulnerabilita alte o critiche, test automatici, controlli di progetto e preflight. Genera portable e installer NSIS, verifica firma e SHA512 e pubblica la release privata e il canale aggiornamenti.

Una versione gia pubblicata completamente non viene ricostruita a ogni esecuzione. Per rilasciare una nuova versione aggiornare package.json e lockfile nella repository applicativa. L'interfaccia desktop viene caricata localmente da Electron.

Configurazione operativa, procedure e risultati dettagliati di verifica sono mantenuti nella documentazione privata. Il collaudo fiscale sul dispositivo fisico e necessario prima della vendita.
