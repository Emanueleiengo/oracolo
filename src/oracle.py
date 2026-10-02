"""L'Oracolo dentro la nebulosa.

- `suggestions`: domande che chi visita potrebbe fare, da proporgli.
- `ask`: chi visita fa una domanda; l'Oracolo trova i pensieri piu' affini
  (per significato, vedi embeddings.py), lo fa viaggiare fino alla stella che
  li raccoglie e gli risponde ispirandosi a quei pensieri.
- `answer`: testo oracolare di una stella: la risposta alla domanda del
  visitatore vista da quella stella, oppure, senza domanda, una sentenza sul
  suo tema.
- `question_for_tag`: una domanda che l'Oracolo fa al visitatore fermo su
  una stella.
"""

import json
import math
import random
import re
import time
from collections import Counter, defaultdict

import requests

from src import config, db_local, embeddings
from src.logging_utils import get_logger

log = get_logger(__name__)

# Quanti pensieri vicini alla domanda guardare per scegliere la stella e
# ispirare la risposta, e quanti mostrarne a chi ha chiesto.
NEAREST = 8
SHOWN = 3
# Quante volte riprovare se la domanda generata non rispetta le regole.
QUESTION_ATTEMPTS = 3

ANSWER_PROMPT = """Sei l'Oracolo di una nebulosa fatta dei pensieri anonimi di tante persone. \
Qualcuno ti pone una domanda. Tu non spieghi, non consoli e non dai consigli: \
rispondi come una sibilla, con un'immagine concreta e inattesa che lasci da pensare.

Pensieri della nebulosa vicini alla domanda (sono la tua materia: prendine \
un oggetto, un gesto o un luogo, senza copiarne le frasi):
{thoughts}

Domanda: "{question}"

Rispondi in italiano con UNA SOLA frase breve (al massimo 16 parole), \
all'indicativo, che parli alla persona dandole del tu o in forma impersonale. \
Niente domande, niente elenchi, niente "forse", niente virgolette, nessuna \
premessa. Scrivi solo la frase."""

VOICE_PROMPT = """Sei l'Oracolo di una nebulosa fatta dei pensieri anonimi di tante persone. \
Chi ti visita si è fermato davanti alla stella che custodisce il tema "{tag}".

Pensieri raccolti in questa stella:
{thoughts}

Pronuncia una sentenza da sibilla su questo tema. Regole:
- in italiano, UNA SOLA frase breve (al massimo 16 parole), all'indicativo;
- deve far sentire il tema "{tag}" senza nominarlo;
- costruiscila attorno a un oggetto, un gesto o un luogo preso da uno dei pensieri sopra, senza copiarne la frase;
- parla a chi ti ascolta dandogli del tu, oppure in forma impersonale;
- non spiegare e non dare consigli; niente domande, niente "forse", niente virgolette, nessuna premessa.

Scrivi solo la frase."""

SUGGESTIONS_PROMPT = """Molte persone hanno lasciato un pensiero anonimo in una nebulosa custodita da un Oracolo.

Temi ricorrenti: {tags}

Alcuni pensieri:
{samples}

Scrivi esattamente {count} domande che una persona potrebbe rivolgere all'Oracolo sulla propria vita. Regole:
- in italiano, in prima persona, al massimo 8 parole ciascuna;
- semplici e dirette, come quelle che ci si fa di notte;
- ognuna su un tema diverso tra quelli sopra;
- ognuna inizia con una parola diversa: per esempio Perché, Quando, Chi, Dove, Cosa, Sono, Posso, Riuscirò, Tornerò, e al massimo una con Come;
- niente nomi propri, niente domande sull'Oracolo o sulla nebulosa.

Esempi del tono (non copiarli):
- Tornerò mai a casa?
- Perché ho paura di restare solo?
- Come si fa a perdonare?

Rispondi SOLO con un oggetto JSON con questa forma esatta, senza altro testo:
{{"questions": ["...", "..."]}}
"""

