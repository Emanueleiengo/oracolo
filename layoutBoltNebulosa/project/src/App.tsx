import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import { CircleHelp, Sparkles, X } from 'lucide-react';
import {
  askOracle,
  fetchFigure,
  fetchGraph,
  fetchOracleAnswer,
  fetchStarQuestion,
  fetchSuggestions,
  fetchTagDetail,
  type TagDetail,
  type TagGraph,
} from '@/lib/api';
import TagDetailPanel, { type AskedQuestion, type OracleState } from '@/components/TagDetailPanel';
import { SHAPE_KEYS, getConstellation, placeFigure, type Anchor, type Constellation, type ShapeId } from './constellation';
import { FIGURES, type FigureId } from './figures';

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

// Inquadratura di una stella aperta: la camera si allontana quanto basta a
// mostrare anche le stelle a cui e' collegata. Si tiene dentro questa parte
// delle collegate (le piu' lontane di un tema molto collegato possono restare
// fuori), con un raggio comunque tra il minimo e il massimo, e un margine.
const FOCUS_NEIGHBORS_SHOWN = 0.8;
const FOCUS_MIN_REACH = 60;
const FOCUS_MAX_REACH = 190;
// Le stelle che mostrano la loro domanda (vedi STAR_QUESTIONS) restano
// comunque nell'inquadratura, fino a questa distanza.
const FOCUS_MAX_QUESTION_REACH = 260;
const FOCUS_MARGIN = 1.15;
const FOCUS_MIN_DISTANCE = 240;
// Parte dell'altezza dello schermo utile per l'inquadratura: in alto c'e'
// l'intestazione, in basso la barra delle domande.
const FOCUS_VERTICAL_ROOM = 0.72;
// Ingombro del pannello laterale (larghezza + margine, vedi .detail-dock in
// index.css): la stella viene portata al centro dello spazio libero a
// sinistra del pannello.
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

// Durata del volo verso una stella aperta con un click.
const FLY_MS = 1400;
// Viaggio verso una stella: dura TRAVEL_BASE_MS piu' TRAVEL_MS_PER_UNIT per
// ogni unita' di strada, tra TRAVEL_MIN_MS (un salto tra stelle vicine) e
// TRAVEL_MAX_MS (il tuffo nella nebulosa dopo una domanda scritta).
// TRAVEL_PASS_DISTANCE e' la distanza a cui la camera passa accanto alle
// stelle intermedie (abbastanza da vederle scorrere, non tanto vicino da
// riempire lo schermo).
const TRAVEL_BASE_MS = 900;
const TRAVEL_MS_PER_UNIT = 2.6;
const TRAVEL_MIN_MS = 1500;
const TRAVEL_MAX_MS = 5000;
const TRAVEL_PASS_DISTANCE = 200;
// In sosta su una stella la camera le gira attorno piano (radianti al
// secondo: un giro ogni quasi 9 minuti), cominciando dopo ORBIT_DELAY_MS e
// prendendo velocita' in ORBIT_RAMP_MS. Si ferma mentre il mouse e' su una
// domanda, cosi' la si legge e la si sceglie senza inseguirla.
const ORBIT_SPEED = 0.012;
const ORBIT_DELAY_MS = 1500;
const ORBIT_RAMP_MS = 2500;
// Mentre l'Oracolo cerca, la nebulosa attira a se': la camera avanza
// lentamente e le gira un poco attorno. In DRIFT_MS fa quasi tutto il tratto:
// si avvicina di DRIFT_PUSH (parte della distanza) e gira di DRIFT_TURN
// radianti, rallentando senza fermarsi di colpo.
const DRIFT_MS = 8000;
const DRIFT_PUSH = 0.3;
const DRIFT_TURN = 0.5;
// Quando si sceglie di viaggiare nella nebulosa la camera arretra dalla
// stella: di WANDER_PULLBACK volte la distanza a cui era, e almeno fino a
// WANDER_DISTANCE, cosi' si vedono anche le stelle attorno da puntare.
const WANDER_DISTANCE = 430;
const WANDER_PULLBACK = 1.25;
// Attorno alla stella aperta, le stelle vicine mostrano una domanda che le
// rappresenta: sceglierla e' fare quella domanda, e la stella risponde. Sono
// le STAR_QUESTIONS piu' legate (con piu' frasi in comune; a parita', a
// caso), escluse quelle gia' attraversate nel viaggio. QUESTION_GAP e' lo
// spazio in pixel tra la stella e la sua domanda.
const STAR_QUESTIONS = 6;
const QUESTION_GAP = 14;
// ── Figura del viaggio (vedi figures.ts) ──
// Dopo FIGURE_AFTER domande l'Oracolo sceglie la figura che il viaggio sta
// disegnando e ne arriva al suo posto una prima parte; poi un'altra parte a
// ogni domanda, finche' dopo FIGURE_STEPS parti e' completa. A quel punto si
// rivela FIGURE_REVEAL_MS dopo l'arrivo su una stella (o subito, dal
// pulsante nella scheda). FIGURE_FLIGHT_MS e' il volo di una stella verso
// il suo posto, FIGURE_LINE_MS il tempo in cui una linea si accende.
const FIGURE_AFTER = 2;
const FIGURE_STEPS = 4;
const FIGURE_REVEAL_MS = 6000;
const FIGURE_FLIGHT_MS = 2800;
const FIGURE_LINE_MS = 900;
const FIGURE_COLOR = '#ffe2a8';
// Battito della stella aperta (e del suo alone): periodo in secondi e
// quanto si gonfia.
const PULSE_PERIOD = 2.6;
const PULSE_SWELL = 0.16;

