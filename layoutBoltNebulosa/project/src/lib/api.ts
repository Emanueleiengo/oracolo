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
