import sqlite3
from contextlib import contextmanager
from pathlib import Path

from src import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY,          -- stesso id della riga MySQL
    text TEXT NOT NULL,
    created_at TEXT,
    status TEXT,
    ip TEXT,
    likes INTEGER,
    synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
    tagged_at TEXT                   -- NULL finche' Ollama non l'ha ancora processata
);

CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS entry_tags (
    entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (entry_id, tag_id)
);

CREATE TABLE IF NOT EXISTS entry_embeddings (
    entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
    model TEXT NOT NULL,             -- modello che ha prodotto il vettore
    text_hash TEXT NOT NULL,         -- impronta del testo: se cambia va ricalcolato
    vector BLOB NOT NULL             -- vettore normalizzato, float a 32 bit
);
"""


@contextmanager
def get_connection():
    Path(config.LOCAL_DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(config.LOCAL_DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with get_connection() as conn:
        conn.executescript(SCHEMA)


def upsert_entries(rows: list[dict]) -> int:
    """Inserisce o aggiorna le entry sincronizzate da MySQL.

    Se il testo di un'entry esistente cambia, azzera tagged_at cosi'
    verra' ritaggata al prossimo giro.
    """
    if not rows:
        return 0
    with get_connection() as conn:
        for row in rows:
            existing = conn.execute(
                "SELECT text FROM entries WHERE id = ?", (row["id"],)
            ).fetchone()
            text_changed = existing is not None and existing["text"] != row["text"]
            conn.execute(
                """
                INSERT INTO entries (id, text, created_at, status, ip, likes)
                VALUES (:id, :text, :created_at, :status, :ip, :likes)
                ON CONFLICT(id) DO UPDATE SET
                    text = excluded.text,
                    created_at = excluded.created_at,
                    status = excluded.status,
                    ip = excluded.ip,
                    likes = excluded.likes,
                    synced_at = CURRENT_TIMESTAMP
                """,
                row,
            )
            if text_changed:
                conn.execute(
                    "UPDATE entries SET tagged_at = NULL WHERE id = ?", (row["id"],)
                )
    return len(rows)


def count_entries() -> int:
    with get_connection() as conn:
        return conn.execute("SELECT COUNT(*) AS n FROM entries").fetchone()["n"]


def get_untagged_entries() -> list[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(
            "SELECT id, text FROM entries WHERE tagged_at IS NULL"
        ).fetchall()


def set_entry_tags(entry_id: int, tag_names: list[str]) -> None:
    with get_connection() as conn:
        conn.execute("DELETE FROM entry_tags WHERE entry_id = ?", (entry_id,))
        for name in tag_names:
            name = name.strip().lower()
            if not name:
                continue
            conn.execute(
                "INSERT OR IGNORE INTO tags (name) VALUES (?)", (name,)
            )
            tag_id = conn.execute(
                "SELECT id FROM tags WHERE name = ?", (name,)
            ).fetchone()["id"]
            conn.execute(
                "INSERT OR IGNORE INTO entry_tags (entry_id, tag_id) VALUES (?, ?)",
                (entry_id, tag_id),
            )
        conn.execute(
            "UPDATE entries SET tagged_at = CURRENT_TIMESTAMP WHERE id = ?",
            (entry_id,),
        )


def get_entries_with_tags() -> list[dict]:
    with get_connection() as conn:
        entries = conn.execute("SELECT id, text, likes FROM entries").fetchall()
        result = []
        for entry in entries:
            tag_rows = conn.execute(
                """
                SELECT t.name FROM tags t
                JOIN entry_tags et ON et.tag_id = t.id
                WHERE et.entry_id = ?
                """,
                (entry["id"],),
            ).fetchall()
            result.append(
                {
                    "id": entry["id"],
                    "text": entry["text"],
                    "likes": entry["likes"],
                    "tags": [t["name"] for t in tag_rows],
                }
            )
        return result


def get_entry_embeddings() -> list[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(
            "SELECT entry_id, model, text_hash, vector FROM entry_embeddings"
        ).fetchall()


def upsert_entry_embeddings(rows: list[dict]) -> None:
    """Salva (o sostituisce) i vettori di similarita' delle entry."""
    if not rows:
        return
    with get_connection() as conn:
        conn.executemany(
            """
            INSERT INTO entry_embeddings (entry_id, model, text_hash, vector)
            VALUES (:entry_id, :model, :text_hash, :vector)
            ON CONFLICT(entry_id) DO UPDATE SET
                model = excluded.model,
                text_hash = excluded.text_hash,
                vector = excluded.vector
            """,
            rows,
        )
