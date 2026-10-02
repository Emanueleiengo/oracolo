import os
from urllib.parse import urlsplit

from dotenv import load_dotenv

load_dotenv()


def _int(name: str, default: int) -> int:
    value = os.getenv(name)
    return int(value) if value else default


def _ollama_url(value: str) -> str:
    """Indirizzo a cui raggiungere Ollama, ricavato da OLLAMA_HOST.

    La stessa variabile la legge anche Ollama per decidere dove ascoltare, e
    sul PC che lo ospita spesso e' impostata nel sistema a "0.0.0.0" (accetta
    richieste da tutta la rete): quel valore ha la precedenza sul file .env e
    non e' un indirizzo a cui collegarsi. Come fa il client di Ollama, si
    aggiungono "http://" e la porta 11434 se mancano, e "0.0.0.0" diventa
    questo stesso computer.
    """
    value = value.strip().rstrip("/")
    has_scheme = "://" in value
    parts = urlsplit(value if has_scheme else f"http://{value}")
    host = parts.hostname or "127.0.0.1"
    if host in ("0.0.0.0", "::"):
        host = "127.0.0.1"
    if ":" in host:  # indirizzo IPv6
        host = f"[{host}]"
    default_port = 11434 if not has_scheme else (443 if parts.scheme == "https" else 80)
    return f"{parts.scheme}://{host}:{parts.port or default_port}{parts.path}"


# Endpoint PHP (hosting/api/export.php) che espone il DB via HTTP,
# protetto dalla stessa api_key definita in config.php sul server.
REMOTE_API_URL = os.getenv("REMOTE_API_URL", "")
REMOTE_API_KEY = os.getenv("REMOTE_API_KEY", "")

LOCAL_DB_PATH = os.getenv("LOCAL_DB_PATH", "data/local.db")

SYNC_INTERVAL_MINUTES = _int("SYNC_INTERVAL_MINUTES", 60)

OLLAMA_HOST = _ollama_url(os.getenv("OLLAMA_HOST") or "http://localhost:11434")
OLLAMA_EMBED_MODEL = os.getenv("OLLAMA_EMBED_MODEL", "bge-m3")
OLLAMA_TAG_MODEL = os.getenv("OLLAMA_TAG_MODEL", "llama3.1")
MAX_TAGS_PER_ENTRY = _int("MAX_TAGS_PER_ENTRY", 3)

# --- Testi letti dall'Oracolo (libri, tesi, interviste) ---
# Cartella in cui mettere i PDF e i TXT, e quante citazioni di ogni testo
# entrano nella nebulosa come stelle (tutto il resto resta consultabile).
TEXTS_DIR = os.getenv("TEXTS_DIR", "testi")
LIBRARY_STARS_PER_SOURCE = _int("LIBRARY_STARS_PER_SOURCE", 40)
QUESTIONS_COUNT = _int("QUESTIONS_COUNT", 6)

# --- Webserver locale (serve il frontend "Nebulosa" + /api/graph, /api/tag/<nome>) ---
FRONTEND_DIST_PATH = os.getenv("FRONTEND_DIST_PATH", "layoutBoltNebulosa/project/dist")
SERVE_HOST = os.getenv("SERVE_HOST", "0.0.0.0")
SERVE_PORT = _int("SERVE_PORT", 8000)

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
REMOTE_API_TIMEOUT_SECONDS = _int("REMOTE_API_TIMEOUT_SECONDS", 15)
OLLAMA_TIMEOUT_SECONDS = _int("OLLAMA_TIMEOUT_SECONDS", 60)
