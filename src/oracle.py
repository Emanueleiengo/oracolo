"""L'Oracolo dentro la nebulosa.

- `ask`: chi visita scrive una domanda; l'Oracolo trova i pensieri piu'
  affini (per significato, vedi embeddings.py), lo indirizza alla stella che
  li raccoglie e gli risponde ispirandosi a quei pensieri.
- `question_for_tag`: su una stella del viaggio e' l'Oracolo a fare una
  domanda al visitatore.
- `answer`: risposta enigmatica a una domanda, ispirata ai pensieri vicini.
"""

import random
import re
from collections import defaultdict

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

QUESTION_PROMPT = """Sei l'Oracolo di una nebulosa fatta dei pensieri anonimi di tante persone. \
Chi ti visita si e' fermato sulla stella "{tag}"{path}.

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
- Di chi e' la voce che senti quando la casa e' vuota?
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


def _choose_tag(scored: list[tuple[float, dict]]) -> str:
    """La stella a cui indirizzare: il tag che pesa di piu' tra i pensieri
    vicini (ognuno conta per quanto supera il meno vicino del gruppo)."""
    floor = scored[-1][0]
    weight: dict[str, float] = defaultdict(float)
    for score, entry in scored:
        for tag in entry["tags"]:
            weight[tag] += (score - floor) + 0.02
    return max(weight.items(), key=lambda item: item[1])[0]


def answer(question: str, tag: str | None = None) -> dict:
    """Risposta enigmatica, ispirata ai pensieri piu' vicini alla domanda
    (solo quelli della stella `tag`, se indicata)."""
    entries = _tagged_entries()
    if tag:
        entries = [e for e in entries if tag in e["tags"]] or entries
    if not entries:
        return {"answer": SILENCE, "entries": []}
    near = [entry for _, entry in _nearest(question, entries, NEAREST)]
    text = _generate(ANSWER_PROMPT.format(thoughts=_thoughts(near), question=question), 0.9)
    return {
        "answer": text or SILENCE,
        "entries": [{"id": e["id"], "text": e["text"]} for e in near[:SHOWN]],
    }


def ask(question: str) -> dict | None:
    """Indirizza la domanda a una stella e risponde. None se la nebulosa e'
    vuota (nessuna entry taggata)."""
    entries = _tagged_entries()
    if not entries:
        log.warning("Nessuna entry taggata: l'Oracolo non ha stelle a cui indirizzare")
        return None

    scored = _nearest(question, entries, NEAREST)
    tag = _choose_tag(scored)
    near = [entry for _, entry in scored]
    # A chi ha chiesto si mostrano prima i pensieri della stella scelta.
    shown = sorted(near, key=lambda e: tag not in e["tags"])[:SHOWN]
    log.info("Domanda %r -> stella '%s'", question, tag)

    text = _generate(ANSWER_PROMPT.format(thoughts=_thoughts(near), question=question), 0.9)
    return {
        "question": question,
        "tag": tag,
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