# Domande proposte se Ollama non e' raggiungibile.
FALLBACK_SUGGESTIONS = [
    "Tornerò mai a casa?",
    "Perché ho paura di restare solo?",
    "Come si fa a perdonare?",
    "Che senso ha tutto questo?",
    "Sono sulla strada giusta?",
    "Perché non riesco a dimenticare?",
]
# Quante domande chiedere per volta, quante devono risultarne buone prima di
# smettere di riprovare, quante proporne, e per quanti secondi
# riusare quelle gia' generate prima di chiederne di nuove a Ollama.
SUGGESTIONS_POOL = 10
SUGGESTIONS_ENOUGH = 7
SUGGESTIONS_SHOWN = 4
SUGGESTIONS_TTL = 600
_suggestions: dict = {"at": 0.0, "pool": []}

QUESTION_PROMPT = """Sei l'Oracolo di una nebulosa fatta dei pensieri anonimi di tante persone. \
Chi ti visita si è fermato sulla stella "{tag}"{path}.

Pensieri raccolti in questa stella (ti servono solo per capire il tema: non \
parlare a nome di chi li ha scritti):
{thoughts}

Fai al visitatore UNA domanda sulla SUA vita. Regole:
- in italiano, al massimo 14 parole, una sola frase che finisce con il punto di domanda;
- parla solo di lui, dandogli del tu: mai "io", "mio", "mia", "mi", "noi", "nostro";
- parti da qualcosa di concreto (un oggetto, un luogo, un gesto, una persona), non da un concetto;
- non usare la parola "{tag}";
- non iniziare con "Ricordi", "Cosa significa" o "Come puoi".

Esempi del tono, su altri temi (non copiarli):
- Di chi è la voce che senti quando la casa è vuota?
- Da quanto tempo non apri quel cassetto?
- Chi ti aspettava alla fermata, quel giorno?
- Dove hai nascosto la lettera che non hai spedito?

Scrivi solo la domanda."""

FALLBACK_QUESTION = "Che cosa ti ha portato fin qui?"
SILENCE = "L'oracolo resta in silenzio."

# Parole che tradiscono un Oracolo che parla di se' invece che al visitatore.
_FIRST_PERSON = re.compile(r"\b(io|mio|mia|miei|mie|mi|noi|nostr[oaie])\b", re.IGNORECASE)


