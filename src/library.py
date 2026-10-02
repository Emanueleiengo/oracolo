"""I testi dati in lettura all'Oracolo: libri, tesi, interviste (PDF e TXT).

Ogni testo messo nella cartella `testi/` viene letto e diviso in passi.

- TUTTI i passi finiscono nella "biblioteca" (tabella `passages`), con il
  loro vettore di similarita': l'Oracolo li consulta quando risponde.
- Una SELEZIONE dei passi piu' rappresentativi entra nella nebulosa: da
  ognuno si prende una frase, citata alla lettera, che diventa una entry con
  i suoi tag (scelti di preferenza tra i temi gia' presenti, cosi' si
  creano collegamenti con le stelle esistenti; altrimenti nasce una stella
  nuova: vedi themes.py). Le citazioni portano sempre titolo e autore.

Le frasi mostrate non vengono mai riscritte dall'IA: sono attribuite a un
autore, quindi devono essere parole sue.
"""

import hashlib
import json
import re
import unicodedata
from array import array
from collections import Counter
from pathlib import Path

from pypdf import PdfReader

from src import config, db_local, embeddings, themes
from src.logging_utils import get_logger

log = get_logger(__name__)

MANIFEST_NAME = "fonti.json"
# Versione del modo in cui i testi vengono letti e taggati: cambiandola, al
# prossimo `ingest` tutti i testi vengono riletti con il metodo nuovo.
INGEST_VERSION = 4
EXTENSIONS = {".pdf", ".txt"}
UNKNOWN_AUTHOR = "Autore sconosciuto"

# Lunghezza dei passi, in parole: si accumulano frasi fino al minimo, senza
# superare il massimo.
PASSAGE_MIN_WORDS = 90
PASSAGE_MAX_WORDS = 170
# Lunghezza di una frase citabile, in parole.
QUOTE_MIN_WORDS = 8
QUOTE_MAX_WORDS = 38

# Abbreviazioni dopo le quali il punto non chiude la frase.
_ABBREVIATIONS = {
    "p", "pp", "pag", "pagg", "cfr", "cf", "ecc", "etc", "es", "vol", "voll", "n", "nn",
    "cit", "op", "ibid", "id", "ed", "edd", "trad", "fig", "tav", "cap", "art", "sez",
    "prof", "dott", "dr", "sig", "ing", "avv", "mr", "mrs", "vs", "ca", "ss", "sg", "segg",
}
_SENTENCE_END = re.compile(r"(?<=[.!?…])[\"»”’)\]]*\s+(?=[\"«“‘(\[]?[A-ZÀ-Þ])")
# Segni di apparato (riferimenti, note, indirizzi) che rendono una frase
# inadatta a essere citata da sola.
_APPARATUS = re.compile(
    r"\b(cfr|ibid|ivi|op\. ?cit|et al|isbn|doi|http|www|pp?\.\s?\d)|[\[\]{}<>|©®=_/\\]|\d{2,}",
    re.IGNORECASE,
)


# Una frase che comincia con un titolo rimasto attaccato (nei PDF i titoli
# di capitolo non sono separati dal testo): due parole tutte maiuscole, o
# un'intestazione tipica.
_HEADING_START = re.compile(
    r"[\"«“‘]?(?:[A-ZÀ-Þ]{2,}\s+[A-ZÀ-Þ]{2,}"
    r"|(?:[IVXLCDM]{1,6}|\d{1,3})\.?\s+[\"«“‘]?[A-ZÀ-Þ]"  # numero di capitolo
    r"|(?:Capitolo|Parte|Sezione|Paragrafo|Introduzione|Premessa|Prefazione|Conclusion[ei]"
    r"|Appendice|Bibliografia|Indice|Nota|Abstract|Sommario)\b)"
)


# Legature tipografiche che i PDF restituiscono come un carattere solo.
_LIGATURES = {"ﬁ": "fi", "ﬂ": "fl", "ﬀ": "ff", "ﬃ": "ffi", "ﬄ": "ffl"}


