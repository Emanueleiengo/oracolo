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

-- Testi dati in lettura all'Oracolo (libri, tesi, interviste): vedi library.py
CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file TEXT NOT NULL UNIQUE,       -- nome del file nella cartella dei testi
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    kind TEXT,                       -- libro, tesi, intervista...
    file_hash TEXT NOT NULL,         -- impronta del file: se cambia va riletto
    added_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Tutti i passi di un testo: la "biblioteca" che l'Oracolo consulta.
CREATE TABLE IF NOT EXISTS passages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,       -- ordine nel testo
    text TEXT NOT NULL,
    model TEXT,                      -- modello che ha prodotto il vettore
    vector BLOB                      -- vettore normalizzato, float a 32 bit
);
"""

# Le citazioni scelte dai testi entrano nella nebulosa come entry, accanto ai
# pensieri delle persone. I loro id partono da qui, per non scontrarsi con
# quelli delle righe MySQL: id = FRAGMENT_ID_BASE + id del passo d'origine.
FRAGMENT_ID_BASE = 1_000_000_000


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
        # DB creati prima dei testi: alle entry manca la colonna della fonte
        # (NULL = pensiero di una persona).
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(entries)")}
        if "source_id" not in columns:
            conn.execute(
                "ALTER TABLE entries ADD COLUMN source_id INTEGER "
                "REFERENCES sources(id) ON DELETE CASCADE"
            )


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
    """Tutte le entry con i loro tag. Per le citazioni tratte da un testo,
    `source` ne riporta titolo e autore; per i pensieri delle persone e' None."""
    init_db()
    with get_connection() as conn:
        entries = conn.execute(
            """
            SELECT e.id, e.text, e.likes, s.title AS source_title, s.author AS source_author
            FROM entries e LEFT JOIN sources s ON s.id = e.source_id
            """
        ).fetchall()
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
                    "source": (
                        {"title": entry["source_title"], "author": entry["source_author"]}
                        if entry["source_title"]
                        else None
                    ),
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


# ── Testi letti dall'Oracolo ──

def get_source_by_file(file: str) -> sqlite3.Row | None:
    with get_connection() as conn:
        return conn.execute("SELECT * FROM sources WHERE file = ?", (file,)).fetchone()


def get_sources() -> list[sqlite3.Row]:
    """I testi caricati, con quanti passi e quante citazioni hanno dato."""
    with get_connection() as conn:
        return conn.execute(
            """
            SELECT s.*,
                (SELECT COUNT(*) FROM passages p WHERE p.source_id = s.id) AS passages,
                (SELECT COUNT(*) FROM entries e WHERE e.source_id = s.id) AS fragments
            FROM sources s ORDER BY s.id
            """
        ).fetchall()


def replace_source(file: str, title: str, author: str, kind: str | None, file_hash: str) -> int:
    """Registra un testo, cancellando tutto cio' che una sua versione
    precedente aveva lasciato (passi, citazioni, tag e vettori collegati)."""
    with get_connection() as conn:
        conn.execute("DELETE FROM sources WHERE file = ?", (file,))
        cursor = conn.execute(
            "INSERT INTO sources (file, title, author, kind, file_hash) VALUES (?, ?, ?, ?, ?)",
            (file, title, author, kind, file_hash),
        )
        return cursor.lastrowid


def finish_source(source_id: int, file_hash: str) -> None:
    """Segna un testo come letto fino in fondo. Finche' non succede la sua
    impronta resta vuota, e al prossimo giro viene riletto da capo: cosi' un
    caricamento interrotto a meta' non lascia testi monchi."""
    with get_connection() as conn:
        conn.execute("UPDATE sources SET file_hash = ? WHERE id = ?", (file_hash, source_id))


def delete_source(file: str) -> bool:
    """Toglie un testo (o, per una raccolta, tutte le sue interviste)."""
    with get_connection() as conn:
        return conn.execute(
            "DELETE FROM sources WHERE file = ? OR file LIKE ? || '#%'", (file, file)
        ).rowcount > 0


def insert_passages(source_id: int, rows: list[dict]) -> list[int]:
    """Salva i passi di un testo (testo + vettore), ritorna i loro id."""
    with get_connection() as conn:
        ids = []
        for position, row in enumerate(rows):
            cursor = conn.execute(
                "INSERT INTO passages (source_id, position, text, model, vector) VALUES (?, ?, ?, ?, ?)",
                (source_id, position, row["text"], row["model"], row["vector"]),
            )
            ids.append(cursor.lastrowid)
        return ids


def get_passages_signature() -> tuple[int, int]:
    """Quanti passi ci sono e l'id dell'ultimo: cambia quando cambia la biblioteca."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS last FROM passages"
        ).fetchone()
        return row["n"], row["last"]


def get_passages() -> list[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(
            """
            SELECT p.id, p.text, p.model, p.vector, s.title, s.author, s.kind
            FROM passages p JOIN sources s ON s.id = p.source_id
            WHERE p.vector IS NOT NULL
            """
        ).fetchall()


def insert_fragments(source_id: int, rows: list[dict]) -> None:
    """Salva le citazioni di un testo come entry della nebulosa (ancora da
    taggare). Ogni riga: {"passage_id", "text"}."""
    with get_connection() as conn:
        conn.executemany(
            "INSERT OR REPLACE INTO entries (id, text, status, likes, source_id) "
            "VALUES (:id, :text, 'testo', 0, :source_id)",
            [
                {"id": FRAGMENT_ID_BASE + row["passage_id"], "text": row["text"], "source_id": source_id}
                for row in rows
            ],
        )
