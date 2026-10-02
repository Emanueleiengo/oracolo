"""I testi dati in lettura all'Oracolo: libri, tesi, interviste (PDF e TXT).

Ogni testo messo nella cartella `testi/` viene letto e diviso in passi.

- TUTTI i passi finiscono nella "biblioteca" (tabella `passages`), con il
  loro vettore di similarita': l'Oracolo li consulta quando risponde.
- Una SELEZIONE dei passi piu' rappresentativi entra nella nebulosa: da
  ognuno si prende una frase, citata alla lettera, che diventa una entry con
  i suoi tag (scelti di preferenza tra i temi gia' presenti, cosi' si
  creano collegamenti con le stelle esistenti; altrimenti nasce una stella
  nuova). Le citazioni portano sempre titolo e autore.

Le frasi mostrate non vengono mai riscritte dall'IA: sono attribuite a un
autore, quindi devono essere parole sue.
"""

import hashlib
import json
import re
from array import array
from collections import Counter
from pathlib import Path

from pypdf import PdfReader

from src import config, db_local, embeddings, tagging
from src.logging_utils import get_logger

log = get_logger(__name__)

MANIFEST_NAME = "fonti.json"
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
    r"|(?:Capitolo|Parte|Sezione|Paragrafo|Introduzione|Premessa|Prefazione|Conclusion[ei]"
    r"|Appendice|Bibliografia|Indice|Nota|Abstract|Sommario)\b)"
)


# ── Lettura dei file ──

def _read_pages(path: Path) -> list[str]:
    """Il testo del file, una stringa per pagina (un TXT e' una sola pagina)."""
    if path.suffix.lower() == ".pdf":
        reader = PdfReader(str(path))
        return [page.extract_text() or "" for page in reader.pages]
    raw = path.read_bytes()
    for encoding in ("utf-8-sig", "utf-8", "cp1252"):
        try:
            return [raw.decode(encoding)]
        except UnicodeDecodeError:
            continue
    return [raw.decode("latin-1")]


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
    return [p for p in passages if len(p.split()) >= 20]


def quotable_sentences(passage: str) -> list[str]:
    """Le frasi del passo che reggono da sole come citazione: complete, di
    lunghezza giusta, senza riferimenti, note o cifre."""
    quotable = []
    for sentence in _sentences(passage):
        words = sentence.split()
        if not QUOTE_MIN_WORDS <= len(words) <= QUOTE_MAX_WORDS:
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


def choose_fragments(passages: list[str], vectors: list[array], count: int) -> list[dict]:
    """Sceglie fino a `count` passi rappresentativi dei temi del testo e, da
    ognuno, la frase da citare. Ritorna [{"index", "text"}]."""
    candidates = {i: quotable_sentences(p) for i, p in enumerate(passages)}
    eligible = [i for i, sentences in candidates.items() if sentences]
    if not eligible:
        return []
    count = min(count, len(eligible))

    chosen: dict[int, array] = {}  # indice del passo -> centro del suo tema
    for center in _themes(vectors, count):
        ranked = sorted(eligible, key=lambda i: embeddings.similarity(vectors[i], center), reverse=True)
        index = next((i for i in ranked if i not in chosen), None)
        if index is not None:
            chosen[index] = center

    # In ogni passo scelto, la frase che meglio ne esprime il tema.
    flat = [(index, sentence) for index in chosen for sentence in candidates[index]]
    sentence_vectors = embeddings.embed_texts([sentence for _, sentence in flat])
    best: dict[int, tuple[float, str]] = {}
    for (index, sentence), vector in zip(flat, sentence_vectors):
        score = embeddings.similarity(vector, chosen[index])
        if index not in best or score > best[index][0]:
            best[index] = (score, sentence)
    return [{"index": index, "text": best[index][1]} for index in sorted(best)]


# ── Caricamento ──