# ── Lettura dei file ──

def _pdf_page_text(page) -> str:
    # La lettura "layout" rispetta la posizione dei caratteri: evita gli
    # spazi finti dentro le parole che la lettura semplice mette attorno alle
    # legature tipografiche ("de finisci"). Se fallisce si usa quella semplice.
    try:
        text = page.extract_text(extraction_mode="layout") or ""
    except Exception:  # noqa: BLE001 - dipende da come e' fatto il PDF
        text = ""
    return text if text.strip() else (page.extract_text() or "")


def _read_txt(path: Path) -> str:
    raw = path.read_bytes()
    for encoding in ("utf-8-sig", "utf-8", "cp1252"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1")


def _in_ranges(number: int, ranges: list[list[int]] | None) -> bool:
    return not ranges or any(first <= number <= last for first, last in ranges)


def _read_pages(path: Path, pages: list[list[int]] | None = None, lines: list[list[int]] | None = None) -> list[str]:
    """Il testo del file, una stringa per pagina (un TXT e' una sola pagina).
    `pages` (per i PDF) e `lines` (per i TXT) limitano la lettura a quegli
    intervalli, contati da 1 ed estremi inclusi: servono a lasciare fuori
    indici, note editoriali, bibliografie."""
    if path.suffix.lower() == ".pdf":
        reader = PdfReader(str(path))
        return [
            _pdf_page_text(page)
            for number, page in enumerate(reader.pages, start=1)
            if _in_ranges(number, pages)
        ]
    kept = [
        line
        for number, line in enumerate(_read_txt(path).splitlines(), start=1)
        if _in_ranges(number, lines)
    ]
    return ["\n".join(kept)]


def _line_key(line: str) -> str:
    return re.sub(r"\d+", "#", line.strip().lower())


def _flowing_text(pages: list[str]) -> str:
    """Testo continuo: toglie numeri di pagina e intestazioni ripetute,
    ricuce le parole spezzate a fine riga e unisce le righe."""
    page_lines = [[line.strip() for line in page.splitlines()] for page in pages]

    # Righe che si ripetono in cima o in fondo a molte pagine (titolo
    # corrente, autore, numero): non fanno parte del testo.
    edges: Counter = Counter()
    for lines in page_lines:
        filled = [line for line in lines if line]
        for line in filled[:1] + filled[-1:]:
            edges[_line_key(line)] += 1
    repeated = {key for key, n in edges.items() if n >= max(4, len(pages) // 5)}

    text = ""
    for lines in page_lines:
        filled = [i for i, line in enumerate(lines) if line]
        skip = {
            i for i in filled[:1] + filled[-1:]
            if _line_key(lines[i]) in repeated or lines[i].isdigit()
        }
        for i, line in enumerate(lines):
            if i in skip:
                continue
            if not line:
                if text and not text.endswith("\n\n"):
                    text = text.rstrip() + "\n\n"
            elif text.endswith("-") and line[:1].islower():
                text = text[:-1] + line  # parola spezzata a fine riga
            elif text and not text.endswith("\n\n"):
                text += " " + line
            else:
                text += line
    for ligature, letters in _LIGATURES.items():
        text = text.replace(ligature, letters)
    return re.sub(r"[ \t]+", " ", text).strip()


def _sentences(paragraph: str) -> list[str]:
    """Divide un paragrafo in frasi, senza spezzare dopo abbreviazioni e iniziali."""
    pieces = _SENTENCE_END.split(paragraph.strip())
    sentences: list[str] = []
    for piece in pieces:
        piece = piece.strip()
        if not piece:
            continue
        if sentences:
            last_word = sentences[-1].split()[-1].rstrip(".").strip("(\"«“").lower()
            if last_word in _ABBREVIATIONS or (len(last_word) == 1 and last_word.isalpha()):
                sentences[-1] += " " + piece
                continue
        sentences.append(piece)
    return sentences


def _looks_like_prose(text: str, max_digits: float = 0.06) -> bool:
    """Falso per righe di tabella, voci di bibliografia, numeri di pagina,
    indici: troppe cifre o troppo pochi caratteri alfabetici."""
    if not text:
        return False
    letters = sum(ch.isalpha() or ch.isspace() for ch in text)
    digits = sum(ch.isdigit() for ch in text)
    return letters / len(text) >= 0.8 and digits / len(text) <= max_digits and "...." not in text


def split_passages(text: str) -> list[str]:
    """Divide il testo in passi di lunghezza simile, senza tagliare le frasi."""
    passages: list[str] = []
    current: list[str] = []
    words = 0

    def close() -> None:
        nonlocal current, words
        if current:
            passages.append(" ".join(current))
        current, words = [], 0

    for paragraph in re.split(r"\n\s*\n", text):
        for sentence in _sentences(paragraph):
            # Tabelle, bibliografia e numeri sparsi non entrano nei passi.
            if not _looks_like_prose(sentence):
                continue
            n = len(sentence.split())
            if words and words + n > PASSAGE_MAX_WORDS:
                close()
            current.append(sentence)
            words += n
            if words >= PASSAGE_MIN_WORDS:
                close()
    # L'ultimo pezzo, se e' corto, si unisce al passo precedente.
    if current and passages and words < PASSAGE_MIN_WORDS // 3:
        passages[-1] += " " + " ".join(current)
    else:
        close()
    return [p for p in passages if len(p.split()) >= 12]


def quotable_sentences(passage: str, kind: str | None = None) -> list[str]:
    """Le frasi del passo che reggono da sole come citazione: complete, di
    lunghezza giusta, senza riferimenti, note o cifre."""
    quotable = []
    for sentence in _sentences(passage):
        words = sentence.split()
        if not QUOTE_MIN_WORDS <= len(words) <= QUOTE_MAX_WORDS:
            continue
        # In una tesi una frase tra virgolette e' quasi sempre di un altro
        # autore, citato: non va attribuita a chi ha scritto la tesi.
        if kind == "tesi" and re.search(r"[\"«»“”]", sentence):
            continue
        if not re.match(r"[\"«“‘]?[A-ZÀ-Þ]", sentence) or not re.search(r"[.!?…][\"»”’]?$", sentence):
            continue
        if _APPARATUS.search(sentence) or _HEADING_START.match(sentence):
            continue
        if not _looks_like_prose(sentence, max_digits=0):
            continue
        if sentence.count("«") != sentence.count("»") or sentence.count("“") != sentence.count("”"):
            continue
        if sentence.count("(") != sentence.count(")") or sentence.count('"') % 2:
            continue
        quotable.append(sentence)
    return quotable


# ── Scelta dei passi che entrano nella nebulosa ──

def _centroid(vectors: list[array]) -> array:
    return embeddings.normalized([sum(column) for column in zip(*vectors)])


def _themes(vectors: list[array], count: int, rounds: int = 8) -> list[array]:
    """Raggruppa i passi per significato (k-means su vettori normalizzati) e
    ritorna il centro di ogni gruppo: sono i temi principali del testo."""
    # Si parte dal passo piu' vicino alla media, poi ogni volta dal passo
    # piu' lontano dai centri gia' scelti: partenza stabile e ben sparsa.
    mean = _centroid(vectors)
    centers = [max(vectors, key=lambda v: embeddings.similarity(v, mean))]
    closest = [embeddings.similarity(v, centers[0]) for v in vectors]
    while len(centers) < count:
        index = min(range(len(vectors)), key=closest.__getitem__)
        centers.append(vectors[index])
        closest = [max(c, embeddings.similarity(v, centers[-1])) for c, v in zip(closest, vectors)]

    for _ in range(rounds):
        groups: list[list[array]] = [[] for _ in centers]
        for vector in vectors:
            best = max(range(len(centers)), key=lambda i: embeddings.similarity(vector, centers[i]))
            groups[best].append(vector)
        centers = [_centroid(group) if group else center for group, center in zip(groups, centers)]
    return centers


# ── Quale frase regge da sola ──
# Una citazione entra nella nebulosa accanto ai pensieri delle persone, e
# viene letta senza il resto del testo. Regge da sola se esprime un pensiero
# generale (di solito al presente); non regge se racconta un fatto al
# passato, rimanda ad altro o parla di personaggi noti solo a chi ha letto.
# Il giudizio guarda alla forma della frase: e' grossolano ma stabile, e non
# riscrive nulla.
_PAST_WORDS = {
    "era", "ero", "eri", "erano", "eravamo", "fu", "fui", "furono", "ebbe", "ebbi", "ebbero",
    "disse", "dissi", "dissero", "chiese", "chiesi", "rispose", "risposi", "vide", "vidi",
    "fece", "feci", "fecero", "prese", "presi", "venne", "venni", "mise", "misi", "stette",
    "aveva", "avevo", "avevano", "avevamo", "stava", "stavo", "stavano",
    # passati remoti irregolari
    "diressi", "diresse", "scrissi", "scrisse", "lessi", "lesse", "vissi", "visse", "corsi",
    "chiusi", "chiuse", "scesi", "scese", "rimasi", "rimase", "risi", "rise", "decisi", "decise",
    "sorrisi", "sorrise", "piansi", "pianse", "giunsi", "giunse", "tenni", "tenne", "volli",
    "volle", "seppi", "seppe", "caddi", "cadde", "nacqui", "nacque", "parve", "apparve",
    "accorsi", "accorse", "scossi", "scosse", "spensi", "spense", "accesi", "accese",
    "aprii", "tacque", "tacqui", "bevvi", "bevve", "ruppi", "ruppe", "conobbi", "conobbe",
}
_NOT_PAST = {
    "però", "ciò", "può", "perciò", "così", "lì", "sì", "dì", "ormai", "assai", "semmai",
    "giammai", "brava", "bravo", "schiava", "schiavo", "operai", "marinai", "lunedì",
    "martedì", "mercoledì", "giovedì", "venerdì",
}
_GENERAL = {
    "ogni", "tutti", "tutto", "tutte", "nessuno", "nessuna", "sempre", "mai", "chi", "chiunque",
    "vita", "tempo", "mondo", "uomo", "uomini", "persone", "gente", "amore", "morte", "paura",
    "felicità", "libertà", "verità", "bellezza", "dolore", "anima", "cuore", "silenzio",
    "senso", "futuro", "memoria", "desiderio", "sogno", "sogni", "cambiamento", "natura",
}
_PRESENT = {
    "è", "sono", "siamo", "sei", "c'è", "puoi", "può", "possiamo", "possono", "devi", "deve",
    "dobbiamo", "bisogna", "significa", "serve", "esiste", "esistono", "diventa", "resta",
}
_SECOND_PERSON = {"tu", "ti", "te", "tuo", "tua", "tuoi", "tue", "noi", "ci", "nostro", "nostra"}
_META = {
    "capitolo", "paragrafo", "tesi", "elaborato", "figura", "tabella", "pagina", "pagine",
    "vedremo", "analizzeremo", "affrontare", "esplorare", "precedente", "successivo", "seguito",
}
_LEANING_START = {
    "questo", "questa", "questi", "queste", "quello", "quella", "quelli", "quelle", "ciò",
    "lui", "lei", "loro", "poi", "allora", "infatti", "inoltre", "quindi", "dunque", "così",
    "ma", "e", "perché", "però", "anche", "ne", "ed", "oppure", "invece", "insomma",
}
THOUGHT_THRESHOLD = 2


def _is_past(word: str) -> bool:
    """Vero per le forme tipiche del racconto: passato remoto e imperfetto."""
    if word in _NOT_PAST:
        return False
    if word in _PAST_WORDS:
        return True
    if len(word) >= 6 and word.endswith(("arono", "erono", "irono")):
        return True
    if len(word) >= 5 and word.endswith(("ava", "avo", "avano", "avamo", "eva", "evo", "evano", "evamo")):
        return True
    if len(word) >= 4 and (word.endswith(("ì", "ii")) or (word.endswith("ò") and not word.endswith("rò"))):
        return True
    return len(word) >= 5 and word.endswith("ai") and not word.endswith("rai")


def thought_score(sentence: str) -> int:
    """Quanto una frase regge da sola come pensiero: piu' e' alto, meglio
    e'. Negativo per racconto, rimandi e frasi appoggiate ad altro."""
    raw_words = re.findall(r"[\w'’]+", sentence)
    words = [w.lower().replace("’", "'") for w in raw_words]
    if not words or any(_is_past(w) for w in words):
        return -5
    score = min(3, len(_GENERAL.intersection(words))) * 2
    score += 1 if _PRESENT.intersection(words) else 0
    score += 1 if _SECOND_PERSON.intersection(words) else 0
    # Nomi propri in mezzo alla frase: di solito personaggi del libro.
    score -= min(2, sum(1 for w in raw_words[1:] if w[:1].isupper()))
    score -= 3 if _META.intersection(words) else 0
    score -= 2 if words[0] in _LEANING_START else 0
    return score


# Da quanti passi, tra i piu' vicini a un tema, cercare la frase da citare.
PICK_PASSAGES = 3


def choose_fragments(passages: list[str], vectors: list[array], count: int, kind: str | None = None) -> list[dict]:
    """Sceglie fino a `count` frasi da citare, una per ciascuno dei temi
    principali del testo. Ritorna [{"index", "text"}], dove `index` e' il
    passo da cui la frase e' tratta."""
    candidates = {i: quotable_sentences(p, kind) for i, p in enumerate(passages)}
    eligible = [i for i, sentences in candidates.items() if sentences]
    if not eligible:
        return []
    # Un'intervista e' breve ed e' gia' fatta di risposte: se ne prende
    # comunque la frase migliore. Di un libro si tiene solo cio' che regge.
    threshold = None if kind == "intervista" else THOUGHT_THRESHOLD

    # Si cercano piu' temi delle citazioni volute: non tutti hanno una frase
    # che regge da sola (in un romanzo molti passi sono solo racconto).
    themes = _themes(vectors, min(len(passages), count * 2))
    fragments: list[dict] = []
    used: set[int] = set()
    for center in themes:
        near = sorted(
            (i for i in eligible if i not in used),
            key=lambda i: embeddings.similarity(vectors[i], center),
            reverse=True,
        )[:PICK_PASSAGES]
        options = [(thought_score(sentence), i, sentence) for i in near for sentence in candidates[i]]
        if not options:
            continue
        score, index, sentence = max(options, key=lambda option: option[0])
        if threshold is not None and score < threshold:
            continue
        used.add(index)
        fragments.append({"index": index, "text": sentence})
        if len(fragments) >= count:
            break
    return sorted(fragments, key=lambda fragment: fragment["index"])


# ── Caricamento ──

def _ingest(job: dict, index: themes.ThemeIndex) -> dict:
    """Carica un testo gia' letto: biblioteca + citazioni nella nebulosa.
    `job` viene da `_jobs`; `index` sono i temi della nebulosa, che le
    citazioni caricate via via arricchiscono."""
    key, title, author, kind = job["key"], job["title"], job["author"], job["kind"]
    passages = split_passages(job["text"])
    if not passages:
        raise ValueError(
            f"nessun testo leggibile in '{key}' (se e' un PDF fatto di immagini "
            "scansionate va prima convertito in testo)"
        )
    log.info("'%s' (%s): %d passi, calcolo i vettori di similarita'...", title, author, len(passages))
    vectors = embeddings.embed_texts(passages)
    # L'impronta si registra solo alla fine (vedi finish_source).
    source_id = db_local.replace_source(key, title, author, kind, "")
    passage_ids = db_local.insert_passages(
        source_id,
        [
            {"text": passage, "model": config.OLLAMA_EMBED_MODEL, "vector": vector.tobytes()}
            for passage, vector in zip(passages, vectors)
        ],
    )

    fragments = choose_fragments(passages, vectors, job["stars"], kind)
    log.info("%d citazioni scelte per la nebulosa: assegno i temi...", len(fragments))
    for fragment in fragments:
        fragment["id"] = db_local.FRAGMENT_ID_BASE + passage_ids[fragment["index"]]
    db_local.insert_fragments(
        source_id,
        [{"passage_id": passage_ids[f["index"]], "text": f["text"]} for f in fragments],
    )
    quote_vectors = embeddings.embed_texts([f["text"] for f in fragments])
    db_local.upsert_entry_embeddings(
        [
            {
                "entry_id": fragment["id"],
                "model": config.OLLAMA_EMBED_MODEL,
                "text_hash": embeddings.text_hash(fragment["text"]),
                "vector": vector.tobytes(),
            }
            for fragment, vector in zip(fragments, quote_vectors)
        ]
    )
    for fragment, vector in zip(fragments, quote_vectors):
        db_local.set_entry_tags(fragment["id"], themes.assign(fragment["text"], vector, index))
    db_local.finish_source(source_id, job["content_hash"])
    return {"file": key, "title": title, "author": author, "passages": len(passages), "fragments": len(fragments)}


# ── Raccolte di interviste ──
# Un file con piu' interviste trascritte, ognuna introdotta da una riga
# "Fonte Audio N: ..." e da "Intervistato/a: Nome (ruolo)". Di ogni intervista
# contano solo le risposte della trascrizione fedele: le sintesi sono scritte
# da altri e non vanno attribuite all'intervistato.
_INTERVIEW_START = re.compile(r"^Fonte Audio \d+:")
_INTERVIEWEE = re.compile(r"Intervistat[oa](?:/a)?:\s*([^(|]+?)\s*(?:\(([^)]*)\))?\s*$")
_TRANSCRIPT_START = re.compile(r"^TRASCRIZIONE\b", re.IGNORECASE)
_SPEAKER = re.compile(r"^([^:]{2,50}):\s+(.*)$")
_INTERVIEWERS = {"intervistatore", "intervistatrice", "intervistatori", "domanda", "moderatore"}


def read_interviews(path: Path) -> list[dict]:
    """Le interviste di una raccolta: [{"author", "role", "text"}], dove
    `text` sono le sole risposte dell'intervistato. Se una persona compare
    piu' volte (il file ripete le trascrizioni) vale la prima."""
    interviews: dict[str, dict] = {}
    lines = _read_txt(path).splitlines()
    starts = [i for i, line in enumerate(lines) if _INTERVIEW_START.match(line.strip())]
    for start, end in zip(starts, starts[1:] + [len(lines)]):
        block = [line.strip() for line in lines[start:end]]
        who = next((m for line in block[:4] if (m := _INTERVIEWEE.search(line))), None)
        if not who:
            continue
        author = who.group(1).strip()
        if author in interviews:
            continue
        answers: list[str] = []
        in_transcript = False
        interviewee_speaking = True
        for line in block:
            if _TRANSCRIPT_START.match(line):
                in_transcript = True
                continue
            if not in_transcript or not line:
                continue
            speaker = _SPEAKER.match(line)
            label = speaker.group(1).strip() if speaker else ""
            if label.lower() in _INTERVIEWERS:
                interviewee_speaking = False
                continue
            # Un'etichetta breve fatta di nomi propri e' chi prende la parola;
            # altrimenti i due punti fanno parte della frase.
            if speaker and len(label.split()) <= 4 and all(w[:1].isupper() for w in label.split()):
                interviewee_speaking = True
                line = speaker.group(2)
            if interviewee_speaking:
                answers.append(line)
        if answers:
            interviews[author] = {"author": author, "role": who.group(2) or "", "text": "\n\n".join(answers)}
    return list(interviews.values())


def _jobs(path: Path, meta: dict, stars: int | None) -> list[dict]:
    """I testi contenuti in un file (uno solo, tranne che per le raccolte di
    interviste), pronti da caricare. `meta` viene da `metadata_for`."""
    stars = meta.get("stars") or stars or config.LIBRARY_STARS_PER_SOURCE
    if meta.get("format") == "interviste":
        texts = [
            {"key": f"{path.name}#{item['author']}", "author": item["author"], "text": item["text"]}
            for item in read_interviews(path)
        ]
    else:
        pages = _read_pages(path, meta.get("pages"), meta.get("lines"))
        texts = [{"key": path.name, "author": meta["author"], "text": _flowing_text(pages)}]
    for item in texts:
        item.update(title=meta["title"], kind=meta.get("kind"), stars=stars)
        # Cambia se cambia il testo, la sua attribuzione o il modo di leggerlo.
        item["content_hash"] = embeddings.text_hash(
            f"{INGEST_VERSION}|{meta['title']}|{item['author']}|{stars}|{item['text']}"
        )
    return texts


def _manifest(folder: Path) -> dict[str, dict]:
    """Titoli e autori dichiarati in testi/fonti.json:
    [{"file": "...", "title": "...", "author": "...", "kind": "libro"}].
    Facoltativi: "pages" (PDF) o "lines" (TXT) con gli intervalli da leggere,
    "stars" (citazioni che entrano nella nebulosa), "format": "interviste"
    per un file che raccoglie piu' interviste."""
    path = folder / MANIFEST_NAME
    if not path.exists():
        return {}
    return {_name_key(item["file"]): item for item in json.loads(path.read_text(encoding="utf-8"))}


def _name_key(name: str) -> str:
    """Nome di file confrontabile: le lettere accentate possono arrivare in
    due forme diverse (una sola lettera, oppure lettera + accento) a seconda
    del sistema e di come il file e' stato copiato."""
    return unicodedata.normalize("NFC", name).strip().casefold()


def metadata_for(path: Path, manifest: dict[str, dict]) -> dict:
    """Titolo, autore e opzioni di un file: da fonti.json, altrimenti dal
    nome del file nella forma "Autore - Titolo"."""
    declared = manifest.get(_name_key(path.name))
    if declared:
        return {**declared, "author": declared.get("author") or UNKNOWN_AUTHOR}
    author, separator, title = path.stem.partition(" - ")
    if separator:
        return {"title": title.strip(), "author": author.strip(), "kind": None}
    return {"title": path.stem.strip(), "author": UNKNOWN_AUTHOR, "kind": None}


def ingest_all(stars: int | None = None) -> list[dict]:
    """Carica i testi nuovi o cambiati della cartella. Quelli gia' letti, e
    identici, vengono saltati."""
    db_local.init_db()
    folder = Path(config.TEXTS_DIR)
    manifest = _manifest(folder)
    files = sorted(p for p in folder.glob("*") if p.suffix.lower() in EXTENSIONS)
    results: list[dict] = []
    jobs: list[dict] = []
    for path in files:
        for job in _jobs(path, metadata_for(path, manifest), stars):
            known = db_local.get_source_by_file(job["key"])
            if known is not None and known["file_hash"] == job["content_hash"]:
                results.append({"file": job["key"], "skipped": "gia' letto"})
            else:
                jobs.append(job)
    if not jobs:
        return results

    # Le versioni precedenti dei testi da rileggere escono dalla nebulosa
    # prima di calcolare i temi, per non lasciarvi dentro i loro vecchi tag.
    for job in jobs:
        db_local.delete_source(job["key"])
    people = [e for e in db_local.get_entries_with_tags() if e["tags"]]
    embeddings.ensure_entry_embeddings(people)
    index = themes.ThemeIndex()
    for job in jobs:
        try:
            results.append(_ingest(job, index))
        except ValueError as error:
            log.warning("%s", error)
            results.append({"file": job["key"], "skipped": str(error)})
    return results
