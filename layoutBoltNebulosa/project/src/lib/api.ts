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

export type TagEntry = {
  id: number;
  text: string;
  likes: number;
};

export type RelatedTag = {
  name: string;
  weight: number;
  // Frasi che contengono entrambi i tag (al massimo 3): il motivo del
  // collegamento. Assente se il server non le fornisce.
  entries?: { id: number; text: string }[];
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
};

// Risposta a una domanda scritta dal visitatore: la stella a cui viene
// indirizzato, la risposta e i pensieri piu' vicini alla domanda.
export type OracleReply = {
  question: string;
  tag: string;
  answer: string;
  entries: OracleThought[];
};

export type OracleAnswer = {
  answer: string;
  entries?: OracleThought[];
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

// Domanda che l'Oracolo fa a chi si ferma sulla stella `tag`, tenendo conto
// delle tappe gia' fatte.
export async function fetchOracleQuestion(tag: string, trail: string[]): Promise<string> {
  const params = new URLSearchParams({ tag, trail: trail.join(',') });
  const res = await fetch(`${API_BASE}api/oracle/question?${params}`);
  if (!res.ok) throw await oracleError(res);
  return (await res.json()).question;
}

export async function fetchOracleAnswer(question: string, tag: string): Promise<OracleAnswer> {
  const res = await fetch(`${API_BASE}api/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, tag }),
  });
  if (!res.ok) throw await oracleError(res);
  return res.json();
}
