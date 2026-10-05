// Costellazioni della nebulosa: figure (scarabeo, drago, leone, pesce,
// lumaca) in cui le stelle si riorganizzano quando si preme un tasto. I
// disegni stanno in shapes.ts; qui vengono trasformati in posizioni per le
// stelle.
//
// QUANTE STELLE: il numero di tag non e' noto in anticipo e puo' crescere
// senza limite, quindi ogni figura viene costruita su misura. Con poche
// stelle si disegna solo la sagoma; i dettagli compaiono man mano che le
// stelle aumentano (campo `from` dei tratti). Oltre BASE_STARS la figura si
// allarga nello spazio e il punto di vista arretra: sullo schermo resta
// grande uguale, ma le stelle appaiono piu' piccole e ci sta piu' dettaglio.
// Quando le stelle starebbero ormai attaccate la figura e' completa, e le
// stelle in piu' restano libere nella nebulosa.
//
// ANAMORFOSI: i punti non stanno su un piano. Ognuno viene spostato lungo la
// propria linea di vista, a una profondita' diversa (come le stelle di una
// vera costellazione, che a noi sembrano vicine ma sono a distanze enormi
// l'una dall'altra). Dal punto di vista giusto la prospettiva li riallinea e
// la figura si ricompone; da ogni altra angolazione sono stelle sparse nello
// spazio.
import { SHAPES, type Guide, type Pt, type ShapeId, type ShapePath } from './shapes.ts';

export type { ShapeId };

// Tasti che richiamano le figure.
export const SHAPE_KEYS: Record<string, ShapeId> = {
  c: 'scarabeo',
  '1': 'scarabeo',
  '2': 'drago',
  '3': 'leone',
  '4': 'pesce',
  '5': 'lumaca',
};

// Quanto allargare la forma rispetto ai punti guida.
export const CONSTELLATION_SCALE = 3.5;

// Numero di stelle per cui i disegni sono pensati: fino a qui la figura ha
// la grandezza di base, oltre cresce (vedi growthFor).
const BASE_STARS = 205;
const MAX_GROWTH = 2;
// Raggio di una stella della figura, nelle unita' del grafo (deriva da
// nodeRelSize e nodeVal in App.tsx), e distanza minima tra due stelle vicine
// in rapporto al loro diametro.
const STAR_RADIUS = 5.45;
const MIN_GAP = 1.3;

const growthFor = (stars: number) => Math.min(MAX_GROWTH, Math.max(1, Math.sqrt(stars / BASE_STARS)));

// ── Dai punti guida alle stelle ──
// Ogni tratto viene spezzato agli spigoli; ogni pezzo diventa una curva
// morbida (Catmull-Rom centripeta) che passa per i suoi punti guida, e su
// quella curva le stelle vengono messe a distanza regolare. Agli spigoli
// cade sempre una stella, cosi' gli angoli restano netti.
type Dense = { points: Pt[]; edges: [number, number][] };

function catmullRom(p0: Pt, p1: Pt, p2: Pt, p3: Pt, steps: number): Pt[] {
  const knot = (a: Pt, b: Pt) => Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])) || 1e-6;
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const out: Pt[] = [];
  for (let s = 0; s < steps; s++) {
    const t = t1 + ((t2 - t1) * s) / steps;
    const mix = (a: Pt, b: Pt, ta: number, tb: number): Pt => [
      (a[0] * (tb - t) + b[0] * (t - ta)) / (tb - ta),
      (a[1] * (tb - t) + b[1] * (t - ta)) / (tb - ta),
    ];
    const a1 = mix(p0, p1, t0, t1);
    const a2 = mix(p1, p2, t1, t2);
    const a3 = mix(p2, p3, t2, t3);
    const b1 = mix(a1, a2, t0, t2);
    const b2 = mix(a2, a3, t1, t3);
    out.push(mix(b1, b2, t1, t2));
  }
  return out;
}

