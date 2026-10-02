import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import { CircleHelp, Sparkles, X } from 'lucide-react';
import {
  askOracle,
  fetchGraph,
  fetchOracleAnswer,
  fetchSuggestions,
  fetchTagDetail,
  type TagDetail,
  type TagGraph,
} from '@/lib/api';
import TagDetailPanel, { type OracleState } from '@/components/TagDetailPanel';
import { SHAPE_KEYS, getConstellation, type Anchor, type Constellation, type ShapeId } from './constellation';

type GraphNode = {
  id: string;
  label: string;
  count: number;
  cluster: number;
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
  fx?: number;
  fy?: number;
  fz?: number;
  // Sfera disegnata dal grafo per questa stella (serve per lo scintillio).
  __threeObj?: StarObject;
};

// Cio' che ci serve della sfera three.js di una stella.
type StarObject = {
  scale: { setScalar: (s: number) => void };
  material?: {
    color: unknown;
    emissive?: { copy: (color: unknown) => void };
    emissiveIntensity?: number;
  };
};

type GraphLink = {
  source: string | GraphNode;
  target: string | GraphNode;
  value: number;
  constellation?: boolean;
};

const LINK_DISTANCE = 40;
const LINK_STRENGTH = 0.4;
const CHARGE_STRENGTH = -200;

// Distanza della camera da una stella quando ci si zooma sopra, e ingombro
// del pannello laterale (larghezza + margine, vedi .detail-dock in index.css):
// la stella viene portata al centro dello spazio libero a sinistra del pannello.
const FOCUS_DISTANCE = 170;
const PANEL_SPACE = 410;
const PANEL_MIN_VIEWPORT = 760;

// Durata del volo delle stelle (e della camera) quando si richiama una figura.
const MORPH_MS = 2200;
// Distanza da cui si vede tutta la nebulosa, per radice cubica del numero di
// stelle (e' la stessa da cui parte la camera all'apertura).
const OVERVIEW_DISTANCE = 170;
// Durata dell'allontanamento della camera quando si chiude la scheda.
const ZOOM_OUT_MS = 1400;

// Colore delle stelle per importanza (0 = tag con una sola frase, 1 = il tag
// piu' usato): da fredde a calde. Le fredde hanno un colore diverso ma
// vivo, non spento: sono la maggior parte della nebulosa e devono contare
// anche loro.
const IMPORTANCE_STOPS: [number, [number, number, number]][] = [
  [0, [138, 126, 255]],
  [0.3, [190, 164, 255]],
  [0.55, [242, 216, 224]],
  [0.78, [255, 214, 150]],
  [1, [255, 176, 84]],
];
// Luminosita' delle stelle meno importanti rispetto alle piu' importanti:
// appena piu' tenui, quanto basta a dare profondita'.
const FAINTEST_STAR = 0.86;

