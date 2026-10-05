export type TagNode = {
  id: string;
  label: string;
  count: number;
  cluster: number;
};

export type TagLink = {
  source: string;
  target: string;
  value: number;
};

export type TagGraph = {
  nodes: TagNode[];
  links: TagLink[];
};

// Testo (libro, tesi, intervista) da cui e' tratta una citazione.
export type TextSource = {
  title: string;
  author: string;
};

export type TagEntry = {
  id: number;
  text: string;
  likes: number;
  // presente solo per le citazioni tratte da un testo letto dall'Oracolo
  source?: TextSource | null;
};

export type RelatedTag = {
  name: string;
  weight: number;
  // Frasi che contengono entrambi i tag (al massimo 3): il motivo del
  // collegamento. Assente se il server non le fornisce.
  entries?: { id: number; text: string; source?: TextSource | null }[];
};

export type TagDetail = {
  name: string;
  count: number;
  entries: TagEntry[];
  related: RelatedTag[];
};

// Percorso base del deploy (vite `base`): '/' in locale, la sottocartella
// dell'hosting in produzione. Le chiamate all'API restano relative ad esso,
// cosi' funzionano sia con il server Python locale sia con l'export statico.
const API_BASE = import.meta.env.BASE_URL;

export async function fetchGraph(): Promise<TagGraph> {
  const res = await fetch(`${API_BASE}api/graph`);
  if (!res.ok) throw new Error('Impossibile caricare la nebulosa dei tag');
  return res.json();
}

export async function fetchTagDetail(name: string): Promise<TagDetail> {
  const res = await fetch(`${API_BASE}api/tag/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`Tag "${name}" non trovato`);
  return res.json();
}

// ── L'Oracolo ──
// Pensiero della nebulosa a cui l'Oracolo si e' ispirato.
export type OracleThought = {
  id: number;
  text: string;
  source?: TextSource | null;
};

// Frase di un testo che l'Oracolo ha consultato per rispondere, citata alla
// lettera.
export type OracleReading = {
  text: string;
  title: string;
  author: string;
};

// Risposta a una domanda scritta dal visitatore: la stella a cui viene
// indirizzato, la risposta e i pensieri piu' vicini alla domanda.
export type OracleReply = {
  question: string;
  tag: string;
  // stelle affini da attraversare prima di arrivare a `tag`
  path: string[];
  answer: string;
  entries: OracleThought[];
  readings?: OracleReading[];
};

export type OracleAnswer = {
  answer: string;
  entries?: OracleThought[];
  readings?: OracleReading[];
};

async function oracleError(res: Response): Promise<Error> {
  const body = await res.json().catch(() => null);
  if (body?.error) return new Error(body.error);
  // Un 404 senza spiegazione viene da un server avviato prima che l'Oracolo
  // esistesse (o da un export statico, che non ha l'Oracolo).
  return new Error(
    res.status === 404
      ? "Questo server non conosce ancora l'Oracolo: va riavviato"
      : "L'oracolo non risponde"
  );
}

export async function askOracle(question: string): Promise<OracleReply> {
  const res = await fetch(`${API_BASE}api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) throw await oracleError(res);
  return res.json();
}

// Domande che chi visita potrebbe fare, da proporgli sopra la barra.
export async function fetchSuggestions(): Promise<string[]> {
  const res = await fetch(`${API_BASE}api/suggestions`);
  if (!res.ok) throw await oracleError(res);
  return (await res.json()).questions;
}

// Una domanda che rappresenta la stella `tag`, scritta di nuovo a ogni
// richiesta. `asked` e' la domanda che ha portato il visitatore dove si
// trova: la nuova ne e' il passo successivo.
export async function fetchStarQuestion(tag: string, asked: string | null): Promise<string> {
  const query = new URLSearchParams({ tag });
  if (asked) query.set('asked', asked);
  const res = await fetch(`${API_BASE}api/oracle/star-question?${query}`);
  if (!res.ok) throw await oracleError(res);
  return (await res.json()).question;
}

// La figura che il viaggio sta disegnando (vedi figures.ts) e, se `speak`,
// la frase con cui l'Oracolo la rivela. Con `figure` la figura e' gia' scelta.
export type FigureReply = { figure: string; name: string; text: string | null };
export async function fetchFigure(journey: {
  questions: string[];
  tags: string[];
  exclude?: string[];
  figure?: string;
  speak?: boolean;
}): Promise<FigureReply> {
  const res = await fetch(`${API_BASE}api/oracle/figure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(journey),
  });
  if (!res.ok) throw await oracleError(res);
  return res.json();
}

// Testo oracolare della stella `tag`: la risposta a `question` vista da quella
// stella oppure, senza domanda, una sentenza sul suo tema.
export async function fetchOracleAnswer(question: string | null, tag: string): Promise<OracleAnswer> {
  const res = await fetch(`${API_BASE}api/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, tag }),
  });
  if (!res.ok) throw await oracleError(res);
  return res.json();
}