// Linea fitta che passa per i punti guida di un pezzo senza spigoli interni.
function smoothLine(pts: Guide[], wrap: boolean): Pt[] {
  const n = pts.length;
  const xy = (p: Guide): Pt => [p[0], p[1]];
  if (n < 3 && !wrap) return pts.map(xy);
  const at = (i: number): Pt => {
    if (wrap) return xy(pts[((i % n) + n) % n]);
    if (i < 0) return [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]];
    if (i >= n) return [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]];
    return xy(pts[i]);
  };
  const out: Pt[] = [];
  const last = wrap ? n : n - 1;
  for (let i = 0; i < last; i++) out.push(...catmullRom(at(i - 1), at(i), at(i + 1), at(i + 2), 16));
  out.push(xy(wrap ? pts[0] : pts[n - 1]));
  return out;
}

function lengthOf(line: Pt[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  return total;
}

function pointAt(line: Pt[], dist: number): Pt {
  for (let i = 1; i < line.length; i++) {
    const seg = Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
    if (dist <= seg || i === line.length - 1) {
      const t = seg > 0 ? Math.min(1, dist / seg) : 0;
      return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t];
    }
    dist -= seg;
  }
  return line[line.length - 1];
}

// Pezzi lisci di un tratto, tagliato ai suoi spigoli.
function spansOf(path: ShapePath): Pt[][] {
  const pts = path.pts;
  if (pts.length < 2) return [];
  const corners = pts.map((p, i) => (p[2] ? i : -1)).filter((i) => i >= 0);
  if (path.closed) {
    if (!corners.length) return [smoothLine(pts, true)];
    return corners.map((start, c) => {
      const end = corners[(c + 1) % corners.length];
      const piece: Guide[] = [];
      for (let i = start; ; i = (i + 1) % pts.length) {
        piece.push(pts[i]);
        if (i === end && piece.length > 1) break;
      }
      return smoothLine(piece, false);
    });
  }
  const cuts = [0, ...corners.filter((i) => i > 0 && i < pts.length - 1), pts.length - 1];
  const spans: Pt[][] = [];
  for (let c = 1; c < cuts.length; c++) spans.push(smoothLine(pts.slice(cuts[c - 1], cuts[c] + 1), false));
  return spans;
}

type Traced = { path: ShapePath; spans: Pt[][] };

// Mette le stelle lungo tutti i tratti, a distanza `step` l'una dall'altra
// (divisa per la densita' del tratto).
function placeStars(traced: Traced[], step: number): Dense {
  const points: Pt[] = [];
  const edges: [number, number][] = [];
  for (const { path, spans } of traced) {
    const first = points.length;
    if (path.pts.length === 1) {
      points.push([path.pts[0][0], path.pts[0][1]]);
      continue;
    }
    spans.forEach((line, s) => {
      const total = lengthOf(line);
      const k = Math.max(1, Math.round((total * (path.density ?? 1)) / step));
      // La fine di un pezzo e' l'inizio del successivo: la stella finale si
      // aggiunge solo in fondo a un tratto aperto.
      const count = s === spans.length - 1 && !path.closed ? k + 1 : k;
      for (let j = 0; j < count; j++) points.push(pointAt(line, (j / k) * total));
    });
    for (let i = first + 1; i < points.length; i++) edges.push([i - 1, i]);
    if (path.closed) edges.push([points.length - 1, first]);
  }
  return { points, edges };
}