def _generate(prompt: str, temperature: float) -> str:
    response = requests.post(
        f"{config.OLLAMA_HOST}/api/generate",
        json={
            "model": config.OLLAMA_TAG_MODEL,
            "prompt": prompt,
            "stream": False,
            "options": {"temperature": temperature},
        },
        timeout=config.OLLAMA_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    return _clean(response.json()["response"])


def _clean(text: str) -> str:
    """Solo la prima riga, senza virgolette, trattini da elenco o spazi."""
    lines = [line.strip() for line in text.strip().splitlines() if line.strip()]
    if not lines:
        return ""
    return lines[0].lstrip("-• ").strip(" \"'«»“”")


def _thoughts(entries: list[dict]) -> str:
    return "\n".join(f"- {e['text']}" for e in entries)


def _tagged_entries() -> list[dict]:
    return [e for e in db_local.get_entries_with_tags() if e["tags"]]


def _nearest(question: str, entries: list[dict], count: int) -> list[tuple[float, dict]]:
    """Le entry dal significato piu' vicino alla domanda, con la similarita'."""
    embeddings.ensure_entry_embeddings(entries)
    vectors = embeddings.load_entry_vectors()
    question_vector = embeddings.embed_texts([question])[0]
    scored = [
        (embeddings.similarity(question_vector, vectors[e["id"]]), e)
        for e in entries
        if e["id"] in vectors
    ]
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return scored[:count]


def _rank_tags(scored: list[tuple[float, dict]], entries: list[dict]) -> list[str]:
    """I tag dei pensieri vicini alla domanda, dal piu' caratteristico: il
    primo e' la stella a cui indirizzare.

    Ogni pensiero vicino da' peso ai suoi tag (per quanto supera il meno
    vicino del gruppo), ma il peso di un tag conta meno quanto piu' il tag e'
    diffuso in tutta la nebulosa: altrimenti un tag onnipresente (per esempio
    "amore" su meta' delle entry) vincerebbe per qualunque domanda.
    """
    floor = scored[-1][0]
    weight: dict[str, float] = defaultdict(float)
    for score, entry in scored:
        for tag in entry["tags"]:
            weight[tag] += (score - floor) + 0.02

    spread = Counter(tag for entry in entries for tag in entry["tags"])
    total = len(entries)
    # La correzione attenua il vantaggio dei tag rarissimi: una stella con
    # una sola frase e' specifica, ma e' un punto di partenza povero.
    smoothing = max(3.0, total * 0.02)

    def specificity(tag: str) -> float:
        return math.log((total + smoothing) / (spread[tag] + smoothing))

    return sorted(weight, key=lambda tag: weight[tag] * specificity(tag), reverse=True)


def answer(question: str | None, tag: str | None = None) -> dict:
    """Testo oracolare. Con una domanda: la risposta, ispirata ai pensieri
    piu' vicini (solo quelli della stella `tag`, se indicata). Senza
    domanda: una sentenza sul tema della stella `tag`."""
    entries = _tagged_entries()
    if tag:
        entries = [e for e in entries if tag in e["tags"]] or entries
    if not entries:
        return {"answer": SILENCE, "entries": []}

    if question:
        near = [entry for _, entry in _nearest(question, entries, NEAREST)]
        prompt = ANSWER_PROMPT.format(thoughts=_thoughts(near), question=question)
        text = _generate(prompt, 0.9)
    else:
        near = random.sample(entries, min(6, len(entries)))
        text = _generate(VOICE_PROMPT.format(tag=tag, thoughts=_thoughts(near)), 0.8)
    return {
        "answer": text or SILENCE,
        "entries": [{"id": e["id"], "text": e["text"]} for e in near[:SHOWN]],
    }


def _opening(question: str) -> str:
    return question.split()[0].lower()


def _usable_suggestions(parsed, pool: list[str]) -> None:
    """Aggiunge a `pool` le domande generate che sono brevi, ben formate e
    non ripetono troppo lo stesso inizio (al massimo due per parola)."""
    raw = parsed.get("questions") if isinstance(parsed, dict) else parsed
    if not isinstance(raw, list):
        return
    for item in raw:
        question = _clean(str(item))
        words = question.split()
        if not question.endswith("?") or not 2 <= len(words) <= 9 or question in pool:
            continue
        if sum(1 for q in pool if _opening(q) == _opening(question)) >= 2:
            continue
        pool.append(question)


def _generate_suggestions(entries: list[dict]) -> list[str]:
    """Chiede a Ollama una scorta di domande; se ne escono poche di buone
    riprova, fino a tre volte."""
    tags = sorted({tag for e in entries for tag in e["tags"]})
    pool: list[str] = []
    for _ in range(3):
        response = requests.post(
            f"{config.OLLAMA_HOST}/api/generate",
            json={
                "model": config.OLLAMA_TAG_MODEL,
                "prompt": SUGGESTIONS_PROMPT.format(
                    tags=", ".join(random.sample(tags, min(40, len(tags)))),
                    samples=_thoughts(random.sample(entries, min(16, len(entries)))),
                    count=SUGGESTIONS_POOL,
                ),
                "stream": False,
                "format": "json",
                "options": {"temperature": 0.9},
            },
            timeout=config.OLLAMA_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        try:
            _usable_suggestions(json.loads(response.json()["response"]), pool)
        except ValueError:
            pass
        if len(pool) >= SUGGESTIONS_ENOUGH:
            break
    return pool


def suggestions() -> list[str]:
    """Alcune domande da proporre a chi entra nella nebulosa. Vengono
    generate da Ollama a partire dai temi e riusate per qualche minuto; se
    Ollama non risponde si propongono quelle di riserva."""
    if time.time() - _suggestions["at"] > SUGGESTIONS_TTL or not _suggestions["pool"]:
        entries = _tagged_entries()
        try:
            pool = _generate_suggestions(entries) if entries else []
        except (requests.RequestException, KeyError) as error:
            log.warning("Domande suggerite non generate (%s): uso quelle di riserva", error)
            pool = []
        _suggestions["pool"] = pool
        # Se la generazione fallisce si riprova tra un minuto, non a ogni richiesta.
        _suggestions["at"] = time.time() if pool else time.time() - SUGGESTIONS_TTL + 60

    pool = list(_suggestions["pool"])
    if len(pool) < SUGGESTIONS_SHOWN:
        pool += [q for q in FALLBACK_SUGGESTIONS if q not in pool]
    # Tra quelle proposte insieme, prima le domande che iniziano in modo diverso.
    random.shuffle(pool)
    shown: list[str] = []
    for question in pool:
        if all(_opening(question) != _opening(q) for q in shown):
            shown.append(question)
    shown += [q for q in pool if q not in shown]
    return shown[:SUGGESTIONS_SHOWN]


def _rank_tags(scored: list[tuple[float, dict]], entries: list[dict]) -> list[str]:
    """I tag dei pensieri vicini alla domanda, dal piu' caratteristico: il
    primo e' la stella a cui indirizzare.

    Ogni pensiero vicino da' peso ai suoi tag (per quanto supera il meno
    vicino del gruppo), ma il peso di un tag conta meno quanto piu' il tag e'
    diffuso in tutta la nebulosa: altrimenti un tag onnipresente (per esempio
    "amore" su meta' delle entry) vincerebbe per qualunque domanda.
    """
    floor = scored[-1][0]
    weight: dict[str, float] = defaultdict(float)
    for score, entry in scored:
        for tag in entry["tags"]:
            weight[tag] += (score - floor) + 0.02

    spread = Counter(tag for entry in entries for tag in entry["tags"])
    total = len(entries)
    # La correzione attenua il vantaggio dei tag rarissimi: una stella con
    # una sola frase e' specifica, ma e' un punto di partenza povero.
    smoothing = max(3.0, total * 0.02)

    def specificity(tag: str) -> float:
        return math.log((total + smoothing) / (spread[tag] + smoothing))

    return sorted(weight, key=lambda tag: weight[tag] * specificity(tag), reverse=True)


def answer(question: str | None, tag: str | None = None) -> dict:
    """Testo oracolare. Con una domanda: la risposta, ispirata ai pensieri
    piu' vicini (solo quelli della stella `tag`, se indicata). Senza
    domanda: una sentenza sul tema della stella `tag`."""
    entries = _tagged_entries()
    if tag:
        entries = [e for e in entries if tag in e["tags"]] or entries
    if not entries:
        return {"answer": SILENCE, "entries": []}

    if question:
        near = [entry for _, entry in _nearest(question, entries, NEAREST)]
        prompt = ANSWER_PROMPT.format(thoughts=_thoughts(near), question=question)
        text = _generate(prompt, 0.9)
    else:
        near = random.sample(entries, min(6, len(entries)))
        text = _generate(VOICE_PROMPT.format(tag=tag, thoughts=_thoughts(near)), 0.8)
    return {
        "answer": text or SILENCE,
        "entries": [{"id": e["id"], "text": e["text"]} for e in near[:SHOWN]],
    }


def _usable_suggestions(parsed) -> list[str]:
    """Domande brevi, ben formate e che iniziano con parole diverse, tra
    quelle generate."""
    raw = parsed.get("questions") if isinstance(parsed, dict) else parsed
    if not isinstance(raw, list):
        return []
    picked: list[str] = []
    openings: set[str] = set()
    for item in raw:
        question = _clean(str(item))
        words = question.split()
        opening = words[0].lower() if words else ""
        if not question.endswith("?") or not 2 <= len(words) <= 9 or opening in openings:
            continue
        openings.add(opening)
        picked.append(question)
    return picked


def suggestions() -> list[str]:
    """Alcune domande da proporre a chi entra nella nebulosa. Vengono
    generate da Ollama a partire dai temi e riusate per qualche minuto; se
    Ollama non risponde si propongono quelle di riserva."""
    if time.time() - _suggestions["at"] > SUGGESTIONS_TTL or not _suggestions["pool"]:
        entries = _tagged_entries()
        try:
            if not entries:
                raise ValueError("nessuna entry taggata")
            tags = sorted({tag for e in entries for tag in e["tags"]})
            response = requests.post(
                f"{config.OLLAMA_HOST}/api/generate",
                json={
                    "model": config.OLLAMA_TAG_MODEL,
                    "prompt": SUGGESTIONS_PROMPT.format(
                        tags=", ".join(random.sample(tags, min(40, len(tags)))),
                        samples=_thoughts(random.sample(entries, min(16, len(entries)))),
                        count=SUGGESTIONS_POOL,
                    ),
                    "stream": False,
                    "format": "json",
                    "options": {"temperature": 0.9},
                },
                timeout=config.OLLAMA_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            pool = _usable_suggestions(json.loads(response.json()["response"]))
        except (requests.RequestException, ValueError, KeyError) as error:
            log.warning("Domande suggerite non generate (%s): uso quelle di riserva", error)
            pool = []
        _suggestions["pool"] = pool
        # Se la generazione fallisce si riprova tra un minuto, non a ogni richiesta.
        _suggestions["at"] = time.time() if pool else time.time() - SUGGESTIONS_TTL + 60

    pool = _suggestions["pool"]
    if len(pool) < SUGGESTIONS_SHOWN:
        pool = pool + [q for q in FALLBACK_SUGGESTIONS if q not in pool]
    return random.sample(pool, SUGGESTIONS_SHOWN)


def ask(question: str) -> dict | None:
    """Indirizza la domanda a una stella e risponde. None se la nebulosa e'
    vuota (nessuna entry taggata)."""
    entries = _tagged_entries()
    if not entries:
        log.warning("Nessuna entry taggata: l'Oracolo non ha stelle a cui indirizzare")
        return None

    scored = _nearest(question, entries, NEAREST)
    ranked = _rank_tags(scored, entries)
    tag = ranked[0]
    near = [entry for _, entry in scored]
    # A chi ha chiesto si mostrano prima i pensieri della stella scelta.
    shown = sorted(near, key=lambda e: tag not in e["tags"])[:SHOWN]
    log.info("Domanda %r -> stella '%s'", question, tag)

    text = _generate(ANSWER_PROMPT.format(thoughts=_thoughts(near), question=question), 0.9)
    return {
        "question": question,
        "tag": tag,
        # stelle affini da attraversare prima di arrivare, dalla meno vicina
        "path": ranked[1:3][::-1],
        "answer": text or SILENCE,
        "entries": [{"id": e["id"], "text": e["text"]} for e in shown],
    }


def _acceptable(question: str, tag: str) -> bool:
    words = question.split()
    return (
        question.endswith("?")
        and 3 <= len(words) <= 20
        and question.count("?") == 1
        and tag.lower() not in question.lower()
        and not _FIRST_PERSON.search(question)
    )


def question_for_tag(tag: str, trail: list[str] | None = None) -> str | None:
    """Una domanda dell'Oracolo a chi si e' fermato sulla stella `tag`,
    dopo essere passato da `trail`. None se la stella non esiste."""
    entries = [e for e in _tagged_entries() if tag in e["tags"]]
    if not entries:
        return None
    sample = random.sample(entries, min(7, len(entries)))
    before = [t for t in (trail or []) if t != tag][-4:]
    path = f", dopo essere passato da: {', '.join(before)}" if before else ""
    prompt = QUESTION_PROMPT.format(tag=tag, path=path, thoughts=_thoughts(sample))

    for attempt in range(QUESTION_ATTEMPTS):
        question = _generate(prompt, 0.9)
        if _acceptable(question, tag):
            return question
        log.debug("Domanda scartata (tentativo %d): %r", attempt + 1, question)
    log.warning("Nessuna domanda accettabile per la stella '%s'", tag)
    return FALLBACK_QUESTION