type Vec3 = [number, number, number];

// Domanda che rappresenta una stella vicina a quella aperta.
type StarQuestion = { tag: string; text: string };

// La figura che il viaggio sta disegnando: dove va ogni sua stella, quale
// stella (tag) la occupa (null = posto ancora vuoto), quante parti sono
// arrivate e a quante domande si era quando e' arrivata l'ultima.
type JourneyFigure = {
  id: FigureId;
  name: string;
  anchors: Anchor[];
  view: Constellation['view'];
  stars: (string | null)[];
  steps: number;
  grownAt: number;
  // frase della rivelazione (null finche' l'Oracolo non l'ha scritta)
  text: string | null;
};

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

// La stessa curva, ma con `u` = parte della lunghezza gia' percorsa: con
// alongPath ogni tratto dura uguale, corto o lungo che sia, e la camera
// cambierebbe velocita' di colpo a ogni stella.
function evenPath(points: Vec3[], samples = 240): { at: (u: number) => Vec3; length: number } {
  const marks: Vec3[] = [];
  const lengths: number[] = [];
  for (let i = 0; i <= samples; i++) {
    const p = alongPath(points, i / samples);
    const q = marks[i - 1];
    lengths.push(q ? lengths[i - 1] + Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) : 0);
    marks.push(p);
  }
  const total = lengths[samples] || 1;
  const at = (u: number): Vec3 => {
    const goal = Math.min(1, Math.max(0, u)) * total;
    let lo = 0;
    let hi = samples;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (lengths[mid] <= goal) lo = mid; else hi = mid;
    }
    const k = (goal - lengths[lo]) / (lengths[hi] - lengths[lo] || 1);
    const a = marks[lo];
    const b = marks[hi];
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  };
  return { at, length: lengths[samples] };
}

// Chi ha chiesto al sistema meno animazioni salta i movimenti di camera.
function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

