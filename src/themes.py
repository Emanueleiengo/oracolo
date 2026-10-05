"""I temi (tag) da dare alle citazioni tratte dai testi.

Far inventare liberamente i tag al modello produce doppioni e temi lunghi
una riga. Qui invece:

1. si cercano, per similarita' di significato, i temi gia' presenti nella
   nebulosa piu' vicini alla citazione (il "centro" di un tema e' la media
   dei vettori dei pensieri delle persone che lo usano);
2. il modello sceglie tra quei pochi quali la descrivono davvero: cosi' la
   citazione si collega alle stelle che esistono;
3. solo se nessun tema esistente e' abbastanza vicino, il modello propone
   una parola nuova, da cui nasce una stella nuova (che le citazioni
   successive potranno a loro volta riusare).
"""

import json
import math
import os
import re
import unicodedata
from array import array
from difflib import get_close_matches

from src import config, db_local, embeddings, ollama
from src.logging_utils import get_logger

log = get_logger(__name__)

# Quanti temi vicini proporre al modello, e quanti al massimo puo' sceglierne.
CANDIDATES = 6
MAX_PICKS = 2
# I temi molto diffusi (consapevolezza, cambiamento...) sono vicini a quasi
# tutto: tra i candidati si da' un piccolo vantaggio ai temi piu' specifici,
# altrimenti poche stelle enormi si prenderebbero tutte le citazioni.
SPECIFICITY_BONUS = 0.07
WIDE_NET = 14
# Sotto questa similarita' col tema piu' vicino, la citazione parla di
# qualcosa che la nebulosa non ha ancora: si chiede un tema nuovo.
NEW_THEME_BELOW = 0.60
# Una stella non riceve piu' di questa parte delle citazioni (ma almeno
# QUOTE_CAP_MIN): un tema largo ("filosofia") calza a quasi tutto, e senza
# un tetto si prenderebbe una citazione su quattro. Raggiunto il tetto, il
# modello sceglie tra gli altri temi vicini.
QUOTE_SHARE_CAP = 0.08
QUOTE_CAP_MIN = 8

PICK_PROMPT = """Una frase sta per entrare in una nebulosa di pensieri, dove ogni tema e' una stella.

Frase:
\"\"\"{text}\"\"\"

Temi gia' presenti che potrebbero riguardarla:
{themes}

Scegli i temi (uno o due) che descrivono davvero cio' di cui la frase parla. Tra due temi \
adatti preferisci quello piu' preciso.

Rispondi SOLO con un oggetto JSON con la chiave "temi" e, come valore, la lista dei numeri \
dei temi scelti."""

NEW_THEME_PROMPT = """Di che cosa parla questa frase? Proponi tre temi diversi, dal piu' adatto al \
meno adatto. Ogni tema e' UNA sola parola: un sostantivo comune, al singolare, in minuscolo. Scrivi \
solo le tre parole, separate da virgole.

Frase:
\"\"\"{text}\"\"\""""

_WORD = re.compile(r"^[a-zà-ÿ]{3,18}$")
# Parole che andrebbero bene per qualsiasi frase: come stelle non dicono nulla.
# Il modello tende a sceglierle quando compaiono nella frase ("quella situazione").
_GENERIC = {
    "fatto", "situazione", "descrizione", "cosa", "modo", "parte", "tipo", "caso", "aspetto",
    "elemento", "esempio", "concetto", "argomento", "questione", "oggetto", "fenomeno",
    "contesto", "punto", "livello", "forma", "maniera", "genere", "volta", "qualcosa",
    "niente", "nulla", "nessuno", "none", "persona", "frase", "testo", "tema", "parola",
    "sostantivo",
}


class ThemeIndex:
    """I temi della nebulosa con il loro centro, aggiornabile mentre si caricano i testi.

    Il centro di un tema lo fanno solo i pensieri delle persone che lo usano.
    Le citazioni non lo spostano: per lo stile si somigliano tutte, e un tema
    che ne raccogliesse si avvicinerebbe a tutte le successive e se le
    prenderebbe (succedeva a "consapevolezza" e "cambiamento"). Per lo stesso
    motivo un tema nato dai testi non ha un centro e non viene proposto per
    somiglianza: si riusa solo quando il modello lo ripropone per nome."""

    def __init__(self) -> None:
        self._sums: dict[str, list[float]] = {}
        self._centers: dict[str, array] = {}
        self._uses: dict[str, int] = {}
        self._total = 0
        self._quote_uses: dict[str, int] = {}
        self._quotes = 0
        vectors = embeddings.load_entry_vectors()
        for entry in db_local.get_entries_with_tags():
            if entry["source"] is not None:
                self.add_quote(entry["tags"])
            elif entry["id"] in vectors:
                for tag in entry["tags"]:
                    self.add(tag, vectors[entry["id"]])

    def __contains__(self, tag: str) -> bool:
        return tag in self._uses

    def names(self) -> list[str]:
        return list(self._uses)

    def _count(self, tag: str) -> None:
        self._uses[tag] = self._uses.get(tag, 0) + 1
        self._total += 1

    def add(self, tag: str, vector: array) -> None:
        """Un pensiero di una persona in piu' usa questo tema (che nasce, se
        non c'era): il centro del tema si sposta verso di lui."""
        self._count(tag)
        total = self._sums.get(tag)
        self._sums[tag] = list(vector) if total is None else [a + b for a, b in zip(total, vector)]
        self._centers.pop(tag, None)

    def add_quote(self, tags: list[str]) -> None:
        """Una citazione in piu' usa questi temi: conta, ma non sposta i centri."""
        for tag in tags:
            self._count(tag)
            self._quote_uses[tag] = self._quote_uses.get(tag, 0) + 1
        self._quotes += 1

    def full(self, tag: str) -> bool:
        """Vero se il tema ha gia' la sua parte di citazioni (vedi QUOTE_SHARE_CAP)."""
        return self._quote_uses.get(tag, 0) >= max(QUOTE_CAP_MIN, QUOTE_SHARE_CAP * self._quotes)

    def _specificity(self, tag: str) -> float:
        """Da 0 (tema onnipresente) a 1 (tema raro)."""
        smoothing = max(3.0, self._total * 0.01)
        rare = math.log((self._total + smoothing) / smoothing)
        return math.log((self._total + smoothing) / (self._uses[tag] + smoothing)) / rare

    def nearest(self, vector: array, count: int) -> list[tuple[float, str]]:
        """I temi piu' adatti al vettore, con la loro similarita': i piu'
        vicini per significato, con un vantaggio per quelli piu' specifici.
        Il primo e' sempre il piu' vicino in assoluto."""
        scored = []
        for tag, total in self._sums.items():
            if tag not in self._centers:
                self._centers[tag] = embeddings.normalized(total)
            scored.append((embeddings.similarity(vector, self._centers[tag]), tag))
        scored.sort(reverse=True)
        if not scored:
            return []
        rest = sorted(
            scored[1:WIDE_NET],
            key=lambda item: item[0] + SPECIFICITY_BONUS * self._specificity(item[1]),
            reverse=True,
        )
        return (scored[:1] + rest)[:count]