// Numero stabile tra 0 e 1 ricavato da un testo: da' a ogni stella una
// sfumatura e un ritmo suoi, uguali a ogni caricamento.
function hash01(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

// Il colore dato, con una lieve sfumatura diversa per ogni stella: nessuna
// e' identica a un'altra (e il grafo da' a ognuna il suo materiale, cosi' lo
// scintillio di una non trascina le altre).
function shaded(rgb: number[], id: string, alpha = 1): string {
  const [r, g, b] = rgb.map((v, channel) => {
    const shade = (hash01(`${id}:${channel}`) - 0.5) * 14;
    return Math.round(Math.min(255, Math.max(0, v + shade)));
  });
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
}

function importanceColor(importance: number, id: string): string {
  const t = Math.min(1, Math.max(0, importance));
  let i = 1;
  while (i < IMPORTANCE_STOPS.length - 1 && t > IMPORTANCE_STOPS[i][0]) i++;
  const [t0, c0] = IMPORTANCE_STOPS[i - 1];
  const [t1, c1] = IMPORTANCE_STOPS[i];
  const k = (t - t0) / (t1 - t0);
  return shaded(c0.map((v, channel) => v + (c1[channel] - v) * k), id, FAINTEST_STAR + (1 - FAINTEST_STAR) * t);
}

// Viaggio verso la stella trovata dall'Oracolo: quanto dura, e a che
// distanza la camera passa accanto alle stelle intermedie.
const TRAVEL_MS = 5200;
const TRAVEL_PASS_DISTANCE = 90;
// Distanza da cui si guardano una stella e le sue vicine quando si sceglie
// di viaggiare nella nebulosa.
const WANDER_DISTANCE = 430;
// Battito della stella aperta (e del suo alone): periodo in secondi e
// quanto si gonfia.
const PULSE_PERIOD = 2.6;
const PULSE_SWELL = 0.16;

type Vec3 = [number, number, number];

// Punto a frazione `u` (0-1) della curva morbida che passa per `points`
// (Catmull-Rom uniforme).
function alongPath(points: Vec3[], u: number): Vec3 {
  const last = points.length - 1;
  const scaled = Math.min(0.999999, Math.max(0, u)) * last;
  const i = Math.floor(scaled);
  const t = scaled - i;
  const p0 = points[Math.max(0, i - 1)];
  const p1 = points[i];
  const p2 = points[i + 1];
  const p3 = points[Math.min(last, i + 2)];
  return [0, 1, 2].map((axis) => 0.5 * (
    2 * p1[axis]
    + (p2[axis] - p0[axis]) * t
    + (2 * p0[axis] - 5 * p1[axis] + 4 * p2[axis] - p3[axis]) * t * t
    + (3 * p1[axis] - p0[axis] - 3 * p2[axis] + p3[axis]) * t * t * t
  )) as Vec3;
}

// Raggio (nelle unita' del grafo) della luce soffusa attorno alla stella
// aperta: circa quattro volte il raggio della stella.
const GLOW_RADIUS = 34;

// Colore delle stelle quando formano una figura.
const FIGURE_STAR_RGB = [255, 241, 207];

// Scintillio: quanto aumenta la luminosita' al culmine, quanto si gonfia la
// stella, e l'intervallo dei periodi (in secondi).
const TWINKLE_GLOW = 0.55;
const TWINKLE_SWELL = 0.07;
const TWINKLE_PERIOD: [number, number] = [3.5, 8];

// Colore del viaggio (stelle gia' aperte e tratti percorsi): azzurro, per
// distinguerlo dall'oro delle stelle collegate a quella aperta.
const TRAIL_COLOR = '#5fe0ff';
const TRAIL_LINK_COLOR = 'rgba(95, 224, 255, 0.9)';

const emptyGraph: TagGraph = { nodes: [], links: [] };

type ForceGraphHandle = {
  cameraPosition: (pos: { x?: number; y?: number; z?: number }, lookAt?: { x: number; y: number; z: number }, ms?: number) => void;
  camera: () => {
    position: { x: number; y: number; z: number };
    fov: number;
    aspect: number;
    matrixWorldInverse: { elements: number[] };
  };
  graph2ScreenCoords: (x: number, y: number, z: number) => { x: number; y: number };
  controls: () => unknown;
  d3Force: (name: string, force?: ((alpha: number) => void) | null) => unknown;
  d3ReheatSimulation: () => void;
};

// Proprieta' di OrbitControls (three.js) che regoliamo per la navigazione.
type OrbitSettings = {
  enableDamping: boolean;
  dampingFactor: number;
  rotateSpeed: number;
  zoomSpeed: number;
  panSpeed: number;
  screenSpacePanning: boolean;
  zoomToCursor: boolean;
  minDistance: number;
  maxDistance: number;
};

const endpoints = (link: GraphLink): [string, string] => [
  typeof link.source === 'string' ? link.source : link.source.id,
  typeof link.target === 'string' ? link.target : link.target.id,
];

// Chiave di un collegamento, uguale nei due versi.
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export default function App() {
  const [graphData, setGraphData] = useState<TagGraph>(emptyGraph);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Presentazione dell'Oracolo: si apre dal pulsante "?" in alto a destra.
  const [showAbout, setShowAbout] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResultsVisible, setSearchResultsVisible] = useState(false);
  // La barra in basso invita a fare una domanda finche' non la si usa.
  const [inviting, setInviting] = useState(true);
  // Cosa dice l'Oracolo nella scheda della stella aperta (vedi OracleState).
  const [oracle, setOracle] = useState<OracleState | null>(null);
  // Vero mentre l'Oracolo cerca la stella per una domanda del visitatore.
  const [asking, setAsking] = useState(false);
  // Vero mentre la camera viaggia verso la stella trovata.
  const [traveling, setTraveling] = useState(false);
  // Domanda del visitatore che guida il viaggio: ogni stella che apre gli
  // risponde a modo suo, finche' non ne fa un'altra.
  const [visitorQuestion, setVisitorQuestion] = useState<string | null>(null);
  // Domande proposte sopra la barra.
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [highlightedIds, setHighlightedIds] = useState<string[]>([]);
  const [detailTag, setDetailTag] = useState<TagDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelHoverId, setPanelHoverId] = useState<string | null>(null);
  // Viaggio nella nebulosa: le stelle aperte una dopo l'altra, finche' ognuna
  // e' collegata alla precedente. Restano illuminate (anche a scheda chiusa)
  // e il percorso riparte da capo quando si apre una stella non collegata
  // all'ultima.
  const [trail, setTrail] = useState<string[]>([]);
  // Figura in cui sono organizzate le stelle (null = nebulosa libera). Si
  // richiama con i tasti di SHAPE_KEYS; lo stesso tasto o Esc la sciolgono.
  // Finche' e' attiva le stelle rimaste libere si attenuano; i collegamenti
  // tra le stelle restano visibili come nella nebulosa.
  const [activeShape, setActiveShape] = useState<ShapeId | null>(null);
  const shapeActive = activeShape !== null;

  const graphRef = useRef<ForceGraphHandle | undefined>(undefined);
  const glowRef = useRef<HTMLDivElement>(null);
  // Ultima stella richiesta: evita che una scheda lenta ne sovrascriva una piu' recente.
  const selectionRef = useRef<string | null>(null);
  // Se le stelle sono (o erano fino a un attimo fa) organizzate in una figura.
  const shapeWasActive = useRef(false);
  // Testi gia' detti dall'Oracolo, per domanda e stella: riaprendo una
  // stella si ritrova lo stesso.
  const oracleTexts = useRef(new Map<string, Pick<OracleState, 'text' | 'entries' | 'readings'>>());
  const askInputRef = useRef<HTMLInputElement>(null);
  // Fotogramma in corso del viaggio della camera (0 = nessun viaggio).
  const travelFrame = useRef(0);
  // Stella aperta, leggibile dal ciclo che anima le stelle.
  const selectedRef = useRef<string | null>(null);

  // ── Load the tag graph from Oracolo ──
  const loadGraph = useCallback(async () => {
    try {
      const data = await fetchGraph();
      setGraphData(data);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Impossibile caricare la nebulosa');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadGraph();
  }, [loadGraph]);

  // Le stelle sono sempre gli stessi oggetti: il grafo ne aggiorna la
  // posizione (x, y, z) e le figure le spostano (fx, fy, fz), quindi non
  // vanno ricreate quando cambia la figura.
  const nodes = useMemo<GraphNode[]>(() => graphData.nodes.map((n) => ({ ...n })), [graphData.nodes]);
  const tagLinks = useMemo<GraphLink[]>(() => graphData.links.map((l) => ({ ...l })), [graphData.links]);

  // ── Costellazioni: la figura attiva viene costruita su misura per il
  // numero di tag (vedi constellation.ts) e i tag piu' usati ne occupano le
  // stelle. Stessi tag ad ogni caricamento, cosi' il disegno e' stabile. ──
  const constellation = useMemo(() => {
    const anchorByTag = new Map<string, Anchor>();
    const outlineLinks: GraphLink[] = [];
    let view: Constellation['view'] | null = null;
    if (activeShape) {
      const sorted = [...graphData.nodes].sort(
        (a, b) => b.count - a.count || a.id.localeCompare(b.id)
      );
      const shape = getConstellation(activeShape, sorted.length);
      shape.anchors.forEach((anchor, i) => anchorByTag.set(sorted[i].id, anchor));
      shape.edges.forEach(([a, b]) => {
        outlineLinks.push({ source: sorted[a].id, target: sorted[b].id, value: 1, constellation: true });
      });
      view = shape.view;
    }
    return { anchorByTag, outlineLinks, view };
  }, [graphData.nodes, activeShape]);

  const graph = useMemo<{ nodes: GraphNode[]; links: GraphLink[] }>(() => ({
    nodes,
    links: [...tagLinks, ...constellation.outlineLinks],
  }), [nodes, tagLinks, constellation]);

  // Colore di ogni stella libera, secondo quante frasi ha il suo tag (in
  // scala logaritmica: pochi tag hanno moltissime frasi).
  const starColors = useMemo(() => {
    const max = Math.max(1, ...graphData.nodes.map((n) => n.count));
    return new Map(graphData.nodes.map((n) => [
      n.id,
      importanceColor(max > 1 ? Math.log(Math.max(1, n.count)) / Math.log(max) : 0.5, n.id),
    ]));
  }, [graphData.nodes]);

  // Scintillio: ogni stella si accende e si gonfia appena, lentamente e con
  // un ritmo suo. Agisce sulla sfera gia' disegnata dal grafo, senza
  // cambiarne colore o grandezza di base.
  useEffect(() => {
    if (loading) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const rhythms = nodes.map((node) => ({
      node,
      speed: (2 * Math.PI) / (TWINKLE_PERIOD[0] + hash01(`${node.id}:ritmo`) * (TWINKLE_PERIOD[1] - TWINKLE_PERIOD[0])),
      phase: hash01(`${node.id}:fase`) * 2 * Math.PI,
    }));
    let frame = 0;
    const tick = (now: number) => {
      // Battito della stella aperta: e' viva, sta parlando.
      const beat = 0.5 + 0.5 * Math.sin((now / 1000) * ((2 * Math.PI) / PULSE_PERIOD));
      for (const { node, speed, phase } of rhythms) {
        const star = node.__threeObj;
        if (!star) continue;
        const alive = node.id === selectedRef.current;
        // 0 a riposo, 1 al culmine; al quadrato perche' il culmine sia breve.
        const wave = alive ? beat : Math.pow(0.5 + 0.5 * Math.sin((now / 1000) * speed + phase), 2);
        star.scale.setScalar(1 + (alive ? PULSE_SWELL : TWINKLE_SWELL) * wave);
        if (star.material?.emissive) {
          star.material.emissive.copy(star.material.color);
          star.material.emissiveIntensity = TWINKLE_GLOW * wave;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      for (const { node } of rhythms) {
        node.__threeObj?.scale.setScalar(1);
        if (node.__threeObj?.material?.emissive) node.__threeObj.material.emissiveIntensity = 0;
      }
    };
  }, [nodes, loading]);

  // Luce soffusa della stella aperta: un alone (vedi .star-glow) che la
  // segue sullo schermo e cresce o si riduce con la distanza della camera.
  useEffect(() => {
    const glow = glowRef.current;
    if (!glow) return;
    const node = selectedId ? nodes.find((n) => n.id === selectedId) : undefined;
    if (!node) {
      glow.style.opacity = '0';
      return;
    }
    let frame = 0;
    const follow = (now: number) => {
      const fg = graphRef.current;
      if (fg && node.x != null && node.y != null && node.z != null) {
        const cam = fg.camera();
        // Distanza della stella davanti alla camera (negativa se e' dietro).
        const m = cam.matrixWorldInverse.elements;
        const ahead = -(m[2] * node.x + m[6] * node.y + m[10] * node.z + m[14]);
        if (ahead > 1) {
          const { x, y } = fg.graph2ScreenCoords(node.x, node.y, node.z);
          const viewHeight = glow.parentElement?.querySelector('canvas')?.clientHeight ?? window.innerHeight;
          const pxPerUnit = viewHeight / 2 / Math.tan((cam.fov * Math.PI) / 360) / ahead;
          // L'alone respira insieme al battito della stella.
          const beat = 0.5 + 0.5 * Math.sin((now / 1000) * ((2 * Math.PI) / PULSE_PERIOD));
          const size = GLOW_RADIUS * 2 * pxPerUnit * (1 + 0.22 * beat);
          glow.style.width = `${size}px`;
          glow.style.height = `${size}px`;
          glow.style.transform = `translate(${x - size / 2}px, ${y - size / 2}px)`;
          glow.style.opacity = String(0.7 + 0.3 * beat);
        } else {
          glow.style.opacity = '0';
        }
      }
      frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(frame);
  }, [selectedId, nodes]);

  // Allontana la camera fino a inquadrare tutta la nebulosa, restando nella
  // direzione da cui la sta guardando.
  const starCount = nodes.length;
  const flyToOverview = useCallback((ms: number) => {
    const fg = graphRef.current;
    if (!fg) return;
    const cam = fg.camera().position;
    const len = Math.hypot(cam.x, cam.y, cam.z) || 1;
    const distance = Math.cbrt(starCount) * OVERVIEW_DISTANCE;
    fg.cameraPosition(
      { x: (cam.x / len) * distance, y: (cam.y / len) * distance, z: (cam.z / len) * distance },
      { x: 0, y: 0, z: 0 },
      ms
    );
  }, [starCount]);

  // Quando si richiama una figura, le sue stelle volano da dove si trovano
  // al loro posto nel disegno mentre la camera raggiunge il punto di vista.
  // Quando la figura viene sciolta tornano libere e la nebulosa le riassorbe.
  useEffect(() => {
    const fg = graphRef.current;
    const flights: { node: GraphNode; from: [number, number, number]; to: Anchor }[] = [];
    for (const node of nodes) {
      const to = constellation.anchorByTag.get(node.id);
      if (to) {
        flights.push({ node, from: [node.x ?? 0, node.y ?? 0, node.z ?? 0], to });
      } else {
        node.fx = undefined;
        node.fy = undefined;
        node.fz = undefined;
      }
    }
    fg?.d3ReheatSimulation();
    if (!flights.length) {
      // Figura appena sciolta: la camera torna a inquadrare tutta la
      // nebulosa (se era zoomata su una stella resterebbe a guardare il
      // vuoto).
      if (shapeWasActive.current) flyToOverview(MORPH_MS);
      shapeWasActive.current = false;
      return;
    }
    shapeWasActive.current = true;
    if (constellation.view) fg?.cameraPosition(constellation.view.position, constellation.view.lookAt, MORPH_MS);

    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / MORPH_MS);
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      for (const { node, from, to } of flights) {
        node.fx = from[0] + (to.x - from[0]) * eased;
        node.fy = from[1] + (to.y - from[1]) * eased;
        node.fz = from[2] + (to.z - from[2]) * eased;
      }
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [constellation, nodes, flyToOverview]);

  // ── Forze e navigazione: vanno impostate solo dopo che il grafo e' montato
  // (cioe' a caricamento finito). ──
  useEffect(() => {
    if (loading) return;
    const configure = () => {
      const fg = graphRef.current;
      if (!fg) return false;

      // Attrazione lungo i collegamenti e repulsione tra le stelle: insieme
      // decidono quanto si allarga la nebulosa quando le stelle sono libere.
      const linkForce = fg.d3Force('link') as { distance: (d: number) => void; strength: (s: number) => void } | undefined;
      linkForce?.distance(LINK_DISTANCE);
      linkForce?.strength(LINK_STRENGTH);
      const charge = fg.d3Force('charge') as { strength: (s: number) => void } | undefined;
      charge?.strength(CHARGE_STRENGTH);
      fg.d3ReheatSimulation();

      // Navigazione: rotazione con inerzia, zoom verso il puntatore (si
      // "entra" nella nebulosa dove si guarda), spostamento laterale con
      // tasto destro oppure Shift/Cmd + trascinamento.
      const controls = fg.controls() as Partial<OrbitSettings> | undefined;
      if (!controls) return false;
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.rotateSpeed = 0.6;
      controls.zoomSpeed = 1.4;
      controls.panSpeed = 1;
      controls.screenSpacePanning = true;
      controls.zoomToCursor = true;
      controls.minDistance = 6;
      controls.maxDistance = 5000;
      return true;
    };
    if (configure()) return;
    const retry = window.setTimeout(configure, 150);
    return () => window.clearTimeout(retry);
  }, [loading, graph.nodes]);

  // ── Search: live results as the user types, no submit needed ──
  const searchMatches = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return [];
    return graph.nodes
      .filter((n) => n.label.toLowerCase().includes(term))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  }, [searchTerm, graph.nodes]);

  useEffect(() => {
    setHighlightedIds(searchMatches.map((n) => n.id));
  }, [searchMatches]);

  // Inquadratura di una stella aperta: la camera le sta davanti, nella
  // direzione da cui la si guardava, e la mira e' spostata un po' a destra
  // cosi' che la stella finisca nello spazio libero a sinistra del pannello.
  const focusView = useCallback((node: GraphNode) => {
    const fg = graphRef.current;
    if (!fg || node.x == null || node.y == null || node.z == null) return null;
    const cam = fg.camera();

    let dx = cam.position.x - node.x;
    let dy = cam.position.y - node.y;
    let dz = cam.position.z - node.z;
    let len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) { dx = 0; dy = 0; dz = 1; len = 1; }
    dx /= len; dy /= len; dz /= len;

    // "Destra" dello schermo per una camera con su = asse y.
    let rx = dz;
    let rz = -dx;
    const rlen = Math.hypot(rx, rz);
    if (rlen < 1e-3) { rx = 1; rz = 0; } else { rx /= rlen; rz /= rlen; }

    const panelOpen = window.innerWidth >= PANEL_MIN_VIEWPORT;
    const share = panelOpen ? Math.min(0.45, PANEL_SPACE / window.innerWidth) : 0;
    const halfWidth = FOCUS_DISTANCE * Math.tan((cam.fov * Math.PI) / 360) * cam.aspect;
    const shift = share * halfWidth;

    return {
      position: { x: node.x + dx * FOCUS_DISTANCE, y: node.y + dy * FOCUS_DISTANCE, z: node.z + dz * FOCUS_DISTANCE },
      lookAt: { x: node.x + rx * shift, y: node.y, z: node.z + rz * shift },
    };
  }, []);

  // Zoom su una stella.
  const flyToNode = useCallback((node: GraphNode) => {
    const view = focusView(node);
    if (view) graphRef.current?.cameraPosition(view.position, view.lookAt, 1000);
  }, [focusView]);

  // Stelle collegate a quella selezionata (tutte, dal grafo completo).
  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const add = (from: string, to: string) => {
      if (!map.has(from)) map.set(from, new Set());
      map.get(from)!.add(to);
    };
    graphData.links.forEach((l) => {
      add(l.source, l.target);
      add(l.target, l.source);
    });
    return map;
  }, [graphData.links]);
  const linkedIds = useMemo(
    () => (selectedId ? adjacency.get(selectedId) ?? new Set<string>() : new Set<string>()),
    [adjacency, selectedId]
  );

  // Stelle e collegamenti del viaggio, per colorarli (vedi trail).
  const trailIds = useMemo(() => new Set(trail), [trail]);
  const trailSteps = useMemo(() => {
    const steps = new Set<string>();
    for (let i = 1; i < trail.length; i++) steps.add(pairKey(trail[i - 1], trail[i]));
    return steps;
  }, [trail]);

  // Apre un tag: zoom sulla stella (a meno che la camera non ci sia gia'
  // arrivata da sola: `fly` falso), illumina le collegate e carica la scheda.
  const openTag = useCallback(async (id: string, fly = true) => {
    selectionRef.current = id;
    setSelectedId(id);
    setSearchResultsVisible(false);
    const node = graph.nodes.find((n) => n.id === id);
    if (node && fly) flyToNode(node);
    try {
      const detail = await fetchTagDetail(id);
      if (selectionRef.current === id) setDetailTag(detail);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Impossibile caricare il tag');
    }
  }, [graph.nodes, flyToNode]);

  // Seleziona un tag: lo apre e lo aggiunge al viaggio (che riparte da capo
  // se non e' collegato all'ultima tappa).
  const selectTag = useCallback((id: string, fly = true) => {
    setTrail((current) => {
      const last = current[current.length - 1];
      if (last === id) return current;
      return last !== undefined && adjacency.get(last)?.has(id) ? [...current, id] : [id];
    });
    openTag(id, fly);
  }, [adjacency, openTag]);

  // Torna a una tappa precedente del viaggio: le tappe successive si spengono.
  const backToTrailStep = useCallback((index: number) => {
    const id = trail[index];
    if (id === undefined) return;
    setTrail(trail.slice(0, index + 1));
    openTag(id);
  }, [trail, openTag]);

  // Chiude la scheda. Se era aperta la camera si allontana dalla stella:
  // torna a inquadrare la figura attiva, oppure tutta la nebulosa. Con
  // `zoomOut` falso la camera resta ferma (serve quando sta gia' per partire
  // un altro volo, come al cambio di figura).
  const closeDetail = useCallback((zoomOut = true) => {
    const wasOpen = selectionRef.current !== null;
    selectionRef.current = null;
    setSelectedId(null);
    setPanelHoverId(null);
    setDetailTag(null);
    if (!zoomOut || !wasOpen) return;
    if (constellation.view) {
      graphRef.current?.cameraPosition(constellation.view.position, constellation.view.lookAt, ZOOM_OUT_MS);
    } else {
      flyToOverview(ZOOM_OUT_MS);
    }
  }, [constellation.view, flyToOverview]);

  const selectSearchResult = (node: GraphNode) => {
    selectTag(node.id);
  };

  // ── L'Oracolo ──
  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);

  // Domande suggerite a chi entra, e a chi ne vuole fare un'altra.
  const loadSuggestions = useCallback(async () => {
    try {
      setSuggestions(await fetchSuggestions());
    } catch {
      setSuggestions([]);
    }
  }, []);

  useEffect(() => {
    if (!loading) loadSuggestions();
  }, [loading, loadSuggestions]);

  // Testo oracolare della stella `tag`: la risposta alla domanda del
  // visitatore vista da quella stella oppure, senza domanda, una sentenza
  // sul suo tema.
  const loadOracleText = useCallback(async (tag: string, question: string | null) => {
    const key = `${question ?? ''}|${tag}`;
    const known = oracleTexts.current.get(key);
    setOracle({ tag, question, text: known?.text ?? null, entries: known?.entries ?? [], readings: known?.readings ?? [], silent: false });
    if (known) return;
    const stillHere = (current: OracleState | null) => current?.tag === tag && current.question === question;
    try {
      const reply = await fetchOracleAnswer(question, tag);
      const voice = { text: reply.answer, entries: reply.entries ?? [], readings: reply.readings ?? [] };
      oracleTexts.current.set(key, voice);
      setOracle((current) => (stillHere(current) ? { ...current!, ...voice } : current));
    } catch {
      // Senza Oracolo (Ollama spento, export statico) il riquadro non compare.
      setOracle((current) => (stillHere(current) ? { ...current!, silent: true } : current));
    }
  }, []);

  // Ogni stella che si apre ha il suo testo oracolare.
  useEffect(() => {
    if (!selectedId || oracle?.tag === selectedId) return;
    loadOracleText(selectedId, visitorQuestion);
  }, [selectedId, oracle, visitorQuestion, loadOracleText]);

  useEffect(() => () => cancelAnimationFrame(travelFrame.current), []);

  // Viaggio: la camera entra nella nebulosa, passa accanto alle stelle `via`
  // e si ferma davanti a `target`, dove chiama `onArrive`.
  const travelTo = useCallback((target: GraphNode, via: GraphNode[], onArrive: () => void) => {
    const fg = graphRef.current;
    const end = focusView(target);
    if (!fg || !end || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      if (end) fg?.cameraPosition(end.position, end.lookAt, 0);
      onArrive();
      return;
    }
    const cam = fg.camera().position;
    const points: Vec3[] = [[cam.x, cam.y, cam.z]];
    for (const star of via) {
      if (star.x == null || star.y == null || star.z == null) continue;
      // Accanto alla stella, dal lato da cui si arriva: non ci si passa dentro.
      const prev = points[points.length - 1];
      const d: Vec3 = [prev[0] - star.x, prev[1] - star.y, prev[2] - star.z];
      const len = Math.hypot(d[0], d[1], d[2]) || 1;
      points.push([
        star.x + (d[0] / len) * TRAVEL_PASS_DISTANCE,
        star.y + (d[1] / len) * TRAVEL_PASS_DISTANCE,
        star.z + (d[2] / len) * TRAVEL_PASS_DISTANCE,
      ]);
    }
    points.push([end.position.x, end.position.y, end.position.z]);

    const aim = (fg.controls() as { target?: { x: number; y: number; z: number } } | undefined)?.target;
    const from: Vec3 = aim ? [aim.x, aim.y, aim.z] : [0, 0, 0];
    const to: Vec3 = [end.lookAt.x, end.lookAt.y, end.lookAt.z];
    const start = performance.now();
    setTraveling(true);
    cancelAnimationFrame(travelFrame.current);
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / TRAVEL_MS);
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const [x, y, z] = alongPath(points, eased);
      // Lo sguardo si volta verso la stella di arrivo gia' nella prima parte
      // del viaggio, cosi' la si vede avvicinarsi.
      const turn = Math.min(1, eased * 1.7);
      const k = turn * turn * (3 - 2 * turn);
      fg.cameraPosition(
        { x, y, z },
        { x: from[0] + (to[0] - from[0]) * k, y: from[1] + (to[1] - from[1]) * k, z: from[2] + (to[2] - from[2]) * k },
        0
      );
      if (t < 1) {
        travelFrame.current = requestAnimationFrame(step);
      } else {
        travelFrame.current = 0;
        setTraveling(false);
        onArrive();
      }
    };
    travelFrame.current = requestAnimationFrame(step);
  }, [focusView]);

  // Il visitatore fa una domanda: l'Oracolo trova la stella che raccoglie i
  // pensieri piu' vicini, la nebulosa lo porta fin li' e la stella risponde.
  const askTheOracle = useCallback(async (text: string) => {
    const question = text.trim();
    if (!question || asking || traveling) return;
    setAsking(true);
    setSearchResultsVisible(false);
    askInputRef.current?.blur();
    try {
      const reply = await askOracle(question);
      const target = nodes.find((n) => n.id === reply.tag);
      if (!target) throw new Error("L'oracolo indica una stella che non c'e'");
      const via = (reply.path ?? [])
        .map((id) => nodes.find((n) => n.id === id))
        .filter((n): n is GraphNode => n !== undefined);
      const voice = { text: reply.answer, entries: reply.entries, readings: reply.readings ?? [] };
      oracleTexts.current.set(`${question}|${reply.tag}`, voice);
      setVisitorQuestion(question);
      setSearchTerm('');
      closeDetail(false);
      travelTo(target, via, () => {
        setOracle({ tag: reply.tag, question, silent: false, ...voice });
        selectTag(reply.tag, false);
      });
    } catch (err) {
      // Senza Oracolo resta la ricerca per nome: si apre il primo tag trovato.
      const first = searchMatches[0];
      if (first) selectTag(first.id);
      else setLoadError(err instanceof Error ? err.message : "L'oracolo non risponde");
    } finally {
      setAsking(false);
    }
  }, [asking, traveling, nodes, closeDetail, travelTo, selectTag, searchMatches]);

  // Dopo aver letto la risposta: un'altra domanda...
  const askAnother = useCallback(() => {
    setVisitorQuestion(null);
    closeDetail();
    loadSuggestions();
    askInputRef.current?.focus();
  }, [closeDetail, loadSuggestions]);

  // ...oppure viaggiare nella nebulosa: la scheda si chiude e la camera
  // arretra quanto basta a vedere la stella con le sue vicine, da puntare.
  const wander = useCallback(() => {
    const fg = graphRef.current;
    const node = nodes.find((n) => n.id === selectedId);
    closeDetail(false);
    if (!fg || !node || node.x == null || node.y == null || node.z == null) return;
    const cam = fg.camera().position;
    const d: Vec3 = [cam.x - node.x, cam.y - node.y, cam.z - node.z];
    const len = Math.hypot(d[0], d[1], d[2]) || 1;
    fg.cameraPosition(
      {
        x: node.x + (d[0] / len) * WANDER_DISTANCE,
        y: node.y + (d[1] / len) * WANDER_DISTANCE,
        z: node.z + (d[2] / len) * WANDER_DISTANCE,
      },
      { x: node.x, y: node.y, z: node.z },
      ZOOM_OUT_MS
    );
  }, [nodes, selectedId, closeDetail]);

  const submitSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    askTheOracle(searchTerm);
  };

  const handleNodeClick = (node: GraphNode) => {
    selectTag(node.id);
  };

  // Tasti: Esc chiude la scheda e scioglie la figura; i tasti di SHAPE_KEYS
  // organizzano le stelle in una figura (premendo di nuovo lo stesso tasto
  // tornano libere).
  useEffect(() => {
    if (loading) return;
    const onKey = (event: KeyboardEvent) => {
      // Con la presentazione aperta, Esc la chiude e gli altri tasti aspettano.
      if (showAbout) {
        if (event.key === 'Escape') setShowAbout(false);
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      if (event.key === 'Escape') {
        // Se c'e' una figura, sciogliendola la camera torna gia' alla
        // nebulosa intera.
        closeDetail(activeShape === null);
        setActiveShape(null);
      }
      const shape = SHAPE_KEYS[event.key.toLowerCase()];
      if (shape) {
        closeDetail(false);
        setActiveShape((current) => (current === shape ? null : shape));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeDetail, activeShape, loading, showAbout]);

  const isNearHovered = (node: GraphNode) => {
    if (selectedId || !hoveredNode) return false;
    if (node.x == null || node.y == null || node.z == null) return false;
    if (hoveredNode.x == null || hoveredNode.y == null || hoveredNode.z == null) return false;
    return Math.hypot(node.x - hoveredNode.x, node.y - hoveredNode.y, node.z - hoveredNode.z) < 120;
  };

  // L'Oracolo sta cercando la stella o la nebulosa ci sta portando li'.
  const busy = asking || traveling;

  if (loading) {
    return (
      <main className="oracle-shell" style={{ cursor: 'wait' }}>
        <div className="loading-screen">
          <div className="loading-orb" />
        </div>
      </main>
    );
  }

  return (
    <main className="oracle-shell">
      <div className="aurora aurora-one" />
      <div className="aurora aurora-two" />
      <div className="star-field" />
      <div
        className="graph-layer"
        onPointerDown={() => {
          // La barra perde il fuoco: i tasti tornano a comandare le figure.
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        }}
      >
        <ForceGraph3D
          ref={graphRef as never}
          graphData={graph}
          controlType="orbit"
          backgroundColor="rgba(0,0,0,0)"
          nodeRelSize={4}
          d3AlphaDecay={0.02}
          d3VelocityDecay={0.32}
          cooldownTime={Infinity}
          linkColor={(link: GraphLink) => {
            const [source, target] = endpoints(link);
            const travelled = !link.constellation && trailSteps.has(pairKey(source, target));
            if (selectedId) {
              if (link.constellation) return 'rgba(255, 222, 158, 0.22)';
              if (travelled) return TRAIL_LINK_COLOR;
              if (source === selectedId || target === selectedId) return 'rgba(255, 236, 200, 0.95)';
              return 'rgba(210, 193, 174, 0.06)';
            }
            if (link.constellation) return 'rgba(255, 232, 178, 0.95)';
            if (travelled) return TRAIL_LINK_COLOR;
            const active = highlightedIds.includes(source) || highlightedIds.includes(target);
            return active ? 'rgba(243, 197, 139, 0.45)' : 'rgba(210, 193, 174, 0.28)';
          }}
          linkWidth={(link: GraphLink) => {
            const [source, target] = endpoints(link);
            if (link.constellation) return 1.4;
            if (trailSteps.has(pairKey(source, target))) return 1.8;
            if (selectedId && (source === selectedId || target === selectedId)) return 1.8;
            return highlightedIds.includes(source) || highlightedIds.includes(target) ? 1.1 : 0.6;
          }}
          linkDirectionalParticles={(link: GraphLink) => {
            if (link.constellation) return 0;
            const [source, target] = endpoints(link);
            if (selectedId) return source === selectedId || target === selectedId ? 5 : 0;
            return highlightedIds.includes(source) || highlightedIds.includes(target) ? 4 : 2;
          }}
          linkDirectionalParticleWidth={(link: GraphLink) => {
            const [source, target] = endpoints(link);
            if (selectedId && (source === selectedId || target === selectedId)) return 3;
            return highlightedIds.includes(source) || highlightedIds.includes(target) ? 2.6 : 1.8;
          }}
          linkDirectionalParticleColor={(link: GraphLink) => {
            const [source, target] = endpoints(link);
            return trailSteps.has(pairKey(source, target)) ? TRAIL_COLOR : '#f3c58b';
          }}
          linkDirectionalParticleSpeed={0.0035}
          nodeColor={(node: GraphNode) => {
            const anchored = constellation.anchorByTag.has(node.id);
            if (selectedId) {
              if (node.id === selectedId || node.id === panelHoverId) return '#ffffff';
              if (trailIds.has(node.id)) return TRAIL_COLOR;
              if (linkedIds.has(node.id)) return '#ffd58a';
              if (highlightedIds.includes(node.id)) return '#fff0d0';
              return anchored ? 'rgba(255, 227, 173, 0.28)' : 'rgba(200, 190, 180, 0.2)';
            }
            if (trailIds.has(node.id)) return TRAIL_COLOR;
            if (shapeActive) return anchored ? shaded(FIGURE_STAR_RGB, node.id) : 'rgba(200, 190, 180, 0.12)';
            const active = highlightedIds.includes(node.id);
            const nearby = isNearHovered(node);
            if (active) return '#fff0d0';
            if (nearby) return '#f3c58b';
            return starColors.get(node.id) ?? '#e9d6cd';
          }}
          nodeVal={(node: GraphNode) => {
            // Stelle della figura: grandezza uniforme sullo schermo dal punto
            // di vista giusto (il raggio cresce con la distanza, quindi il
            // volume con depth^3). Le altre restano proporzionali ai frammenti.
            const anchor = constellation.anchorByTag.get(node.id);
            const base = anchor
              ? 2.2 * Math.pow(anchor.depth, 3)
              : 1.4 + Math.min(node.count, 8) * 0.3;
            if (shapeActive && !selectedId) return anchor ? base * 1.15 : base * 0.5;
            if (selectedId) {
              if (node.id === selectedId) return base * 3;
              if (node.id === panelHoverId) return base * 3.2;
              // Le collegate si accendono ma restano piu' piccole della stella
              // aperta: e' lei che sta parlando.
              if (trailIds.has(node.id) || linkedIds.has(node.id)) return base * 1.3;
              return base * 0.8;
            }
            if (trailIds.has(node.id)) return base * 2;
            const active = highlightedIds.includes(node.id);
            const nearby = isNearHovered(node);
            return active ? base * 2.4 : nearby ? base * 1.7 : base;
          }}
          nodeOpacity={0.95}
          nodeResolution={24}
          nodeLabel={(node: GraphNode) => node.label}
          onNodeHover={(node: GraphNode | null) => setHoveredNode(node)}
          onNodeClick={handleNodeClick}
          showNavInfo={false}
        />
        <div ref={glowRef} className="star-glow" aria-hidden="true" />
      </div>

      <header className="topbar">
        <div className="brand-lockup">
          <div>
            <p className="eyebrow">Oracolo</p>
            <h1>LA NEBULOSA</h1>
          </div>
        </div>
        <div className="header-center"><span className="status-dot" />Frammento <span className="header-divider" /> {graphData.nodes.length} tag condivisi</div>
        <div className="header-actions">
          <a className="help-button" href={`${import.meta.env.BASE_URL}question.html`} aria-label="L'oracolo"><Sparkles size={16} strokeWidth={1.5} /></a>
          <button className="help-button" type="button" aria-label="Cos'è l'Oracolo" onClick={() => setShowAbout(true)}><CircleHelp size={17} strokeWidth={1.5} /></button>
        </div>
      </header>

      <aside className="side-panel left-panel">
        <p className="field-title">Un archivio di <br /><em>memorie collettive.</em></p>
        <p className="field-copy">Ogni tag nasce da un pensiero condiviso e si lega agli altri che ne condividono il tema. Esplora la nebulosa per scoprire come si intrecciano.</p>
        <div className="rule" />
        <div className="metric-grid">
          <div><strong>{graphData.nodes.length}</strong><span>tag</span></div>
          <div><strong>{graphData.links.length}</strong><span>connessioni</span></div>
        </div>
      </aside>

      {suggestions.length > 0 && !selectedId && !busy && !shapeActive && !searchTerm.trim() && (
        <div className="oracle-suggestions" aria-label="Domande suggerite">
          {suggestions.map((question) => (
            <button key={question} type="button" onClick={() => askTheOracle(question)}>{question}</button>
          ))}
        </div>
      )}

      <form
        className={`oracle-input-wrap${busy ? ' is-asking' : ''}${inviting ? ' is-inviting' : ''}`}
        onSubmit={submitSearch}
      >
        <div className="input-icon"><Sparkles size={17} strokeWidth={1.5} /></div>
        <input
          ref={askInputRef}
          value={searchTerm}
          disabled={busy}
          onChange={(event) => {
            setSearchTerm(event.target.value);
            setSearchResultsVisible(true);
          }}
          onFocus={() => {
            setInviting(false);
            setSearchResultsVisible(true);
          }}
          onBlur={() => setTimeout(() => setSearchResultsVisible(false), 120)}
          placeholder="Fai una domanda all'Oracolo, o cerca un tag"
          aria-label="Fai una domanda all'Oracolo o cerca un tag"
        />
        {busy && (
          <span className="oracle-asking">
            {traveling ? 'la nebulosa ti porta dalla tua stella…' : "l'Oracolo cerca tra le stelle…"}
          </span>
        )}
        {searchResultsVisible && !busy && searchTerm.trim() && (
          <ul className="search-results">
            <li>
              <button type="button" className="search-ask" onMouseDown={(e) => e.preventDefault()} onClick={() => askTheOracle(searchTerm)}>
                <span className="search-result-label">Chiedi all'Oracolo: «{searchTerm.trim()}»</span>
                <span className="search-result-count">invio</span>
              </button>
            </li>
            {searchMatches.map((node) => (
              <li key={node.id}>
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => selectSearchResult(node)}>
                  <span className="search-result-label">{node.label}</span>
                  <span className="search-result-count">{node.count}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </form>

      {loadError && (
        <div className="error-toast">
          <span>{loadError}</span>
          <button onClick={() => setLoadError(null)}><X size={14} /></button>
        </div>
      )}

      <div className="bottom-caption">
        Trascina: ruota &nbsp;·&nbsp; Rotella: zoom &nbsp;·&nbsp; Shift + trascina: sposta
      </div>

      <TagDetailPanel
        tag={detailTag}
        linkedCount={linkedIds.size}
        trail={trail}
        oracle={oracle}
        onClose={() => closeDetail()}
        onSelectTag={selectTag}
        onTrailStep={backToTrailStep}
        onHoverTag={setPanelHoverId}
        onAskAnother={askAnother}
        onWander={wander}
      />

      {showAbout && (
        <div className="about-overlay" role="dialog" aria-label="Cos'è l'Oracolo" onClick={() => setShowAbout(false)}>
          <div className="loading-screen flex flex-col items-center justify-center text-center px-6">
            <div className="loading-orb" />
            <p className="max-w-2xl mt-6" style={{ fontSize: '13px', lineHeight: '1.6' }}>
              L'Oracolo è una mente collettiva open source che si dirama in mille frammenti incandescenti. È uno strumento, un archivio, un ambiente generativo, un agglomeratore di pensieri, testi, file, fonti e prende la forma di ciò da cui è composto. È una nebulosa mutaforma messa a disposizione del Viandante, che è uno stato d'animo: è il divergente, il ricercatore, l'esploratore; quello che si fa domande.
            </p>
            <p className="pt-12 text-sm text-[#F3C58B] animate-pulse">
              [ TORNA ALLA NEBULOSA ]
            </p>
          </div>
        </div>
      )}
    </main>
  );
}
