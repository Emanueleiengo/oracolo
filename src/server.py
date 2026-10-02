import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

import requests

from src import config, graph, oracle
from src.logging_utils import get_logger
from src.question import generate_questions
from src.tagdetail import build_tag_detail

log = get_logger(__name__)


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/graph":
            self._send_json(200, graph.build_graph_json())
            return
        if path.startswith("/api/tag/"):
            tag_name = unquote(path[len("/api/tag/"):])
            self._handle_tag_detail(tag_name)
            return
        if path == "/api/questions":
            self._handle_questions()
            return
        if path == "/api/oracle/question":
            self._handle_oracle_question()
            return
        super().do_GET()

    def do_POST(self):
        path = urlsplit(self.path).path
        if path == "/api/answer":
            self._handle_answer()
            return
        if path == "/api/ask":
            self._handle_ask()
            return
        self.send_error(404)

    def _handle_tag_detail(self, tag_name: str) -> None:
        detail = build_tag_detail(tag_name)
        if detail is None:
            self._send_json(404, {"error": "tag non trovato"})
            return
        self._send_json(200, detail)

    def _handle_questions(self) -> None:
        try:
            questions = generate_questions()
        except requests.RequestException:
            self._oracle_unreachable()
            return
        if not questions:
            self._send_json(502, {"error": "nessuna domanda disponibile"})
            return
        self._send_json(200, {"questions": questions})

    def _handle_oracle_question(self) -> None:
        """Domanda dell'Oracolo per una stella: ?tag=<nome>&trail=<tappe,precedenti>."""
        query = parse_qs(urlsplit(self.path).query)
        tag = query.get("tag", [""])[0].strip()
        trail = [t for t in query.get("trail", [""])[0].split(",") if t]
        if not tag:
            self._send_json(400, {"error": "manca 'tag'"})
            return
        try:
            question = oracle.question_for_tag(tag, trail)
        except requests.RequestException:
            self._oracle_unreachable()
            return
        if question is None:
            self._send_json(404, {"error": "tag non trovato"})
            return
        self._send_json(200, {"question": question})

    def _handle_answer(self) -> None:
        """Risposta dell'Oracolo: {"question": "...", "tag": "<stella, facoltativa>"}."""
        body = self._read_json()
        if body is None:
            return
        question = str(body.get("question", "")).strip()
        if not question:
            self._send_json(400, {"error": "manca 'question'"})
            return
        tag = str(body.get("tag") or "").strip() or None
        try:
            self._send_json(200, oracle.answer(question, tag))
        except requests.RequestException:
            self._oracle_unreachable()

    def _handle_ask(self) -> None:
        """Domanda scritta dal visitatore: lo indirizza a una stella e risponde."""
        body = self._read_json()
        if body is None:
            return
        question = str(body.get("question", "")).strip()
        if not question:
            self._send_json(400, {"error": "manca 'question'"})
            return
        try:
            result = oracle.ask(question)
        except requests.RequestException:
            self._oracle_unreachable()
            return
        if result is None:
            self._send_json(502, {"error": "la nebulosa e' ancora vuota"})
            return
        self._send_json(200, result)

    def _read_json(self) -> dict | None:
        """Corpo JSON della richiesta; se non e' valido risponde 400 e ritorna None."""
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            body = None
        if not isinstance(body, dict):
            self._send_json(400, {"error": "body non valido"})
            return None
        return body

    def _oracle_unreachable(self) -> None:
        log.exception("Chiamata a Ollama fallita (host %s raggiungibile?)", config.OLLAMA_HOST)
        self._send_json(502, {"error": "l'oracolo non risponde"})

    def _send_json(self, status: int, payload) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args) -> None:
        log.info("%s - %s", self.address_string(), fmt % args)


def run_server() -> None:
    directory = str(Path(config.FRONTEND_DIST_PATH).resolve())
    handler = partial(Handler, directory=directory)
    with ThreadingHTTPServer((config.SERVE_HOST, config.SERVE_PORT), handler) as httpd:
        log.info(
            "Server in ascolto su http://%s:%d (frontend: %s)",
            config.SERVE_HOST, config.SERVE_PORT, directory,
        )
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            log.info("Server fermato")