def _file_hash(path: Path) -> str:
    return hashlib.sha1(path.read_bytes()).hexdigest()


def _vocabulary(limit: int = 250) -> list[str]:
    """I temi gia' presenti nella nebulosa, dai piu' usati."""
    counts = Counter(tag for entry in db_local.get_entries_with_tags() for tag in entry["tags"])
    return [tag for tag, _ in counts.most_common(limit)]


def ingest_file(path: Path, title: str, author: str, kind: str | None = None, stars: int | None = None) -> dict:
    """Legge un testo e lo carica: biblioteca + citazioni nella nebulosa.
    Se il file era gia' stato caricato, la versione precedente viene sostituita."""
    stars = config.LIBRARY_STARS_PER_SOURCE if stars is None else stars
    db_local.init_db()
    log.info("Leggo '%s' (%s, %s)...", path.name, author, title)
    passages = split_passages(_flowing_text(_read_pages(path)))
    if not passages:
        raise ValueError(
            f"nessun testo leggibile in '{path.name}' (se e' un PDF fatto di immagini "
            "scansionate va prima convertito in testo)"
        )

    log.info("%d passi: calcolo i vettori di similarita'...", len(passages))
    vectors = embeddings.embed_texts(passages)
    source_id = db_local.replace_source(path.name, title, author, kind, _file_hash(path))
    passage_ids = db_local.insert_passages(
        source_id,
        [
            {"text": text, "model": config.OLLAMA_EMBED_MODEL, "vector": vector.tobytes()}
            for text, vector in zip(passages, vectors)
        ],
    )

    fragments = choose_fragments(passages, vectors, stars)
    log.info("%d citazioni scelte per la nebulosa: assegno i tag...", len(fragments))
    vocabulary = _vocabulary()
    db_local.insert_fragments(
        source_id,
        [{"passage_id": passage_ids[f["index"]], "text": f["text"]} for f in fragments],
    )
    tagged = 0
    for fragment in fragments:
        entry_id = db_local.FRAGMENT_ID_BASE + passage_ids[fragment["index"]]
        tags = tagging.tags_for_fragment(fragment["text"], passages[fragment["index"]], vocabulary)
        if tags:
            db_local.set_entry_tags(entry_id, tags)
            tagged += 1
    embeddings.ensure_entry_embeddings(
        [e for e in db_local.get_entries_with_tags() if e["tags"]]
    )
    return {
        "file": path.name,
        "title": title,
        "author": author,
        "passages": len(passages),
        "fragments": tagged,
    }


def _manifest(folder: Path) -> dict[str, dict]:
    """Titoli e autori dichiarati in testi/fonti.json:
    [{"file": "...", "title": "...", "author": "...", "kind": "libro"}]."""
    path = folder / MANIFEST_NAME
    if not path.exists():
        return {}
    return {item["file"]: item for item in json.loads(path.read_text(encoding="utf-8"))}


def metadata_for(path: Path, manifest: dict[str, dict]) -> dict:
    """Titolo e autore di un file: da fonti.json, altrimenti dal nome del
    file nella forma "Autore - Titolo"."""
    declared = manifest.get(path.name)
    if declared:
        return {
            "title": declared["title"],
            "author": declared.get("author") or UNKNOWN_AUTHOR,
            "kind": declared.get("kind"),
        }
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
    results = []
    for path in files:
        meta = metadata_for(path, manifest)
        known = db_local.get_source_by_file(path.name)
        unchanged = (
            known is not None
            and known["file_hash"] == _file_hash(path)
            and (known["title"], known["author"]) == (meta["title"], meta["author"])
        )
        if unchanged:
            results.append({"file": path.name, "skipped": "gia' letto"})
            continue
        try:
            results.append(ingest_file(path, meta["title"], meta["author"], meta["kind"], stars))
        except ValueError as error:
            log.warning("%s", error)
            results.append({"file": path.name, "skipped": str(error)})
    return results
