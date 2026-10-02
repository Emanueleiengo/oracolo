import json
from difflib import get_close_matches

import requests

from src import config, db_local
from src.logging_utils import get_logger

log = get_logger(__name__)

TAG_PROMPT = """Analizza il seguente testo e assegna da 1 a {max_tags} tag \
brevi (una o due parole ciascuno) che ne descrivano il tema/argomento principale.
Rispondi SOLO con un oggetto JSON con questa forma esatta, senza altro testo:
{{"tags": ["amore", "gioco"]}}

Testo:
\"\"\"{text}\"\"\"
"""


FRAGMENT_TAG_PROMPT = """Una frase tratta da un libro sta per entrare in una nebulosa di pensieri, \
dove ogni tema e' una stella. Assegnale da 1 a {max_tags} temi (una o due parole ciascuno).

Temi gia' presenti nella nebulosa: {vocabulary}

Scegli di preferenza tra i temi gia' presenti, scritti esattamente cosi': collegano la frase \
alle stelle che esistono. Aggiungi un tema nuovo solo se nessuno di quelli elencati descrive \
bene la frase.
Rispondi SOLO con un oggetto JSON con questa forma esatta, senza altro testo:
{{"tags": ["amore", "gioco"]}}

Frase:
\"\"\"{text}\"\"\"

Passo da cui e' tratta (solo per capirne il senso):
\"\"\"{context}\"\"\"
"""


def _extract_tags(parsed) -> list[str]:
    """Estrae una lista di tag da una risposta JSON di Ollama, tollerando
    forme diverse da quella richiesta (i modelli piccoli non sempre
    rispettano lo schema, es. {"natura": "ecologia"} invece di un array).
    """
    if isinstance(parsed, list):
        return [str(t) for t in parsed]
    if isinstance(parsed, dict):
        if isinstance(parsed.get("tags"), list):
            return [str(t) for t in parsed["tags"]]
        # fallback: appiattisce chiavi e valori come possibili tag
        flat = []
        for key, value in parsed.items():
            flat.append(str(key))
            if isinstance(value, list):
                flat.extend(str(v) for v in value)
            else:
                flat.append(str(value))
        return flat
    return []


def _ask_ollama_for_tags(text: str) -> list[str]:
    prompt = TAG_PROMPT.format(text=text, max_tags=config.MAX_TAGS_PER_ENTRY)
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
    tags = _extract_tags(parsed)
    if not tags:
        log.warning("Nessun tag estraibile dalla risposta di Ollama: %r", parsed)
    return tags[: config.MAX_TAGS_PER_ENTRY]


def tags_for_fragment(text: str, context: str, vocabulary: list[str]) -> list[str]:
    """Tag per una citazione tratta da un testo, scelti di preferenza tra i
    temi gia' presenti nella nebulosa (`vocabulary`)."""
    if not vocabulary:
        return _ask_ollama_for_tags(text)
    response = requests.post(
        f"{config.OLLAMA_HOST}/api/generate",
        json={
            "model": config.OLLAMA_TAG_MODEL,
            "prompt": FRAGMENT_TAG_PROMPT.format(
                text=text,
                context=context,
                vocabulary=", ".join(vocabulary),
                max_tags=config.MAX_TAGS_PER_ENTRY,
            ),
            "stream": False,
            "format": "json",
        },
        timeout=config.OLLAMA_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    try:
        tags = _extract_tags(json.loads(response.json()["response"]))
    except json.JSONDecodeError:
        return []
    chosen: list[str] = []
    for tag in (t.strip().lower() for t in tags):
        if not tag:
            continue
        # Un tema quasi identico a uno gia' presente ("mar" per "mare") e'
        # quello: non deve nascere una stella doppione.
        if tag not in vocabulary:
            tag = next(iter(get_close_matches(tag, vocabulary, n=1, cutoff=0.85)), tag)
        if tag not in chosen:
            chosen.append(tag)
    return chosen[: config.MAX_TAGS_PER_ENTRY]


def tag_pending_entries() -> int:
    """Chiama Ollama per ogni entry non ancora taggata (o modificata dall'ultimo
    tagging). Ritorna il numero di entry taggate con successo.
    """
    entries = db_local.get_untagged_entries()
    total = db_local.count_entries()
    log.info(
        "%d entry da taggare su %d totali (le altre %d hanno gia' dei tag e "
        "vengono saltate), modello '%s' su %s",
        len(entries),
        total,
        total - len(entries),
        config.OLLAMA_TAG_MODEL,
        config.OLLAMA_HOST,
    )
    if not entries:
        return 0

    tagged = 0
    for i, entry in enumerate(entries, start=1):
        try:
            tags = _ask_ollama_for_tags(entry["text"])
        except requests.RequestException:
            log.exception(
                "Chiamata a Ollama fallita per entry id=%s (host %s raggiungibile?)",
                entry["id"],
                config.OLLAMA_HOST,
            )
            continue
        if tags:
            db_local.set_entry_tags(entry["id"], tags)
            tagged += 1
            log.debug("[%d/%d] entry id=%s -> tag %s", i, len(entries), entry["id"], tags)
        else:
            log.warning("[%d/%d] entry id=%s: nessun tag ottenuto", i, len(entries), entry["id"])
    return tagged