def _picked(text: str, near: list[tuple[float, str]]) -> list[str]:
    """I temi, tra quelli vicini, che secondo il modello descrivono la frase."""
    reply = ollama.post(
        "/api/generate",
        {
            "model": config.OLLAMA_TAG_MODEL,
            "prompt": PICK_PROMPT.format(
                text=text,
                themes="\n".join(f"{n}. {tag}" for n, (_, tag) in enumerate(near, start=1)),
            ),
            "stream": False,
            "format": "json",
            # Risposta corta e senza estro: il limite evita anche che, in
            # modalita' JSON, il modello resti a generare a vuoto.
            "options": {"temperature": 0, "num_predict": 40},
        },
    )
    try:
        numbers = json.loads(reply["response"]).get("temi", [])
    except (ValueError, AttributeError):
        return []
    picks: list[str] = []
    for number in numbers if isinstance(numbers, list) else []:
        if str(number).isdigit() and 1 <= int(number) <= len(near):
            tag = near[int(number) - 1][1]
            if tag not in picks:
                picks.append(tag)
    return picks[:MAX_PICKS]


def _plain(word: str) -> str:
    """La parola senza accenti: "citta'" e "città" sono lo stesso tema."""
    return "".join(ch for ch in unicodedata.normalize("NFD", word) if not unicodedata.combining(ch))


def _existing(word: str, names: list[str]) -> str:
    """Il tema gia' presente che e' la stessa parola scritta in un altro modo
    (con o senza accento, al plurale, con un'altra desinenza: memoria e
    memorie, sciamano e sciamanesimo), se c'e'; altrimenti la parola stessa."""
    plain = {_plain(name): name for name in names}
    key = _plain(word)
    if key in plain:
        return plain[key]
    close = get_close_matches(key, list(plain), n=1, cutoff=0.85)
    if close:
        return plain[close[0]]
    for other, name in plain.items():
        shared = len(os.path.commonprefix([key, other]))
        if shared >= max(5, 0.8 * min(len(key), len(other))):
            return name
    return word


def _new_theme(text: str, vector: array, index: ThemeIndex) -> str | None:
    """Una parola nuova per il tema della frase, o None se il modello non
    ne da' una valida. Il modello ne propone tre; vale quella che per
    significato e' piu' vicina alla frase. Se e' un tema esistente scritto
    in un altro modo, vale quello."""
    reply = ollama.post(
        "/api/generate",
        {
            "model": config.OLLAMA_TAG_MODEL,
            "prompt": NEW_THEME_PROMPT.format(text=text),
            "stream": False,
            "options": {"temperature": 0, "num_predict": 24},
        },
    )
    words: list[str] = []
    for piece in re.split(r"[,;/\n]+", reply["response"].lower()):
        word = piece.strip(" .:!?\"'«»“”*-–0123456789()")
        if _WORD.match(word) and word not in _GENERIC and word not in words:
            words.append(word)
    if not words:
        return None
    if len(words) > 1:
        closeness = [embeddings.similarity(vector, v) for v in embeddings.embed_texts(words)]
        words = [word for _, word in sorted(zip(closeness, words), reverse=True)]
    return _existing(words[0], index.names())


def assign(text: str, vector: array, index: ThemeIndex) -> list[str]:
    """I temi di una citazione; aggiorna l'indice con i temi assegnati."""
    ranked = index.nearest(vector, WIDE_NET)
    # Le stelle che hanno gia' la loro parte di citazioni non si propongono.
    near = [item for item in ranked if not index.full(item[1])][:CANDIDATES]
    tags = _picked(text, near) if near else []
    if not ranked or ranked[0][0] < NEW_THEME_BELOW:
        fresh = _new_theme(text, vector, index)
        if fresh and fresh not in tags and not index.full(fresh):
            tags.append(fresh)
    if not tags and near:
        tags = [near[0][1]]  # il modello non ha scelto: vale il tema piu' vicino
    tags = tags[: config.MAX_TAGS_PER_ENTRY]
    index.add_quote(tags)
    return tags
