"""I temi (tag) da dare alle citazioni tratte dai testi.

Far inventare liberamente i tag al modello produce doppioni e temi lunghi
una riga. Qui invece:

1. si cercano, per similarita' di significato, i temi gia' presenti nella
   nebulosa piu' vicini alla citazione (il "centro" di un tema e' la media
   dei vettori delle frasi che lo usano);
2. il modello sceglie tra quei pochi quali la descrivono davvero: cosi' la
   citazione si collega alle stelle che esistono;
3. solo se nessun tema esistente e' abbastanza vicino, il modello propone
   una parola nuova, da cui nasce una stella nuova (che le citazioni
   successive potranno a loro volta riusare).
"""

import json
import math
import re
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

PICK_PROMPT = """Una frase sta per entrare in una nebulosa di pensieri, dove ogni tema e' una stella.

Frase:
\"\"\"{text}\"\"\"

Temi gia' presenti che potrebbero riguardarla:
{themes}

Scegli i temi (uno o due) che descrivono davvero cio' di cui la frase parla. Tra due temi \
adatti preferisci quello piu' preciso.

Rispondi SOLO con un oggetto JSON con la chiave "temi" e, come valore, la lista dei numeri \
dei temi scelti."""

NEW_THEME_PROMPT = """Qual e' il tema di questa frase? Rispondi con UNA sola parola: un sostantivo \
comune, al singolare, in minuscolo. Nient'altro.

Frase:
\"\"\"{text}\"\"\""""

_WORD = re.compile(r"^[a-zà-ÿ]{3,18}$")
_NOT_THEMES = {"tema", "frase", "nessuno", "none", "nulla", "parola", "sostantivo"}


class ThemeIndex:
    """I temi della nebulosa con il loro centro, aggiornabile mentre si caricano i testi."""

    def __init__(self) -> None:
        self._sums: dict[str, list[float]] = {}
        self._centers: dict[str, array] = {}
        self._uses: dict[str, int] = {}
        self._total = 0
        vectors = embeddings.load_entry_vectors()
        for entry in db_local.get_entries_with_tags():
            if entry["id"] in vectors:
                for tag in entry["tags"]:
                    self.add(tag, vectors[entry["id"]])

    def __contains__(self, tag: str) -> bool:
        return tag in self._sums

    def names(self) -> list[str]:
        return list(self._sums)

    def add(self, tag: str, vector: array) -> None:
        """Una frase in piu' usa questo tema (che nasce, se non c'era)."""
        total = self._sums.get(tag)
        self._sums[tag] = list(vector) if total is None else [a + b for a, b in zip(total, vector)]
        self._centers.pop(tag, None)
        self._uses[tag] = self._uses.get(tag, 0) + 1
        self._total += 1

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


def _new_theme(text: str, index: ThemeIndex) -> str | None:
    """Una parola nuova per il tema della frase, o None se il modello non
    ne da' una valida. Se e' quasi uguale a un tema esistente, vale quello."""
    reply = ollama.post(
        "/api/generate",
        {
            "model": config.OLLAMA_TAG_MODEL,
            "prompt": NEW_THEME_PROMPT.format(text=text),
            "stream": False,
            "options": {"temperature": 0, "num_predict": 8},
        },
    )
    words = reply["response"].strip().lower().split()
    word = words[0].strip(" .,;:!?\"'«»“”") if words else ""
    if not _WORD.match(word) or word in _NOT_THEMES:
        return None
    return next(iter(get_close_matches(word, index.names(), n=1, cutoff=0.85)), word)


def assign(text: str, vector: array, index: ThemeIndex) -> list[str]:
    """I temi di una citazione; aggiorna l'indice con i temi assegnati."""
    near = index.nearest(vector, CANDIDATES)
    tags = _picked(text, near) if near else []
    if not near or near[0][0] < NEW_THEME_BELOW:
        fresh = _new_theme(text, index)
        if fresh and fresh not in tags:
            tags.append(fresh)
    if not tags and near:
        tags = [near[0][1]]  # il modello non ha scelto: vale il tema piu' vicino
    tags = tags[: config.MAX_TAGS_PER_ENTRY]
    for tag in tags:
        index.add(tag, vector)
    return tags
