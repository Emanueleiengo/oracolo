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
- `star_question`: una domanda che rappresenta una stella, da mostrarle
  accanto: chi la sceglie viaggia fin li' e la stella gli risponde.

Per rispondere l'Oracolo consulta anche i testi che ha letto (library.py):
i passi piu' vicini alla domanda entrano nella sua materia, e le frasi che
li rappresentano meglio vengono mostrate, citate alla lettera, con titolo e
autore.
"""

import heapq
import json
import math
import random
import re
import time
import unicodedata
from collections import Counter, defaultdict

import requests

from src import config, db_local, embeddings, library
from src.logging_utils import get_logger

log = get_logger(__name__)

# Quanti pensieri vicini alla domanda guardare per scegliere la stella e
# ispirare la risposta, e quanti mostrarne a chi ha chiesto.
NEAREST = 8
SHOWN = 3
# Quanti passi dei testi letti far consultare all'Oracolo per una risposta,
# e di quanti mostrare una citazione.
READINGS = 3
READINGS_SHOWN = 2
READINGS_BLOCK = """
Passi dei testi che hai letto, vicini a cio' che ti viene chiesto (sono \
anch'essi tua materia: non citarli e non nominarne gli autori):
{readings}
"""
# Quante volte riprovare se la domanda generata non rispetta le regole.
QUESTION_ATTEMPTS = 3

ANSWER_PROMPT = """Sei l'Oracolo di una nebulosa fatta dei pensieri anonimi di tante persone. \
Qualcuno ti pone una domanda. Tu non spieghi, non consoli e non dai consigli: \
rispondi come una sibilla, con un'immagine concreta e inattesa che lasci da pensare.

Pensieri della nebulosa vicini alla domanda (sono la tua materia: prendine \
un oggetto, un gesto o un luogo, senza copiarne le frasi):
{thoughts}
{readings}
Domanda: "{question}"

Rispondi in italiano con UNA SOLA frase breve (al massimo 16 parole), \
all'indicativo, che parli alla persona dandole del tu o in forma impersonale. \
Niente domande, niente elenchi, niente "forse", niente virgolette, nessuna \
premessa. Scrivi solo la frase."""

VOICE_PROMPT = """Sei l'Oracolo di una nebulosa fatta dei pensieri anonimi di tante persone. \
Chi ti visita si è fermato davanti alla stella che custodisce il tema "{tag}".

Pensieri raccolti in questa stella:
{thoughts}
{readings}
Pronuncia una sentenza da sibilla su questo tema. Regole:
- in italiano, UNA SOLA frase breve (al massimo 16 parole), all'indicativo;
- deve far sentire il tema "{tag}" senza nominarlo;
- costruiscila attorno a un oggetto, un gesto o un luogo preso da uno dei pensieri o dei passi sopra, senza copiarne la frase;
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

# Domanda che rappresenta una stella: chi visita la vede accanto alla stella
# e, scegliendola, viaggia fin li' e la stella gli risponde. Viene scritta di
# nuovo a ogni visita, quindi una stella non ha mai le stesse domande.
STAR_QUESTION_PROMPT = """Molte persone hanno lasciato un pensiero anonimo in una nebulosa custodita da un Oracolo. \
Ogni stella della nebulosa custodisce un tema.

{asked}La stella del tema "{tag}" raccoglie pensieri come questi:
{thoughts}

Scrivi UNA {new}domanda che {who} potrebbe rivolgere all'Oracolo sulla propria vita, e a cui la stella \
"{tag}" saprebbe rispondere{step}. Regole:
- in italiano, in prima persona, al massimo 9 parole, una sola frase che finisce con il punto di domanda;
- semplice e diretta, come quelle che ci si fa di notte;
- deve far sentire il tema senza usare la parola "{tag}";
- niente nomi propri, niente domande sull'Oracolo o sulla nebulosa.

Esempi del tono, su altri temi (non copiarli):
- Tornerò mai a casa?
- Perché ho paura di restare solo?
- Chi mi aspetta alla fine della strada?