// Disegna la figura con al massimo `stars` stelle.
function buildDense(shape: ShapeId, stars: number): Dense {
  const traced: Traced[] = SHAPES[shape]
    .filter((path) => (path.from ?? 0) <= stars)
    .map((path) => ({ path, spans: spansOf(path) }));
  let weighted = 0;
  for (const { path, spans } of traced) {
    for (const line of spans) weighted += lengthOf(line) * (path.density ?? 1);
  }
  // Le stelle non devono toccarsi: sotto questo passo la figura e' completa.
  const minStep = ((2 * STAR_RADIUS) / (CONSTELLATION_SCALE * growthFor(stars))) * MIN_GAP;
  // Gli arrotondamenti possono dare qualche stella in piu' del previsto: il
  // passo viene allargato poco alla volta finche' rientrano nel numero.
  let step = Math.max(minStep, weighted / stars);
  let dense = placeStars(traced, step);
  for (let guard = 0; dense.points.length > stars && guard < 600; guard++) {
    step *= 1.004;
    dense = placeStars(traced, step);
  }
  if (dense.points.length <= stars) return dense;

  // Stelle troppo poche anche per la sagoma piu' semplice: se ne tiene una
  // ogni tanto, e restano solo i segmenti con entrambi gli estremi.
  const kept = new Map<number, number>();
  for (let i = 0; i < stars; i++) {
    const idx = stars === 1 ? 0 : Math.round((i * (dense.points.length - 1)) / (stars - 1));
    if (!kept.has(idx)) kept.set(idx, kept.size);
  }
  return {
    points: [...kept.keys()].map((i) => dense.points[i]),
    edges: dense.edges
      .filter(([a, b]) => kept.has(a) && kept.has(b))
      .map(([a, b]) => [kept.get(a)!, kept.get(b)!]),
  };
}

// ── Punto di vista da cui le figure si ricompongono ──
// Direzione (dal centro della nebulosa verso l'osservatore) e distanza di
// base. Premendo il tasto di una figura la camera ci vola da sola.
const VIEW_DISTANCE = 900;

type Vec3 = [number, number, number];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (a: Vec3): Vec3 => {
  const len = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / len, a[1] / len, a[2] / len];
};

const VIEW_DIR = normalize([0.78, 0.22, 0.58]);
// Base della camera quando guarda l'origine con "su" = asse y (e' la stessa
// che costruisce three.js con lookAt): RIGHT = destra dello schermo,
// UP = alto dello schermo.
const FORWARD: Vec3 = [-VIEW_DIR[0], -VIEW_DIR[1], -VIEW_DIR[2]];
const RIGHT = normalize(cross(FORWARD, [0, 1, 0]));
const UP = cross(RIGHT, FORWARD);

// Profondita' pseudo-casuale ma stabile (sempre la stessa per lo stesso
// indice): 1 = sul piano della figura, <1 = piu' vicina all'osservatore,
// >1 = piu' lontana. L'intervallo e' volutamente stretto: con una
// dispersione troppo ampia le stelle vicine diventano enormi e quelle
// lontane minuscole, e la sagoma si perde. La differenza di grandezza
// residua viene compensata in App.tsx (vedi depth).
const DEPTH_MIN = 0.78;
const DEPTH_MAX = 1.3;
function depthFactor(index: number): number {
  const s = Math.sin(index * 127.1 + 311.7) * 43758.5453;
  const r = s - Math.floor(s);
  return DEPTH_MIN + r * (DEPTH_MAX - DEPTH_MIN);
}

export type Anchor = { x: number; y: number; z: number; depth: number };
export type Constellation = {
  // posizione di ogni stella della figura
  anchors: Anchor[];
  // segmenti del disegno, come coppie di indici di `anchors`
  edges: [number, number][];
  // dove mettere la camera per vederla ricomposta
  view: { position: { x: number; y: number; z: number }; lookAt: { x: number; y: number; z: number } };
};

const cache = new Map<string, Constellation>();

