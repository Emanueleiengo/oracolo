import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import { CircleHelp, Search, Sparkles, X } from 'lucide-react';
import { fetchGraph, fetchTagDetail, type TagDetail, type TagGraph } from '@/lib/api';
import TagDetailPanel from '@/components/TagDetailPanel';
import { SHAPE_KEYS, getConstellation, type Anchor, type Constellation, type ShapeId } from './constellation';
import miaIcona from './mistakelogo.png';

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
  const [showIntro, setShowIntro] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResultsVisible, setSearchResultsVisible] = useState(false);
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
    if (loading || showIntro) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const rhythms = nodes.map((node) => ({
      node,
      speed: (2 * Math.PI) / (TWINKLE_PERIOD[0] + hash01(`${node.id}:ritmo`) * (TWINKLE_PERIOD[1] - TWINKLE_PERIOD[0])),
      phase: hash01(`${node.id}:fase`) * 2 * Math.PI,
    }));
    let frame = 0;
    const tick = (now: number) => {
      for (const { node, speed, phase } of rhythms) {
        const star = node.__threeObj;
        if (!star) continue;
        // 0 a riposo, 1 al culmine; al quadrato perche' il culmine sia breve.
        const wave = Math.pow(0.5 + 0.5 * Math.sin((now / 1000) * speed + phase), 2);
        star.scale.setScalar(1 + TWINKLE_SWELL * wave);
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
  }, [nodes, loading, showIntro]);

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
    const follow = () => {
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
          const size = GLOW_RADIUS * 2 * pxPerUnit;
          glow.style.width = `${size}px`;
          glow.style.height = `${size}px`;
          glow.style.transform = `translate(${x - size / 2}px, ${y - size / 2}px)`;
          glow.style.opacity = '1';
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
  // (cioe' a caricamento finito e a intro chiusa). ──
  useEffect(() => {
    if (loading || showIntro) return;
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
  }, [loading, showIntro, graph.nodes]);

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

  // Zoom su una stella: la camera si avvicina mantenendo la direzione da cui
  // la si guardava, e la mira e' spostata un po' a destra della stella cosi'
  // che questa finisca nello spazio libero a sinistra del pannello.
  const flyToNode = useCallback((node: GraphNode) => {
    const fg = graphRef.current;
    if (!fg || node.x == null || node.y == null || node.z == null) return;
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

    fg.cameraPosition(
      { x: node.x + dx * FOCUS_DISTANCE, y: node.y + dy * FOCUS_DISTANCE, z: node.z + dz * FOCUS_DISTANCE },
      { x: node.x + rx * shift, y: node.y, z: node.z + rz * shift },
      1000
    );
  }, []);

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

  // Apre un tag: zoom sulla stella, illumina le collegate e carica la scheda.
  const openTag = useCallback(async (id: string) => {
    selectionRef.current = id;
    setSelectedId(id);
    setSearchResultsVisible(false);
    const node = graph.nodes.find((n) => n.id === id);
    if (node) flyToNode(node);
    try {
      const detail = await fetchTagDetail(id);
      if (selectionRef.current === id) setDetailTag(detail);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Impossibile caricare il tag');
    }
  }, [graph.nodes, flyToNode]);

  // Seleziona un tag: lo apre e lo aggiunge al viaggio (che riparte da capo
  // se non e' collegato all'ultima tappa).
  const selectTag = useCallback((id: string) => {
    setTrail((current) => {
      const last = current[current.length - 1];
      if (last === id) return current;
      return last !== undefined && adjacency.get(last)?.has(id) ? [...current, id] : [id];
    });
    openTag(id);
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

  const submitSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const first = searchMatches[0];
    if (first) selectSearchResult(first);
  };

  const handleNodeClick = (node: GraphNode) => {
    selectTag(node.id);
  };

  // Tasti: Esc chiude la scheda e scioglie la figura; i tasti di SHAPE_KEYS
  // organizzano le stelle in una figura (premendo di nuovo lo stesso tasto
  // tornano libere).
  useEffect(() => {
    if (loading || showIntro) return;
    const onKey = (event: KeyboardEvent) => {
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
  }, [closeDetail, activeShape, loading, showIntro]);

  const isNearHovered = (node: GraphNode) => {
    if (selectedId || !hoveredNode) return false;
    if (node.x == null || node.y == null || node.z == null) return false;
    if (hoveredNode.x == null || hoveredNode.y == null || hoveredNode.z == null) return false;
    return Math.hypot(node.x - hoveredNode.x, node.y - hoveredNode.y, node.z - hoveredNode.z) < 120;
  };

  if (loading || showIntro) {
    return (
      <main
        className="oracle-shell"
        style={{ cursor: loading ? 'wait' : 'pointer' }}
        onClick={() => {
          if (!loading) {
            setShowIntro(false);
          }
        }}
      >
        <div className="loading-screen flex flex-col items-center justify-center text-center px-6">
          <div className="loading-orb" />
          <p className="max-w-2xl mt-6" style={{ fontSize: '13px', lineHeight: '1.6' }}>
            L'Oracolo è una mente collettiva open source che si dirama in mille frammenti incandescenti. È uno strumento, un archivio, un ambiente generativo, un agglomeratore di pensieri, testi, file, fonti e prende la forma di ciò da cui è composto. È una nebulosa mutaforma messa a disposizione del Viandante, che è uno stato d'animo: è il divergente, il ricercatore, l'esploratore; quello che si fa domande.
          </p>

          {!loading && (
            <p className="pt-12 text-sm text-[#F3C58B] animate-pulse">
              [ ADDENTRATI NELLA NEBULOSA ]
            </p>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="oracle-shell">
      <div className="aurora aurora-one" />
      <div className="aurora aurora-two" />
      <div className="star-field" />
      <div className="graph-layer">
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
              if (trailIds.has(node.id) || linkedIds.has(node.id)) return base * 2;
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
          <img src={miaIcona} alt="Icona Nebulosa" className="w-9 h-10" />
          <div>
            <p className="eyebrow">Oracolo</p>
            <h1>LA NEBULOSA</h1>
          </div>
        </div>
        <div className="header-center"><span className="status-dot" />Frammento <span className="header-divider" /> {graphData.nodes.length} tag condivisi</div>
        <div className="header-actions">
          <a className="help-button" href={`${import.meta.env.BASE_URL}question.html`} aria-label="L'oracolo"><Sparkles size={16} strokeWidth={1.5} /></a>
          <button className="help-button" type="button" aria-label="Help"><CircleHelp size={17} strokeWidth={1.5} /></button>
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

      <form className="oracle-input-wrap" onSubmit={submitSearch}>
        <div className="input-icon"><Search size={17} strokeWidth={1.5} /></div>
        <input
          value={searchTerm}
          onChange={(event) => {
            setSearchTerm(event.target.value);
            setSearchResultsVisible(true);
          }}
          onFocus={() => setSearchResultsVisible(true)}
          onBlur={() => setTimeout(() => setSearchResultsVisible(false), 120)}
          placeholder="Cerca un tag nella Nebulosa."
          aria-label="Cerca un tag"
        />
        {searchResultsVisible && searchMatches.length > 0 && (
          <ul className="search-results">
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
        {searchResultsVisible && searchTerm.trim() && searchMatches.length === 0 && (
          <ul className="search-results">
            <li className="search-result-empty">Nessun tag corrisponde a "{searchTerm.trim()}"</li>
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
        onClose={() => closeDetail()}
        onSelectTag={selectTag}
        onTrailStep={backToTrailStep}
        onHoverTag={setPanelHoverId}
      />
    </main>
  );
}