Scrivi solo la domanda."""
STAR_QUESTION_ASKED = 'Chi visita la nebulosa ha appena chiesto all\'Oracolo: "{question}". Ora guarda una stella vicina.\n\n'
STAR_QUESTION_WORDS = 14
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


def _view(entry: dict) -> dict:
    """Una entry come la riceve il sito: per le citazioni dai testi, `source`
    ne riporta titolo e autore."""
    return {"id": entry["id"], "text": entry["text"], "source": entry.get("source")}


def _nearest(vector, entries: list[dict], count: int) -> list[tuple[float, dict]]:
    """Le entry dal significato piu' vicino al vettore dato, con la similarita'."""
    embeddings.ensure_entry_embeddings(entries)
    vectors = embeddings.load_entry_vectors()
    scored = [
        (embeddings.similarity(vector, vectors[e["id"]]), e)
        for e in entries
        if e["id"] in vectors
    ]
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return scored[:count]


def _consult(vector, already_shown: list[dict]) -> tuple[str, list[dict]]:
    """Consulta i testi letti: ritorna i passi piu' vicini (come blocco per
    il prompt) e, da mostrare, la frase che meglio risponde in ognuno dei
    primi, citata alla lettera con titolo e autore."""
    passages = embeddings.load_passages()
    if not passages:
        return "", []
    near = heapq.nlargest(
        READINGS, passages, key=lambda p: embeddings.similarity(vector, p["vector"])
    )
    block = READINGS_BLOCK.format(
        readings="\n".join(f"- {' '.join(p['text'].split()[:80])}" for p in near)
    )

    candidates = [
        (passage, sentence)
        for passage in near[:READINGS_SHOWN]
        for sentence in library.quotable_sentences(passage["text"], passage["kind"])
    ]
    if not candidates:
        return block, []
    best: dict[int, tuple[float, str, dict]] = {}
    vectors = embeddings.embed_texts([sentence for _, sentence in candidates])
    for (passage, sentence), sentence_vector in zip(candidates, vectors):
        score = embeddings.similarity(vector, sentence_vector)
        if passage["id"] not in best or score > best[passage["id"]][0]:
            best[passage["id"]] = (score, sentence, passage)
    taken = {entry["text"] for entry in already_shown}
    readings = [
        {"text": sentence, "title": passage["title"], "author": passage["author"]}
        for _, sentence, passage in sorted(best.values(), key=lambda item: item[0], reverse=True)
        if sentence not in taken
    ]
    return block, readings


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
        return {"answer": SILENCE, "entries": [], "readings": []}

    if question:
        vector = embeddings.embed_texts([question])[0]
        near = [entry for _, entry in _nearest(vector, entries, NEAREST)]
        block, readings = _consult(vector, near[:SHOWN])
        prompt = ANSWER_PROMPT.format(thoughts=_thoughts(near), readings=block, question=question)
        text = _generate(prompt, 0.9)
    else:
        near = random.sample(entries, min(6, len(entries)))
        # Senza domanda si consultano i testi sul tema della stella.
        vector = embeddings.embed_texts([f"{tag}. " + " ".join(e["text"] for e in near[:3])])[0]
        block, readings = _consult(vector, near[:SHOWN])
        prompt = VOICE_PROMPT.format(tag=tag, thoughts=_thoughts(near), readings=block)
        text = _generate(prompt, 0.8)
    return {
        "answer": text or SILENCE,
        "entries": [_view(e) for e in near[:SHOWN]],
        "readings": readings,
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


def ask(question: str) -> dict | None:
    """Indirizza la domanda a una stella e risponde. None se la nebulosa e'
    vuota (nessuna entry taggata)."""
    entries = _tagged_entries()
    if not entries:
        log.warning("Nessuna entry taggata: l'Oracolo non ha stelle a cui indirizzare")
        return None

    vector = embeddings.embed_texts([question])[0]
    scored = _nearest(vector, entries, NEAREST)
    ranked = _rank_tags(scored, entries)
    tag = ranked[0]
    near = [entry for _, entry in scored]
    # A chi ha chiesto si mostrano prima i pensieri della stella scelta.
    shown = sorted(near, key=lambda e: tag not in e["tags"])[:SHOWN]
    log.info("Domanda %r -> stella '%s'", question, tag)

    block, readings = _consult(vector, shown)
    prompt = ANSWER_PROMPT.format(thoughts=_thoughts(near), readings=block, question=question)
    text = _generate(prompt, 0.9)
    return {
        "question": question,
        "tag": tag,
        # stelle affini da attraversare prima di arrivare, dalla meno vicina
        "path": ranked[1:3][::-1],
        "answer": text or SILENCE,
        "entries": [_view(e) for e in shown],
        # citazioni dai testi letti, con titolo e autore
        "readings": readings,
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


def _plain(text: str) -> str:
    """Minuscolo e senza accenti: "liberta" e "libertà" sono la stessa parola."""
    return "".join(
        ch for ch in unicodedata.normalize("NFD", text.lower()) if not unicodedata.combining(ch)
    )


def star_question(tag: str, asked: str | None = None) -> str | None:
    """Una domanda che chi visita potrebbe fare e a cui la stella `tag`
    saprebbe rispondere. Con `asked` (la domanda che lo ha portato sulla
    stella dove si trova) la nuova domanda ne e' il passo successivo.
    None se la stella non esiste."""
    entries = [e for e in _tagged_entries() if tag in e["tags"]]
    if not entries:
        return None
    sample = random.sample(entries, min(5, len(entries)))
    prompt = STAR_QUESTION_PROMPT.format(
        tag=tag,
        thoughts=_thoughts(sample),
        asked=STAR_QUESTION_ASKED.format(question=asked) if asked else "",
        new="nuova " if asked else "",
        who="questa persona" if asked else "una persona",
        step=": come un passo successivo del suo cammino, non una ripetizione della domanda di prima"
        if asked else "",
    )
    fallback = None
    for attempt in range(QUESTION_ATTEMPTS):
        question = _generate(prompt, 0.9)
        words = question.split()
        if not question.endswith("?") or question.count("?") != 1 or len(words) > STAR_QUESTION_WORDS:
            log.debug("Domanda della stella scartata (tentativo %d): %r", attempt + 1, question)
            continue
        if _plain(tag) not in _plain(question):
            return question
        fallback = fallback or question  # nomina il tema: va bene se non c'e' di meglio
    if fallback is None:
        log.warning("Nessuna domanda accettabile per la stella '%s'", tag)
    return fallback


# ── Figure del viaggio ──
# Mentre il visitatore fa domande, la nebulosa disegna una costellazione con
# le stelle che attraversa (figures.ts nel sito). Quale figura nasce dipende
# da cio' che cerca: il viaggio (domande e stelle attraversate) si confronta
# per significato con quello di ogni figura. Gli identificativi devono essere
# gli stessi di figures.ts.
FIGURES = {
    "cuore": ("un cuore", "amore, innamorarsi, affetto, tenerezza, legami, desiderare qualcuno, cuore spezzato"),
    "rondine": ("una rondine", "libertà, partire, volare via, leggerezza, primavera, migrare, tornare da lontano"),
    "nave": ("una nave", "viaggio, mare, partenza, avventura, rotta, orizzonte, lontananza, esplorare"),
    "albero": ("un albero", "radici, crescere, famiglia, origini, antenati, natura, pazienza, generazioni"),
    "casa": ("una casa", "casa, ritorno, famiglia, sicurezza, appartenenza, rifugio, nostalgia di casa"),
    "farfalla": ("una farfalla", "trasformazione, cambiare, rinascere, crescere, fragilità, bellezza che dura poco"),
    "clessidra": ("una clessidra", "tempo, attesa, scadenze, invecchiare, il tempo che passa, fretta, futuro"),
    "occhio": ("un occhio", "consapevolezza, guardarsi dentro, verità, identità, conoscere se stessi, essere visti"),
    "luna": ("una luna", "sogno, notte, solitudine, malinconia, mistero, desideri nascosti, insonnia"),
    "chiave": ("una chiave", "segreti, risposte, soluzioni, aprirsi, possibilità, scelte, capire"),
    "fiamma": ("una fiamma", "passione, rabbia, energia, desiderio ardente, ribellione, bruciare"),
    "lacrima": ("una lacrima", "dolore, tristezza, perdita, lutto, pianto, ferita, mancanza di qualcuno"),
    "montagna": ("una montagna", "fatica, sfida, ostacoli, ambizione, superare i propri limiti, resistere"),
    "ponte": ("un ponte", "connessione, incontrarsi, relazioni, amicizia, comunicare, superare le distanze"),
    "leone": ("un leone", "coraggio, forza, fierezza, guidare gli altri, affrontare la paura"),
    "drago": ("un drago", "paura, mostri interiori, angoscia, potere, combattere, ciò che spaventa"),
    "pesce": ("un pesce", "emozioni profonde, lasciarsi andare, fluire, silenzio, profondità, acqua"),
    "lumaca": ("una lumaca", "lentezza, pazienza, calma, prendersi il proprio tempo, portarsi dietro la casa"),
    "scarabeo": ("uno scarabeo", "rinascita, costanza, lavoro quotidiano, fatica che diventa vita, ricominciare"),
}

FIGURE_PROMPT = """Sei l'Oracolo di una nebulosa fatta dei pensieri anonimi di tante persone. \
Mentre un visitatore viaggiava tra le stelle, la nebulosa ha preso la forma di {name}, \
figura di: {meaning}.