// Costruisce la figura `shape` per `stars` stelle disponibili. Puo' usarne
// meno (figura completa): le altre restano libere.
export function getConstellation(shape: ShapeId, stars: number): Constellation {
  const key = `${shape}:${stars}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const growth = growthFor(stars);
  const scale = CONSTELLATION_SCALE * growth;
  const eye: Vec3 = [
    VIEW_DIR[0] * VIEW_DISTANCE * growth,
    VIEW_DIR[1] * VIEW_DISTANCE * growth,
    VIEW_DIR[2] * VIEW_DISTANCE * growth,
  ];
  const dense: Dense = stars > 0 ? buildDense(shape, stars) : { points: [], edges: [] };
  // Posizione 3D di ogni punto: parte dal punto sul piano perpendicolare
  // alla vista, poi scorre lungo la retta che lo unisce all'osservatore. La
  // proiezione dal punto di vista non cambia, la posizione nello spazio si'.
  const anchors = dense.points.map(([a, b], index): Anchor => {
    const px = (RIGHT[0] * a + UP[0] * b) * scale;
    const py = (RIGHT[1] * a + UP[1] * b) * scale;
    const pz = (RIGHT[2] * a + UP[2] * b) * scale;
    const t = depthFactor(index);
    return {
      x: eye[0] + t * (px - eye[0]),
      y: eye[1] + t * (py - eye[1]),
      z: eye[2] + t * (pz - eye[2]),
      depth: t,
    };
  });
  const result: Constellation = {
    anchors,
    edges: dense.edges,
    view: { position: { x: eye[0], y: eye[1], z: eye[2] }, lookAt: { x: 0, y: 0, z: 0 } },
  };
  cache.set(key, result);
  return result;
}

// ── Figure del viaggio (figures.ts) ──
// Una costellazione vera: poche stelle, ognuna a una profondita' diversa
// (piu' marcata che nelle figure dei tasti: sono poche e si distinguono
// comunque) e un poco scostata dal disegno esatto, cosi' la figura si
// riconosce dal punto di vista ma non e' perfetta. `seed` cambia scarti e
// profondita' a ogni figura.
const FIGURE_DEPTH_MIN = 0.7;
const FIGURE_DEPTH_MAX = 1.4;
const FIGURE_JITTER = 7;
// Piu' piccola delle figure dei tasti, e guardata un poco piu' in basso del
// centro: cosi' sta nella parte alta dello schermo, sopra la frase
// dell'Oracolo che compare in basso.
const FIGURE_SCALE = 0.62;
const FIGURE_LIFT = 95;

function noise(index: number, seed: number): number {
  const s = Math.sin(index * 91.7 + seed * 47.3 + 13.1) * 43758.5453;
  return s - Math.floor(s);
}

export function placeFigure(points: Pt[], stars: number, seed: number): Pick<Constellation, 'anchors' | 'view'> {
  const growth = growthFor(stars);
  const scale = CONSTELLATION_SCALE * FIGURE_SCALE * growth;
  const eye: Vec3 = [
    VIEW_DIR[0] * VIEW_DISTANCE * growth,
    VIEW_DIR[1] * VIEW_DISTANCE * growth,
    VIEW_DIR[2] * VIEW_DISTANCE * growth,
  ];
  const lift = FIGURE_LIFT * growth;
  const anchors = points.map(([x, y], index): Anchor => {
    const a = x + (noise(index, seed) - 0.5) * 2 * FIGURE_JITTER;
    const b = y + (noise(index + 500, seed) - 0.5) * 2 * FIGURE_JITTER;
    const px = (RIGHT[0] * a + UP[0] * b) * scale;
    const py = (RIGHT[1] * a + UP[1] * b) * scale;
    const pz = (RIGHT[2] * a + UP[2] * b) * scale;
    const t = FIGURE_DEPTH_MIN + noise(index + 1000, seed) * (FIGURE_DEPTH_MAX - FIGURE_DEPTH_MIN);
    return { x: eye[0] + t * (px - eye[0]), y: eye[1] + t * (py - eye[1]), z: eye[2] + t * (pz - eye[2]), depth: t };
  });
  return {
    anchors,
    view: {
      position: { x: eye[0], y: eye[1], z: eye[2] },
      lookAt: { x: -UP[0] * lift, y: -UP[1] * lift, z: -UP[2] * lift },
    },
  };
}
