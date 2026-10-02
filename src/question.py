import json
import random

import requests

from src import config, db_local
from src.logging_utils import get_logger

log = get_logger(__name__)

QUESTIONS_PROMPT = """Sei l'Oracolo di una nebulosa fatta dei pensieri anonimi di tante persone.

Temi ricorrenti: {tags}

Alcuni pensieri (ti servono solo per capire i temi: non parlare a nome di \
chi li ha scritti):
{samples}

Scrivi esattamente {count} domande da fare a chi ti visita, sulla SUA vita. Regole:
- in italiano, al massimo 14 parole ciascuna, una sola frase che finisce con il punto di domanda;
- parla solo del visitatore, dandogli del tu: mai "io", "mio", "mia", "mi", "noi", "nostro";
- ogni domanda parte da qualcosa di concreto (un oggetto, un luogo, un gesto, una persona), non da un concetto;
- ogni domanda tocca un tema diverso e inizia con una parola diversa;
- non iniziare con "Ricordi", "Cosa significa" o "Come puoi".

Esempi del tono (non copiarli):
- Di chi è la voce che senti quando la casa è vuota?
- Da quanto tempo non apri quel cassetto?
- Chi ti aspettava alla fermata, quel giorno?

Rispondi SOLO con un oggetto JSON con questa forma esatta, senza altro testo:
{{"questions": ["...", "..."]}}
"""

FALLBACK_QUESTION = "L'oracolo tace, per ora."


def _sample_entries(entries: list[dict], n: int = 20) -> list[dict]:
    tagged = [e for e in entries if e["tags"]]
    if len(tagged) <= n:
        return tagged
    return random.sample(tagged, n)


def _extract_questions(parsed) -> list[str]:
    if isinstance(parsed, list):
        return [str(q).strip() for q in parsed if str(q).strip()]
    if isinstance(parsed, dict) and isinstance(parsed.get("questions"), list):
        return [str(q).strip() for q in parsed["questions"] if str(q).strip()]
    return []


def _ask_ollama_for_questions(tags: list[str], samples: list[dict], count: int) -> list[str]:
    prompt = QUESTIONS_PROMPT.format(
        tags=", ".join(tags),
        samples="\n".join(f"- {e['text']}" for e in samples),
        count=count,
    )
    response = requests.post(
        f"{config.OLLAMA_HOST}/api/generate",
        json={
            "model": config.OLLAMA_TAG_MODEL,
            "prompt": prompt,
            "stream": False,
            "format": "json",
        },
        timeout=config.OLLAMA_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    raw = response.json()["response"]
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("Risposta di Ollama non e' JSON valido: %r", raw)
        return []
    questions = _extract_questions(parsed)
    if not questions:
        log.warning("Nessuna domanda estraibile dalla risposta di Ollama: %r", parsed)
    return questions[:count]


def generate_questions(count: int | None = None) -> list[str]:
    """Genera domande evocative al volo da Ollama, a partire dai tag e da
    alcune entry campione. Lista vuota se non ci sono tag o Ollama fallisce."""
    count = count or config.QUESTIONS_COUNT
    entries = db_local.get_entries_with_tags()
    tags = sorted({tag for e in entries for tag in e["tags"]})
    if not tags:
        log.warning(
            "Nessun tag trovato: impossibile generare domande. "
            "Hai gia' eseguito 'sync' e 'tag' (o 'seed')?"
        )
        return []

    samples = _sample_entries(entries)
    log.info(
        "Genero %d domande dell'oracolo da %d tag e %d entry campione",
        count, len(tags), len(samples),
    )
    questions = _ask_ollama_for_questions(tags, samples, count)
    if not questions:
        log.warning("Nessuna domanda ottenuta da Ollama")
    return questions
