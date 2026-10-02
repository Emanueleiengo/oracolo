# Oracolo

Sincronizza le entry di un DB MySQL online (tramite un endpoint PHP
sul hosting) in un archivio locale SQLite, le tagga tramite un modello
generativo su Ollama (in rete), e le mostra come una nebulosa di nodi
interattiva ("La Nebulosa", frontend React in `layoutBoltNebulosa/project`)
basata sui tag condivisi tra le entry.

## Setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # poi compila le variabili
```

Carica anche [hosting/api/export.php](hosting/api/export.php) nella stessa
cartella del `config.php` esistente sul server (vedi commento in testa al
file per l'unica cosa da adattare: il nome della tabella).

Per il frontend, la prima volta:

```bash
cd layoutBoltNebulosa/project
npm install
npm run build   # genera dist/, servito da `python -m src.main serve`
```

Va ricostruito (`npm run build`) ogni volta che si modifica il codice React;
i dati (tag/entry) invece sono live, letti dal server Python ad ogni richiesta.

## Uso

```bash
python -m src.main sync      # scarica/aggiorna le entry dalla sorgente remota
python -m src.main tag       # tagga le entry nuove/modificate via Ollama
python -m src.main embed     # prepara le entry per l'Oracolo (vettori di similarita')
python -m src.main ingest    # fa leggere all'Oracolo i PDF e i TXT nella cartella testi/
python -m src.main pipeline  # sync + tag + embed, una volta
python -m src.main run       # come pipeline, ma in loop ogni SYNC_INTERVAL_MINUTES
python -m src.main serve     # avvia il webserver locale (frontend + API)
python -m src.main seed      # inserisce dati di prova gia' taggati (per testare la nebulosa)
```

Apri `http://localhost:8000/` (con `serve` avviato) per esplorare la nebulosa
dei tag. In basso c'e' l'area delle domande: alcune suggerite e la barra per
scrivere la propria. Fatta la domanda, la nebulosa ti porta al suo interno e
si ferma sulla stella che raccoglie i pensieri piu' vicini: la stella pulsa
e nella scheda accanto compare la risposta dell'Oracolo. Da li' puoi fare
un'altra domanda oppure viaggiare nella nebulosa: ogni altra stella che apri
risponde alla tua domanda a modo suo. La stessa barra cerca anche i tag per
nome; nella scheda si vedono i frammenti della stella e i tag collegati.

Il server espone anche endpoint JSON usati dal frontend:
- `GET /api/graph` — nodi (tag) e archi (co-occorrenze) dell'intero grafo
- `GET /api/tag/<nome>` — frammenti e tag collegati per un singolo tag
- `GET /api/questions` — domande evocative generate al volo da Ollama, usate da `question.html`
- `GET /api/suggestions` — alcune domande da proporre a chi entra
- `POST /api/ask` — domanda del visitatore (`{"question": "..."}`): ritorna la stella a
  cui portarlo, le stelle da attraversare, la risposta dell'Oracolo e i pensieri piu' vicini
- `GET /api/oracle/question?tag=<nome>&trail=<tappe,precedenti>` — domanda che
  l'Oracolo fa a chi si ferma su una stella
- `GET /api/health` — stato del server e di Ollama: dice in chiaro cosa manca se l'Oracolo non risponde
- `POST /api/answer` — testo oracolare (`{"question": "<facoltativa>", "tag": "<stella>"}`):
  la risposta alla domanda vista da quella stella o, senza domanda, una sentenza sul suo tema

Apri `http://localhost:8000/question.html` per "l'Oracolo": una domanda
generata al volo (serve Ollama raggiungibile), con un pulsante per rerollare
tra quelle gia' ricevute e uno per chiedere una risposta criptica. Raggiungibile
anche dal pulsante a forma di stella nell'header della Nebulosa.

## Testi letti dall'Oracolo

Oltre ai pensieri delle persone, l'Oracolo puo' leggere libri, tesi e
interviste. Metti i file (PDF o TXT) nella cartella `testi/` e lancia
`python -m src.main ingest`:

- **tutto** il testo viene diviso in passi e finisce in una biblioteca che
  l'Oracolo consulta quando risponde;
- una **selezione** dei passi piu' rappresentativi (40 per testo, vedi
  `LIBRARY_STARS_PER_SOURCE` o `--stars`) entra nella nebulosa: da ognuno si
  prende una frase, citata alla lettera, con i suoi tag. I tag vengono scelti
  di preferenza tra i temi gia' presenti, cosi' la citazione si collega alle
  stelle esistenti; altrimenti nasce una stella nuova.

Le citazioni mostrano sempre autore e titolo. Si ricavano dal nome del file
(`Autore - Titolo.pdf`) oppure da `testi/fonti.json`:

```json
[{"file": "calvino.pdf", "title": "Le citta' invisibili", "author": "Italo Calvino", "kind": "libro"}]
```

I file dei testi non sono versionati (sono opere altrui): in git entra solo
`fonti.json`. `ingest --list` elenca i testi letti, `ingest --forget <file>`
ne toglie uno. I PDF fatti di sole immagini scansionate non contengono testo
e vanno prima convertiti.

## Note

- `OLLAMA_EMBED_MODEL` (bge-m3) misura la similarita' di significato tra una
  domanda e le entry: serve all'Oracolo per scegliere la stella e i pensieri
  a cui ispirarsi. I vettori delle entry si calcolano da soli alla prima
  domanda (qualche decina di secondi) e restano nel DB locale.
  `OLLAMA_TAG_MODEL` (un modello generativo, es. llama3.1) scrive i tag, le
  domande e le risposte.
- Il DB locale (`data/local.db`) non e' versionato: verra' ricreato al
  primo `sync`.
- `layoutBoltNebulosa/project` era in origine un progetto Bolt.new basato
  su Supabase (sorgenti/connessioni/history inserite a mano); e' stato
  adattato per leggere in sola lettura il grafo dei tag di Oracolo dal
  webserver Python locale, al posto di un database Supabase remoto.