Le domande che ha fatto:
{questions}

Le stelle che ha attraversato: {tags}.

Pronuncia la rivelazione: una frase che leghi la figura al suo cammino con un'immagine concreta. Regole:
- in italiano, UNA SOLA frase (al massimo 24 parole), all'indicativo;
- dagli del tu e nomina la figura;
- non chiamarlo in nessun modo (niente figlio, amico, viandante, pellegrino);
- non spiegare e non dare consigli: parla come una sibilla;
- niente domande, niente virgolette, nessuna premessa.

Scrivi solo la frase."""

# Appellativi che il modello tende a usare anche se gli si chiede di no.
_CALLING = re.compile(
    r"\b(figli[oa]|amic[oa]|viandante|pellegrin[oa]|car[oa]|amat[oa])\b"
    r"|^(amore|tesoro|cuore|anima|bambin[oa]|stella|piccol[oa])\s*,",
    re.IGNORECASE,
)

_figure_vectors: dict[str, object] = {}


def _figure_vector(figure: str):
    """Vettore del significato di una figura (calcolato una volta sola)."""
    if figure not in _figure_vectors:
        name, meaning = FIGURES[figure]
        _figure_vectors[figure] = embeddings.embed_texts([f"{name}: {meaning}"])[0]
    return _figure_vectors[figure]


def figure(questions: list[str], tags: list[str], exclude: list[str] | None = None,
           chosen: str | None = None, speak: bool = True) -> dict:
    """La figura che il viaggio sta disegnando e, se `speak`, la frase con cui
    l'Oracolo la rivela. Con `chosen` la figura e' gia' decisa; altrimenti e'
    quella dal significato piu' vicino al viaggio, escluse `exclude` (le
    figure gia' rivelate in questa visita)."""
    if chosen not in FIGURES:
        journey = " ".join(questions) + " " + ", ".join(tags)
        vector = embeddings.embed_texts([journey])[0]
        candidates = [f for f in FIGURES if f not in (exclude or [])] or list(FIGURES)
        chosen = max(candidates, key=lambda f: embeddings.similarity(vector, _figure_vector(f)))
        log.info("Viaggio %r -> figura '%s'", journey[:80], chosen)
    name, meaning = FIGURES[chosen]
    text = None
    if speak:
        prompt = FIGURE_PROMPT.format(
            name=name,
            meaning=meaning,
            questions="\n".join(f"- {q}" for q in questions[-8:]),
            tags=", ".join(dict.fromkeys(tags)) or "nessuna",
        )
        for attempt in range(QUESTION_ATTEMPTS):
            said = _generate(prompt, 0.85).replace('"', "").strip()
            if said and not _FIRST_PERSON.search(said) and not _CALLING.search(said):
                text = said
                break
            log.debug("Rivelazione scartata (tentativo %d): %r", attempt + 1, said)
        text = text or f"La tua nebulosa ha preso la forma di {name}."
    return {"figure": chosen, "name": name, "text": text}
