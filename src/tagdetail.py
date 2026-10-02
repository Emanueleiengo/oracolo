from collections import Counter

from src import db_local


def build_tag_detail(tag_name: str) -> dict | None:
    """Dettaglio di un tag (entry correlate + tag imparentati), o None se non esiste.

    Condivisa tra il server locale (src/server.py) e l'export statico
    (src/export_static.py) cosi' producono esattamente la stessa risposta.
    """
    entries = db_local.get_entries_with_tags()
    matching = [e for e in entries if tag_name in e["tags"]]
    if not matching:
        return None

    related_counts: Counter = Counter()
    # Per ogni tag imparentato, le entry che contengono entrambi i tag:
    # sono il motivo per cui i due sono collegati.
    shared: dict[str, list[dict]] = {}
    for entry in matching:
        for tag in entry["tags"]:
            if tag != tag_name:
                related_counts[tag] += 1
                shared.setdefault(tag, []).append(entry)

    return {
        "name": tag_name,
        "count": len(matching),
        # `source` (titolo e autore) accompagna le citazioni tratte dai testi
        "entries": [
            {"id": e["id"], "text": e["text"], "likes": e["likes"], "source": e["source"]}
            for e in matching[:20]
        ],
        "related": [
            {
                "name": n,
                "weight": w,
                "entries": [
                    {"id": e["id"], "text": e["text"], "source": e["source"]}
                    for e in shared[n][:3]
                ],
            }
            for n, w in related_counts.most_common(12)
        ],
    }