// Da 0 a 1 partendo e arrivando con dolcezza (accelerazione nulla agli estremi).
function smoother(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * x * (x * (6 * x - 15) + 10);
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
  // Domande delle stelle vicine a quella aperta (vedi STAR_QUESTIONS),
  // scritte di nuovo a ogni visita: compaiono man mano che arrivano.
  const [starQuestions, setStarQuestions] = useState<StarQuestion[]>([]);
  // Cronologia delle domande di tutta la visita, nell'ordine in cui sono
  // state fatte (scritte nella barra o scelte accanto alle stelle).
  const [history, setHistory] = useState<AskedQuestion[]>([]);
  // Figura che il viaggio sta disegnando, e se la si sta guardando rivelata.
  const [figure, setFigure] = useState<JourneyFigure | null>(null);
  const [revealing, setRevealing] = useState(false);
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
  // Stelle vicine scelte per mostrare la loro domanda: si decidono quando la
  // camera vola verso la stella, cosi' l'inquadratura le comprende.
  const questionStarsRef = useRef<{ id: string; tags: string[] } | null>(null);
  // Le domande sullo schermo, che il ciclo di disegno sposta con le stelle.
  const questionLabels = useRef(new Map<string, HTMLButtonElement>());
  // Il viaggio, leggibile quando si scelgono le stelle vicine.
  const trailRef = useRef<string[]>([]);
  // Vero mentre il mouse e' su una domanda: la camera smette di girare.
  const orbitPaused = useRef(false);
  // Stelle della figura (le altre parti della pagina devono lasciarle stare),
  // quando ognuna e' arrivata al suo posto (per accendere le linee), e il
  // ciclo delle figure: da quale domanda conta, se l'Oracolo sta scegliendo,
  // quali figure ha gia' rivelato in questa visita.
  const figureStars = useRef(new Set<string>());
  const figureArrivals = useRef(new Map<string, number>());
  const figureCycle = useRef({ from: 0, choosing: false, shown: [] as FigureId[] });
  const figureLines = useRef<(SVGLineElement | null)[]>([]);

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

  // Stelle collegate a ciascuna stella (tutte, dal grafo completo).
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
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  // Quante frasi hanno in comune due stelle collegate.
  const linkWeights = useMemo(
    () => new Map(graphData.links.map((l) => [pairKey(l.source, l.target), l.value])),
    [graphData.links]
  );

  useEffect(() => { trailRef.current = trail; }, [trail]);

  // Sceglie le stelle vicine a `id` che mostreranno la loro domanda (vedi
  // STAR_QUESTIONS) e le ricorda per quando la stella si apre.
  const planQuestionStars = useCallback((id: string) => {
    const visited = new Set(trailRef.current);
    const strength = new Map<string, number>();
    for (const other of adjacency.get(id) ?? []) {
      // Il caso (meno di 1) decide solo a parita' di frasi in comune.
      if (visited.has(other) || figureStars.current.has(other)) continue;
      strength.set(other, (linkWeights.get(pairKey(id, other)) ?? 1) + Math.random() * 0.9);
    }
    const tags = [...strength.keys()].sort((a, b) => strength.get(b)! - strength.get(a)!).slice(0, STAR_QUESTIONS);
    questionStarsRef.current = { id, tags };
    return tags;
  }, [adjacency, linkWeights]);

  // Raggio attorno alla stella entro cui stanno le sue collegate (vedi
  // FOCUS_NEIGHBORS_SHOWN), allargato se serve a comprendere le stelle
  // `kept`.
  const neighborhoodReach = useCallback((node: GraphNode, kept: string[] = []) => {
    const distanceTo = (id: string) => {
      const other = nodeById.get(id);
      if (other?.x == null || other.y == null || other.z == null) return null;
      return Math.hypot(other.x - node.x!, other.y - node.y!, other.z - node.z!);
    };
    // Le stelle volate nella figura del viaggio non sono piu' attorno a lei.
    const distances = [...(adjacency.get(node.id) ?? [])]
      .filter((id) => !figureStars.current.has(id))
      .map(distanceTo)
      .filter((d): d is number => d !== null)
      .sort((a, b) => a - b);
    const shown = distances.length
      ? distances[Math.min(distances.length - 1, Math.floor(distances.length * FOCUS_NEIGHBORS_SHOWN))]
      : FOCUS_MIN_REACH;
    const reach = Math.min(FOCUS_MAX_REACH, Math.max(FOCUS_MIN_REACH, shown));
    const farthestKept = Math.max(0, ...kept.map(distanceTo).filter((d): d is number => d !== null));
    return Math.max(reach, Math.min(FOCUS_MAX_QUESTION_REACH, farthestKept));
  }, [adjacency, nodeById]);

  // Inquadratura di una stella aperta: la camera la guarda dalla direzione
  // da cui la si guardava, da lontano quanto basta a vedere anche le stelle
  // collegate, e la mira e' spostata un po' a destra cosi' che la stella
  // finisca al centro dello spazio libero a sinistra del pannello.
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
    const tanHalf = Math.tan((cam.fov * Math.PI) / 360);
    // Mezza apertura utile: in verticale tra intestazione e barra, in
    // orizzontale lo spazio libero accanto al pannello.
    const room = Math.min(tanHalf * FOCUS_VERTICAL_ROOM, tanHalf * cam.aspect * (1 - share));
    const reach = neighborhoodReach(node, planQuestionStars(node.id));
    const distance = Math.max(FOCUS_MIN_DISTANCE, (reach * FOCUS_MARGIN) / room);
    const shift = share * distance * tanHalf * cam.aspect;

    return {
      position: { x: node.x + dx * distance, y: node.y + dy * distance, z: node.z + dz * distance },
      lookAt: { x: node.x + rx * shift, y: node.y, z: node.z + rz * shift },
    };
  }, [neighborhoodReach, planQuestionStars]);

  // Zoom su una stella.
  const flyToNode = useCallback((node: GraphNode) => {
    const view = focusView(node);
    if (view) graphRef.current?.cameraPosition(view.position, view.lookAt, FLY_MS);
  }, [focusView]);

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

  // Attesa della risposta: la camera avanza piano verso dove guarda e gira
  // un poco attorno (vedi DRIFT_MS), finche' non parte il viaggio.
  const driftFrame = useRef(0);
  const stopDrift = useCallback(() => {
    cancelAnimationFrame(driftFrame.current);
    driftFrame.current = 0;
  }, []);
  const startDrift = useCallback(() => {
    const fg = graphRef.current;
    if (!fg || reducedMotion()) return;
    const target = (fg.controls() as { target?: { x: number; y: number; z: number } } | undefined)?.target;
    const aim = { x: target?.x ?? 0, y: target?.y ?? 0, z: target?.z ?? 0 };
    const cam = fg.camera().position;
    const off: Vec3 = [cam.x - aim.x, cam.y - aim.y, cam.z - aim.z];
    const start = performance.now();
    stopDrift();
    const step = (now: number) => {
      // Parte da ferma, poi rallenta avvicinandosi alla fine del tratto.
      const t = (now - start) / DRIFT_MS;
      const k = 1 - (1 + 3 * t) * Math.exp(-3 * t);
      const cos = Math.cos(DRIFT_TURN * k);
      const sin = Math.sin(DRIFT_TURN * k);
      const scale = 1 - DRIFT_PUSH * k;
      fg.cameraPosition(
        {
          x: aim.x + (off[0] * cos + off[2] * sin) * scale,
          y: aim.y + off[1] * scale,
          z: aim.z + (off[2] * cos - off[0] * sin) * scale,
        },
        aim,
        0
      );
      driftFrame.current = requestAnimationFrame(step);
    };
    driftFrame.current = requestAnimationFrame(step);
  }, [stopDrift]);

  useEffect(() => () => {
    cancelAnimationFrame(travelFrame.current);
    cancelAnimationFrame(driftFrame.current);
  }, []);

  // Viaggio: la camera entra nella nebulosa, passa accanto alle stelle `via`
  // e si ferma davanti a `target`, dove chiama `onArrive`. `from` e' la
  // stella da cui si parte, se si salta da una stella all'altra.
  const travelTo = useCallback((
    target: GraphNode,
    { via = [], from }: { via?: GraphNode[]; from?: GraphNode },
    onArrive: () => void = () => {}
  ) => {
    stopDrift();
    const fg = graphRef.current;
    const end = focusView(target);
    if (!fg || !end || reducedMotion()) {
      if (end) fg?.cameraPosition(end.position, end.lookAt, 0);
      onArrive();
      return;
    }
    const cam = fg.camera().position;
    const arrival: Vec3 = [end.position.x, end.position.y, end.position.z];
    const star: Vec3 = [target.x ?? 0, target.y ?? 0, target.z ?? 0];
    const gap = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const points: Vec3[] = [[cam.x, cam.y, cam.z]];
    for (const passing of via.slice(0, 2)) {
      if (passing.x == null || passing.y == null || passing.z == null) continue;
      // Accanto alla stella, dal lato da cui si arriva: non ci si passa dentro.
      const prev = points[points.length - 1];
      const d: Vec3 = [prev[0] - passing.x, prev[1] - passing.y, prev[2] - passing.z];
      const len = Math.hypot(d[0], d[1], d[2]) || 1;
      const point: Vec3 = [
        passing.x + (d[0] / len) * TRAVEL_PASS_DISTANCE,
        passing.y + (d[1] / len) * TRAVEL_PASS_DISTANCE,
        passing.z + (d[2] / len) * TRAVEL_PASS_DISTANCE,
      ];
      // Solo se avvicina all'arrivo senza andare piu' vicino alla stella di
      // quanto ci si fermera': altrimenti la camera andrebbe oltre e
      // tornerebbe indietro.
      if (gap(point, arrival) < gap(prev, arrival) * 0.8 && gap(point, star) > gap(arrival, star) * 0.9) {
        points.push(point);
      }
    }
    points.push(arrival);

    const aim = (fg.controls() as { target?: { x: number; y: number; z: number } } | undefined)?.target;
    const lookFrom: Vec3 = aim ? [aim.x, aim.y, aim.z] : [0, 0, 0];
    const to: Vec3 = [end.lookAt.x, end.lookAt.y, end.lookAt.z];
    const mix = (a: Vec3, b: Vec3, k: number): Vec3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

    // Dove stanno camera e sguardo a frazione `e` del viaggio, e quanta strada si fa.
    let place: (e: number) => { camera: Vec3; look: Vec3 };
    let length: number;
    if (from && points.length === 2) {
      // Salto tra stelle: la camera accompagna lo sguardo da una stella
      // all'altra restando alla stessa distanza (cambia solo quanto serve per
      // la nuova inquadratura), senza avvicinarsi e riallontanarsi.
      const startOffset: Vec3 = [cam.x - lookFrom[0], cam.y - lookFrom[1], cam.z - lookFrom[2]];
      const endOffset: Vec3 = [arrival[0] - to[0], arrival[1] - to[1], arrival[2] - to[2]];
      const startLen = Math.hypot(...startOffset) || 1;
      const endLen = Math.hypot(...endOffset) || 1;
      const startDir = startOffset.map((v) => v / startLen) as Vec3;
      const endDir = endOffset.map((v) => v / endLen) as Vec3;
      length = gap(lookFrom, to);
      place = (e) => {
        const look = mix(lookFrom, to, e);
        const dir = mix(startDir, endDir, e);
        const scale = (startLen + (endLen - startLen) * e) / (Math.hypot(...dir) || 1);
        return { camera: [look[0] + dir[0] * scale, look[1] + dir[1] * scale, look[2] + dir[2] * scale], look };
      };
    } else {
      const path = evenPath(points);
      length = path.length;
      place = (e) => {
        // Lo sguardo si volta verso la stella di arrivo gia' nella prima
        // parte del viaggio, cosi' la si vede avvicinarsi.
        const turn = Math.min(1, e * 1.7);
        return { camera: path.at(e), look: mix(lookFrom, to, turn * turn * (3 - 2 * turn)) };
      };
    }
    const duration = Math.min(TRAVEL_MAX_MS, Math.max(TRAVEL_MIN_MS, TRAVEL_BASE_MS + length * TRAVEL_MS_PER_UNIT));

    const start = performance.now();
    setTraveling(true);
    cancelAnimationFrame(travelFrame.current);
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const { camera, look } = place(smoother(t));
      fg.cameraPosition(
        { x: camera[0], y: camera[1], z: camera[2] },
        { x: look[0], y: look[1], z: look[2] },
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
  }, [focusView, stopDrift]);

  // ── Figura del viaggio (vedi FIGURE_AFTER) ──
  useEffect(() => {
    figureStars.current = new Set(figure?.stars.filter((tag): tag is string => tag !== null) ?? []);
  }, [figure]);

  // Le `count` stelle da mandare nella figura: prima quelle attraversate
  // (dalla piu' recente: il cammino diventa la figura), poi le loro vicine
  // piu' legate, poi le piu' importanti della nebulosa. Mai la stella dove
  // il visitatore si trova o sta andando, ne' quelle che gli mostrano una
  // domanda.
  const figureCandidates = useCallback((count: number, taken: Set<string>) => {
    const planned = questionStarsRef.current;
    const excluded = new Set<string>([
      ...taken,
      ...(selectedId ? [selectedId] : []),
      ...(planned ? [planned.id, ...planned.tags] : []),
      ...starQuestions.map((q) => q.tag),
    ]);
    const picked: string[] = [];
    const take = (tag: string) => {
      if (picked.length >= count || excluded.has(tag) || !nodeById.has(tag)) return;
      picked.push(tag);
      excluded.add(tag);
    };
    const visited = history.map((step) => step.tag).reverse();
    visited.forEach(take);
    for (const tag of visited) {
      const weight = (other: string) => linkWeights.get(pairKey(tag, other)) ?? 0;
      [...(adjacency.get(tag) ?? [])].sort((a, b) => weight(b) - weight(a)).forEach(take);
    }
    [...nodes].sort((a, b) => b.count - a.count).forEach((node) => take(node.id));
    return picked;
  }, [selectedId, starQuestions, history, nodeById, linkWeights, adjacency, nodes]);

  // Un'altra parte della figura: i primi posti ancora vuoti, nell'ordine
  // del disegno, ricevono le loro stelle.
  const growFigure = useCallback((current: JourneyFigure, asked: number): JourneyFigure => {
    const empty = current.stars.flatMap((tag, i) => (tag ? [] : [i]));
    const slots = empty.slice(0, Math.ceil(current.stars.length / FIGURE_STEPS));
    const tags = figureCandidates(slots.length, new Set(current.stars.filter((t): t is string => t !== null)));
    const stars = [...current.stars];
    slots.forEach((slot, i) => {
      if (tags[i]) stars[slot] = tags[i];
    });
    return { ...current, stars, steps: current.steps + 1, grownAt: asked };
  }, [figureCandidates]);

  // A ogni nuova domanda la figura cresce; se non c'e' ancora e il viaggio
  // e' abbastanza lungo, l'Oracolo la sceglie.
  useEffect(() => {
    const asked = history.length;
    const cycle = figureCycle.current;
    if (figure) {
      if (figure.steps < FIGURE_STEPS && asked > figure.grownAt) setFigure(growFigure(figure, asked));
      return;
    }
    if (cycle.choosing || asked - cycle.from < FIGURE_AFTER) return;
    cycle.choosing = true;
    const journey = history.slice(cycle.from);
    fetchFigure({
      questions: journey.map((step) => step.question),
      tags: journey.map((step) => step.tag),
      exclude: cycle.shown,
      speak: false,
    })
      .then((reply) => {
        const id = reply.figure as FigureId;
        const drawing = FIGURES[id];
        if (!drawing) return;
        const { anchors, view } = placeFigure(drawing.points, nodes.length, asked + cycle.shown.length * 7);
        const empty = drawing.points.map(() => null);
        setFigure(growFigure({ id, name: reply.name, anchors, view, stars: empty, steps: 0, grownAt: asked, text: null }, asked));
      })
      .catch(() => {
        // Senza Oracolo il viaggio non disegna figure.
      })
      .finally(() => {
        cycle.choosing = false;
      });
    // Solo a ogni nuova domanda: il resto si legge com'e' in quel momento.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history.length]);

  // Completata la figura, l'Oracolo prepara la frase con cui la rivelera'.
  useEffect(() => {
    if (!figure || figure.steps < FIGURE_STEPS || figure.text) return;
    const id = figure.id;
    const journey = history.slice(figureCycle.current.from);
    const fallback = `La tua nebulosa ha preso la forma di ${figure.name}.`;
    const settle = (text: string) => setFigure((f) => (f && f.id === id ? { ...f, text } : f));
    fetchFigure({ questions: journey.map((s) => s.question), tags: journey.map((s) => s.tag), figure: id })
      .then((reply) => settle(reply.text || fallback))
      .catch(() => settle(fallback));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [figure?.id, figure?.steps]);

  // Le stelle appena entrate nella figura volano al loro posto (e ci
  // tornano se una figura dei tasti le aveva liberate).
  useEffect(() => {
    if (!figure || shapeActive) return;
    const flights: { node: GraphNode; tag: string; from: Vec3; to: Anchor }[] = [];
    figure.stars.forEach((tag, i) => {
      const node = tag ? nodeById.get(tag) : undefined;
      const to = figure.anchors[i];
      if (!tag || !node || node.fx === to.x) return;
      flights.push({ node, tag, from: [node.x ?? 0, node.y ?? 0, node.z ?? 0], to });
    });
    if (!flights.length) return;
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const e = smoother((now - start) / FIGURE_FLIGHT_MS);
      for (const { node, from, to } of flights) {
        node.fx = from[0] + (to.x - from[0]) * e;
        node.fy = from[1] + (to.y - from[1]) * e;
        node.fz = from[2] + (to.z - from[2]) * e;
      }
      if (e < 1) {
        frame = requestAnimationFrame(step);
      } else {
        for (const { node, tag, to } of flights) {
          // esatti: e' cosi' che si riconosce una stella gia' al suo posto
          node.fx = to.x;
          node.fy = to.y;
          node.fz = to.z;
          figureArrivals.current.set(tag, now);
        }
      }
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [figure?.stars, shapeActive, nodeById]);

  // Fine della figura: le sue stelle tornano libere e la nebulosa le
  // riassorbe; il prossimo ciclo conta le domande da qui.
  const endFigure = useCallback(() => {
    for (const tag of figureStars.current) {
      const node = nodeById.get(tag);
      if (node) {
        node.fx = undefined;
        node.fy = undefined;
        node.fz = undefined;
      }
    }
    figureStars.current = new Set();
    figureArrivals.current.clear();
    if (figure) figureCycle.current.shown.push(figure.id);
    figureCycle.current.from = history.length;
    setFigure(null);
    setRevealing(false);
    graphRef.current?.d3ReheatSimulation();
  }, [figure, history.length, nodeById]);

  // Rivelazione: la scheda si chiude e la camera va nel punto da cui la
  // figura si legge, dove compare la frase dell'Oracolo.
  const revealFigure = useCallback(() => {
    if (!figure || revealing) return;
    setRevealing(true);
    closeDetail(false);
    graphRef.current?.cameraPosition(figure.view.position, figure.view.lookAt, FIGURE_FLIGHT_MS);
  }, [figure, revealing, closeDetail]);

  // Completa, la figura si rivela da sola poco dopo l'arrivo su una stella
  // (il tempo di leggere la risposta), se il visitatore non riparte prima.
  useEffect(() => {
    if (!figure || figure.steps < FIGURE_STEPS || revealing || !selectedId || traveling || asking) return;
    const timer = window.setTimeout(revealFigure, FIGURE_REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, [figure, revealing, selectedId, traveling, asking, revealFigure]);

  // Dopo la rivelazione il viaggio riprende dall'ultima stella.
  const resumeJourney = useCallback(() => {
    const last = history[history.length - 1];
    endFigure();
    if (!last) {
      flyToOverview(ZOOM_OUT_MS);
      return;
    }
    setVisitorQuestion(last.question);
    loadOracleText(last.tag, last.question);
    selectTag(last.tag);
  }, [history, endFigure, flyToOverview, loadOracleText, selectTag]);

  // Tratti della figura (coppie di posti) e stelle che la formano.
  const figureSegments = useMemo(
    () => (figure ? FIGURES[figure.id].chains.flatMap((chain) => chain.slice(1).map((b, i) => [chain[i], b] as const)) : []),
    [figure?.id]
  );
  const figureIds = useMemo(
    () => new Set(figure?.stars.filter((tag): tag is string => tag !== null) ?? []),
    [figure?.stars]
  );

  // Le linee della figura seguono le sue stelle sullo schermo e si
  // accendono quando entrambe le stelle sono arrivate al loro posto.
  useEffect(() => {
    if (!figure || figureSegments.length === 0) return;
    let frame = 0;
    const draw = (now: number) => {
      const fg = graphRef.current;
      if (fg) {
        const m = fg.camera().matrixWorldInverse.elements;
        const ahead = (n: GraphNode) => -(m[2] * (n.x ?? 0) + m[6] * (n.y ?? 0) + m[10] * (n.z ?? 0) + m[14]);
        figureSegments.forEach(([a, b], i) => {
          const line = figureLines.current[i];
          if (!line) return;
          const ta = figure.stars[a];
          const tb = figure.stars[b];
          const na = ta ? nodeById.get(ta) : undefined;
          const nb = tb ? nodeById.get(tb) : undefined;
          const arrived = Math.max(figureArrivals.current.get(ta ?? '') ?? Infinity, figureArrivals.current.get(tb ?? '') ?? Infinity);
          if (!na || !nb || !Number.isFinite(arrived) || ahead(na) <= 1 || ahead(nb) <= 1) {
            line.style.opacity = '0';
            return;
          }
          const p = fg.graph2ScreenCoords(na.x ?? 0, na.y ?? 0, na.z ?? 0);
          const q = fg.graph2ScreenCoords(nb.x ?? 0, nb.y ?? 0, nb.z ?? 0);
          line.setAttribute('x1', String(p.x));
          line.setAttribute('y1', String(p.y));
          line.setAttribute('x2', String(q.x));
          line.setAttribute('y2', String(q.y));
          line.style.opacity = String(Math.min(1, (now - arrived) / FIGURE_LINE_MS));
        });
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [figure, figureSegments, nodeById]);

  // Il visitatore fa una domanda: l'Oracolo trova la stella che raccoglie i
  // pensieri piu' vicini, la nebulosa lo porta fin li' e la stella risponde.
  const askTheOracle = useCallback(async (text: string) => {
    const question = text.trim();
    if (!question || asking || traveling) return;
    if (revealing) endFigure();
    setAsking(true);
    setSearchResultsVisible(false);
    askInputRef.current?.blur();
    // Mentre l'Oracolo cerca, la nebulosa comincia gia' ad attirare verso di
    // se' (se e' aperta una stella, la camera resta su di lei fino al viaggio).
    if (!selectedId) startDrift();
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
      setHistory((asked) => [...asked, { question, tag: reply.tag }]);
      travelTo(target, { via }, () => {
        setOracle({ tag: reply.tag, question, silent: false, ...voice });
        selectTag(reply.tag, false);
      });
    } catch (err) {
      stopDrift();
      // Senza Oracolo resta la ricerca per nome: si apre il primo tag trovato.
      const first = searchMatches[0];
      if (first) selectTag(first.id);
      else setLoadError(err instanceof Error ? err.message : "L'oracolo non risponde");
    } finally {
      setAsking(false);
    }
  }, [asking, traveling, revealing, endFigure, nodes, selectedId, closeDetail, travelTo, selectTag, searchMatches, startDrift, stopDrift]);

  // Porta il visitatore sulla stella `tag`, che risponde a `question`. La
  // scheda resta aperta e passa subito alla nuova stella (la risposta si
  // prepara durante il volo e compare all'arrivo); la camera salta da una
  // stella all'altra.
  const journeyTo = useCallback((tag: string, question: string) => {
    const node = nodeById.get(tag);
    if (!node || asking || traveling) return false;
    setPanelHoverId(null);
    setVisitorQuestion(question);
    loadOracleText(tag, question);
    if (tag !== selectedId) {
      travelTo(node, { from: selectedId ? nodeById.get(selectedId) : undefined });
      selectTag(tag, false);
    }
    return true;
  }, [nodeById, asking, traveling, selectedId, loadOracleText, travelTo, selectTag]);

  // Il visitatore sceglie la domanda di una stella vicina: la stella
  // risponde proprio a quella domanda, che entra nella cronologia.
  const followQuestion = useCallback((question: StarQuestion) => {
    if (journeyTo(question.tag, question.text)) {
      setHistory((asked) => [...asked, { question: question.text, tag: question.tag }]);
    }
  }, [journeyTo]);

  // Dalla cronologia: si torna su quella stella e si rilegge la sua risposta.
  const revisit = useCallback((index: number) => {
    const step = history[index];
    if (step) journeyTo(step.tag, step.question);
  }, [history, journeyTo]);

  // In sosta su una stella la camera le gira piano attorno (vedi
  // ORBIT_SPEED), come un viaggio che non si ferma mai del tutto: ruotano
  // insieme camera e punto mirato, quindi la stella resta dov'e' sullo
  // schermo. Si ferma appena il visitatore trascina o usa la rotella.
  useEffect(() => {
    const fg = graphRef.current;
    const node = selectedId ? nodeById.get(selectedId) : undefined;
    if (!fg || !node || traveling || asking || reducedMotion()) return;
    type Controls = {
      target?: { x: number; y: number; z: number };
      addEventListener?: (type: string, listener: () => void) => void;
      removeEventListener?: (type: string, listener: () => void) => void;
    };
    const controls = fg.controls() as Controls | undefined;
    let frame = 0;
    let begun = 0;
    let last = 0;
    const stop = () => cancelAnimationFrame(frame);
    controls?.addEventListener?.('start', stop);
    const spin = (now: number) => {
      if (!begun) begun = last = now;
      const since = now - begun - ORBIT_DELAY_MS;
      const aim = controls?.target;
      if (since > 0 && aim && !orbitPaused.current && node.x != null && node.z != null) {
        const angle = (ORBIT_SPEED * Math.min(1, since / ORBIT_RAMP_MS) * (now - last)) / 1000;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        // Rotazione attorno all'asse verticale che passa per la stella.
        const turn = (x: number, z: number) => ({
          x: node.x! + (x - node.x!) * cos + (z - node.z!) * sin,
          z: node.z! + (z - node.z!) * cos - (x - node.x!) * sin,
        });
        const cam = fg.camera().position;
        const camera = turn(cam.x, cam.z);
        const target = turn(aim.x, aim.z);
        fg.cameraPosition({ x: camera.x, y: cam.y, z: camera.z }, { x: target.x, y: aim.y, z: target.z }, 0);
      }
      last = now;
      frame = requestAnimationFrame(spin);
    };
    frame = requestAnimationFrame(spin);
    return () => {
      cancelAnimationFrame(frame);
      controls?.removeEventListener?.('start', stop);
    };
  }, [selectedId, traveling, asking, nodeById]);

  // Ogni volta che una stella si apre, le sue vicine scrivono una domanda
  // nuova (vedi STAR_QUESTIONS), che compare appena e' pronta. La domanda
  // che ha portato fin qui fa da filo: le nuove ne sono il passo successivo.
  useEffect(() => {
    setStarQuestions([]);
    if (!selectedId || traveling) return;
    const planned = questionStarsRef.current;
    const tags = planned?.id === selectedId ? planned.tags : planQuestionStars(selectedId);
    let current = true;
    for (const tag of tags) {
      fetchStarQuestion(tag, visitorQuestion)
        .then((text) => {
          if (current) setStarQuestions((shown) => [...shown.filter((q) => q.tag !== tag), { tag, text }]);
        })
        .catch(() => {
          // Senza Oracolo la stella resta senza domanda: si apre con un click.
        });
    }
    return () => { current = false; };
  }, [selectedId, traveling, visitorQuestion, planQuestionStars]);

  // Le domande seguono le loro stelle sullo schermo: ognuna sta dal lato
  // opposto alla stella aperta (o dall'altro, se finirebbe sotto la scheda o
  // fuori dallo schermo) e scende un poco se coprirebbe un'altra domanda.
  useEffect(() => {
    if (!selectedId || starQuestions.length === 0) return;
    let frame = 0;
    const place = () => {
      const fg = graphRef.current;
      const center = nodeById.get(selectedId);
      if (fg && center?.x != null && center.y != null && center.z != null) {
        const m = fg.camera().matrixWorldInverse.elements;
        const middle = fg.graph2ScreenCoords(center.x, center.y, center.z);
        const width = window.innerWidth;
        const edge = width >= PANEL_MIN_VIEWPORT ? width - PANEL_SPACE : width;
        const items = starQuestions
          .map((q) => ({ node: nodeById.get(q.tag), label: questionLabels.current.get(q.tag) }))
          .filter((item): item is { node: GraphNode; label: HTMLButtonElement } => !!item.node && !!item.label)
          .map((item) => {
            const { x = 0, y = 0, z = 0 } = item.node;
            const ahead = -(m[2] * x + m[6] * y + m[10] * z + m[14]);
            return { ...item, ahead, at: fg.graph2ScreenCoords(x, y, z) };
          })
          .sort((a, b) => a.at.y - b.at.y);
        const taken: { left: number; right: number; top: number; bottom: number }[] = [];
        for (const { label, ahead, at } of items) {
          if (ahead <= 1) {
            label.style.visibility = 'hidden';
            continue;
          }
          const w = label.offsetWidth;
          const h = label.offsetHeight;
          let toRight = at.x >= middle.x;
          if (toRight && at.x + QUESTION_GAP + w > edge - 8) toRight = false;
          if (!toRight && at.x - QUESTION_GAP - w < 8) toRight = true;
          const left = toRight ? at.x + QUESTION_GAP : at.x - QUESTION_GAP - w;
          let top = at.y - h / 2;
          for (const box of taken) {
            if (left < box.right && left + w > box.left && top < box.bottom && top + h > box.top) top = box.bottom + 4;
          }
          taken.push({ left, right: left + w, top, bottom: top + h });
          label.style.visibility = '';
          label.style.transform = `translate(${left}px, ${top}px)`;
        }
      }
      frame = requestAnimationFrame(place);
    };
    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [selectedId, starQuestions, nodeById]);

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
    const distance = Math.max(WANDER_DISTANCE, len * WANDER_PULLBACK);
    fg.cameraPosition(
      {
        x: node.x + (d[0] / len) * distance,
        y: node.y + (d[1] / len) * distance,
        z: node.z + (d[2] / len) * distance,
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
    // Una stella vicina che mostra la sua domanda: sceglierla e' fare quella domanda.
    const question = starQuestions.find((q) => q.tag === node.id);
    if (question) followQuestion(question);
    else selectTag(node.id);
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
      // Durante la rivelazione Esc riprende il viaggio e i tasti delle
      // figure aspettano.
      if (revealing) {
        if (event.key === 'Escape') resumeJourney();
        return;
      }
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
  }, [closeDetail, activeShape, loading, showAbout, revealing, resumeJourney]);

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
            // Durante la rivelazione si vedono solo le linee della figura.
            if (revealing) return 'rgba(210, 193, 174, 0.035)';
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
            if (link.constellation || revealing) return 0;
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
            // Le stelle della figura del viaggio restano accese anche mentre
            // si legge una stella; nella rivelazione si accendono solo loro.
            if (figureIds.has(node.id) && !shapeActive) return revealing ? '#fff4dc' : FIGURE_COLOR;
            if (revealing) return 'rgba(200, 190, 180, 0.1)';
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
            if (figureIds.has(node.id) && !shapeActive) return base * (revealing ? 2.6 : 1.8);
            if (revealing) return base * 0.7;
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
        {figure && !shapeActive && (
          <svg className={`figure-lines${revealing ? ' is-revealed' : ''}`} aria-hidden="true">
            {figureSegments.map((_, i) => (
              <line key={i} ref={(line) => { figureLines.current[i] = line; }} style={{ opacity: 0 }} />
            ))}
          </svg>
        )}
        {starQuestions.length > 0 && (
          <div className="star-questions" aria-label="Domande delle stelle vicine">
            {starQuestions.map((question) => (
              <button
                key={question.tag}
                type="button"
                className="star-question"
                ref={(label) => {
                  if (label) questionLabels.current.set(question.tag, label);
                  else questionLabels.current.delete(question.tag);
                }}
                style={{ visibility: 'hidden' }}
                onClick={() => {
                  orbitPaused.current = false;
                  followQuestion(question);
                }}
                onMouseEnter={() => {
                  orbitPaused.current = true;
                  setPanelHoverId(question.tag);
                }}
                onMouseLeave={() => {
                  orbitPaused.current = false;
                  setPanelHoverId(null);
                }}
                onFocus={() => {
                  orbitPaused.current = true;
                  setPanelHoverId(question.tag);
                }}
                onBlur={() => {
                  orbitPaused.current = false;
                  setPanelHoverId(null);
                }}
              >
                {question.text}
              </button>
            ))}
          </div>
        )}
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

      {/* Si fa da parte durante il viaggio e mentre una stella e' aperta:
          coprirebbe le stelle collegate. */}
      <aside className={`side-panel left-panel${selectedId || traveling || revealing ? ' is-receded' : ''}`}>
        <p className="field-title">Un archivio di <br /><em>memorie collettive.</em></p>
        <p className="field-copy">Ogni tag nasce da un pensiero condiviso e si lega agli altri che ne condividono il tema. Esplora la nebulosa per scoprire come si intrecciano.</p>
        <div className="rule" />
        <div className="metric-grid">
          <div><strong>{graphData.nodes.length}</strong><span>tag</span></div>
          <div><strong>{graphData.links.length}</strong><span>connessioni</span></div>
        </div>
      </aside>

      {suggestions.length > 0 && !selectedId && !busy && !shapeActive && !revealing && !searchTerm.trim() && (
        <div className="oracle-suggestions" aria-label="Domande suggerite">
          {suggestions.map((question) => (
            <button key={question} type="button" onClick={() => askTheOracle(question)}>{question}</button>
          ))}
        </div>
      )}

      {revealing && figure && (
        <section className="figure-reveal" aria-live="polite">
          <p className="figure-reveal-kicker">La tua nebulosa ha preso la forma di {figure.name}</p>
          <p className="figure-reveal-text">{figure.text ?? '…'}</p>
          <button type="button" onClick={resumeJourney}>riprendi il viaggio</button>
        </section>
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
        history={history}
        oracle={oracle}
        arriving={traveling}
        onClose={() => closeDetail()}
        onSelectTag={selectTag}
        onHistoryStep={revisit}
        onHoverTag={setPanelHoverId}
        onAskAnother={askAnother}
        onWander={wander}
        figureReady={!!figure && figure.steps >= FIGURE_STEPS && !revealing}
        onRevealFigure={revealFigure}
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
