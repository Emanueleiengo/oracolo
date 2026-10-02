"""Similarita' semantica tra testi, tramite il modello di embedding su Ollama.

Ogni entry viene trasformata in un vettore (una volta sola, poi resta nel DB
locale); due testi dal significato vicino hanno vettori vicini, anche se non
condividono nessuna parola. Serve all'Oracolo per trovare i pensieri piu'
affini a una domanda.
"""

import hashlib
import math
from array import array

import requests

from src import config, db_local
from src.logging_utils import get_logger

log = get_logger(__name__)

# Quanti testi mandare a Ollama in una sola richiesta.
BATCH_SIZE = 32


def _text_hash(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def _normalized(values) -> array:
    """Vettore di lunghezza 1: cosi' la similarita' e' un semplice prodotto."""
    norm = math.sqrt(sum(v * v for v in values)) or 1.0
    return array("f", (v / norm for v in values))


def embed_texts(texts: list[str]) -> list[array]:
    """Chiede a Ollama i vettori (normalizzati) di una lista di testi."""
    vectors: list[array] = []
    for start in range(0, len(texts), BATCH_SIZE):
        response = requests.post(
            f"{config.OLLAMA_HOST}/api/embed",
            json={
                "model": config.OLLAMA_EMBED_MODEL,
                "input": texts[start : start + BATCH_SIZE],
            },
            timeout=config.OLLAMA_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        vectors.extend(_normalized(v) for v in response.json()["embeddings"])
    return vectors


def ensure_entry_embeddings(entries: list[dict]) -> int:
    """Calcola i vettori delle entry che non lo hanno ancora (o il cui testo
    o modello e' cambiato). Ritorna quante ne ha calcolate.
    """
    db_local.init_db()
    known = {
        row["entry_id"]: (row["model"], row["text_hash"])
        for row in db_local.get_entry_embeddings()
    }
    pending = [
        e
        for e in entries
        if known.get(e["id"]) != (config.OLLAMA_EMBED_MODEL, _text_hash(e["text"]))
    ]
    if not pending:
        return 0

    log.info(
        "Calcolo i vettori di similarita' per %d entry (modello '%s' su %s)...",
        len(pending), config.OLLAMA_EMBED_MODEL, config.OLLAMA_HOST,
    )
    for start in range(0, len(pending), BATCH_SIZE):
        batch = pending[start : start + BATCH_SIZE]
        vectors = embed_texts([e["text"] for e in batch])
        db_local.upsert_entry_embeddings(
            [
                {
                    "entry_id": e["id"],
                    "model": config.OLLAMA_EMBED_MODEL,
                    "text_hash": _text_hash(e["text"]),
                    "vector": vector.tobytes(),
                }
                for e, vector in zip(batch, vectors)
            ]
        )
    log.info("Vettori di similarita' aggiornati (%d entry)", len(pending))
    return len(pending)


def load_entry_vectors() -> dict[int, array]:
    """Vettori di tutte le entry calcolati con il modello attuale."""
    vectors: dict[int, array] = {}
    for row in db_local.get_entry_embeddings():
        if row["model"] != config.OLLAMA_EMBED_MODEL:
            continue
        vector = array("f")
        vector.frombytes(row["vector"])
        vectors[row["entry_id"]] = vector
    return vectors


def similarity(a: array, b: array) -> float:
    """Similarita' (coseno) tra due vettori normalizzati: 1 = stesso significato."""
    if hasattr(math, "sumprod"):  # Python 3.12+, molto piu' veloce
        return math.sumprod(a, b)
    return sum(x * y for x, y in zip(a, b))
