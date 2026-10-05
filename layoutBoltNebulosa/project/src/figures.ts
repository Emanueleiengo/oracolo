// Figure che il viaggio del visitatore disegna nella nebulosa.
//
// A differenza delle figure dei tasti (shapes.ts, sagome fitte di stelle)
// queste sono costellazioni: poche stelle principali unite da linee, come
// in una carta del cielo. Ogni figura nasce un poco alla volta mentre il
// visitatore fa domande, con le stelle che attraversa; quale figura nasce lo
// decide l'Oracolo leggendo il viaggio (vedi oracle.figure nel server, che
// conosce il significato di ognuna).
//
// Coordinate come in shapes.ts: x verso destra, y verso l'alto, figura
// centrata sull'origine e larga circa 240 unita'. L'ordine dei punti e'
// l'ordine in cui le stelle arrivano al loro posto, quindi i tratti si
// disegnano uno dopo l'altro.
import type { Pt } from './shapes.ts';

export type FigureId =
  | 'cuore' | 'rondine' | 'nave' | 'albero' | 'casa' | 'farfalla' | 'clessidra'
  | 'occhio' | 'luna' | 'chiave' | 'fiamma' | 'lacrima' | 'montagna' | 'ponte'
  | 'leone' | 'drago' | 'pesce' | 'lumaca' | 'scarabeo';

export type Figure = {
  // come la nomina l'Oracolo ("ha preso la forma di un cuore")
  name: string;
  points: Pt[];
  // tratti: ogni elenco di indici e' una linea spezzata che unisce quei punti
  chains: number[][];
};

const mirror = (pts: Pt[]): Pt[] => pts.map(([x, y]) => [-x, y]);
const ring = (cx: number, cy: number, r: number, n: number, from = 90): Pt[] =>
  Array.from({ length: n }, (_, i) => {
    const a = ((from + (i * 360) / n) * Math.PI) / 180;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  });
const loop = (start: number, count: number): number[] => [
  ...Array.from({ length: count }, (_, i) => start + i),
  start,
];

export const FIGURES: Record<FigureId, Figure> = {
  cuore: {
    name: 'un cuore',
    points: [
      [0, -95], [52, -42], [94, 12], [86, 58], [50, 82], [16, 66], [0, 46],
      [-16, 66], [-50, 82], [-86, 58], [-94, 12], [-52, -42],
    ],
    chains: [loop(0, 12)],
  },

  rondine: {
    name: 'una rondine',
    points: [
      [0, 82], [0, 56], [0, 18], [0, -16], [-40, -98], [40, -98], [-12, -52], [12, -52],
      [-58, 70], [-122, 8], [-48, 30], [58, 70], [122, 8], [48, 30],
    ],
    chains: [[0, 1, 2, 3, 6, 4], [3, 7, 5], [1, 8, 9, 10, 2], [1, 11, 12, 13, 2]],
  },

  nave: {
    name: 'una nave',
    points: [
      [-112, -36], [-78, -78], [78, -78], [108, -30], [0, -34], [0, 96],
      [80, -12], [-84, -10], [24, 86],
    ],
    chains: [[0, 1, 2, 3, 4, 0], [4, 5], [5, 6, 4], [5, 7, 4], [5, 8]],
  },

  albero: {
    name: 'un albero',
    points: [
      [-50, -98], [0, -92], [50, -98], [0, 4], [-46, 44], [0, 62], [46, 48],
      [-72, 14], [-106, 46], [-88, 88], [-36, 106], [26, 106], [84, 88], [106, 44], [72, 12],
    ],
    chains: [[0, 1, 2], [1, 3, 5], [3, 4], [3, 6], [7, 8, 9, 10, 11, 12, 13, 14, 7]],
  },

  casa: {
    name: 'una casa',
    points: [
      [-72, -90], [-18, -90], [-18, -34], [18, -34], [18, -90], [72, -90],
      [72, 8], [100, 0], [0, 90], [-100, 0], [-72, 8],
    ],
    chains: [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0], [10, 6]],
  },

  farfalla: {
    name: 'una farfalla',
    points: [
      [0, 58], [0, 22], [0, -5], [0, -62], [-22, 96], [22, 96],
      [-56, 88], [-114, 70], [-98, 12], [-88, -18], [-78, -78], [-28, -58],
      ...mirror([[-56, 88], [-114, 70], [-98, 12], [-88, -18], [-78, -78], [-28, -58]]),
    ],
    chains: [
      [4, 0, 5], [0, 1, 2, 3],
      [1, 6, 7, 8, 2, 9, 10, 11, 3],
      [1, 12, 13, 14, 2, 15, 16, 17, 3],
    ],
  },

  clessidra: {
    name: 'una clessidra',
    points: [
      [-76, 96], [76, 96], [-54, 82], [54, 82], [-9, 0], [9, 0],
      [-54, -82], [54, -82], [-76, -96], [76, -96], [0, -56],
    ],
    chains: [[0, 1], [8, 9], [0, 8], [1, 9], [2, 4, 6], [3, 5, 7], [2, 3], [6, 10, 7]],
  },

  occhio: {
    name: 'un occhio',
    points: [
      [-116, 0], [-60, 44], [0, 58], [60, 44], [116, 0], [60, -38], [0, -48], [-60, -38],
      ...ring(0, 4, 32, 7),
      [0, 4],
    ],
    chains: [loop(0, 8), loop(8, 7)],
  },

  luna: {
    name: 'una luna',
    points: [
      [16, 95], [-44, 84], [-84, 46], [-96, -4], [-82, -50], [-44, -84], [16, -95],
      [-4, -62], [-32, -34], [-40, 0], [-30, 38], [-2, 66],
      [66, 34],
    ],
    chains: [loop(0, 12)],
  },

  chiave: {
    name: 'una chiave',
    points: [
      ...ring(-72, 0, 36, 6, 0),
      [18, 0], [78, 0], [108, 0], [78, -34], [108, -42],
    ],
    chains: [loop(0, 6), [0, 6, 7, 8], [7, 9], [8, 10]],
  },

  fiamma: {
    name: 'una fiamma',
    points: [
      [0, -96], [50, -72], [66, -24], [52, 22], [36, 46], [46, 84], [14, 58], [2, 100],
      [-24, 62], [-50, 28], [-66, -22], [-48, -70],
      [0, -72], [26, -40], [18, 4], [4, 40], [-18, 6], [-26, -38],
    ],
    chains: [loop(0, 12), loop(12, 6)],
  },

  lacrima: {
    name: 'una lacrima',
    points: [
      [0, 96], [38, 32], [62, -20], [50, -66], [0, -90], [-50, -66], [-62, -20], [-38, 32],
      [-28, -26], [-34, -54],
    ],
    chains: [loop(0, 8), [8, 9]],
  },

  montagna: {
    name: 'una montagna',
    points: [
      [-120, -80], [-56, 52], [-16, 0], [34, 96], [76, 24], [120, -80],
      [14, 62], [30, 50], [48, 62], [-96, 74],
    ],
    chains: [[0, 1, 2, 3, 4, 5], [6, 7, 8]],
  },

  ponte: {
    name: 'un ponte',
    points: [
      [-120, 12], [-60, 12], [0, 12], [60, 12], [120, 12],
      [-60, -58], [-60, 90], [0, 34], [60, 90], [60, -58],
    ],
    chains: [[0, 1, 2, 3, 4], [5, 1, 6], [9, 3, 8], [0, 6, 7, 8, 4], [7, 2]],
  },

  leone: {
    name: 'un leone',
    points: [
      [-112, 28], [-88, 62], [-50, 78], [-30, 30], [-92, -2],
      [30, 42], [88, 32], [112, 0], [120, 40],
      [-38, -30], [-48, -92], [25, -15], [82, -30], [78, -92],
    ],
    chains: [[0, 1, 2, 3, 4, 0], [3, 5, 6, 7, 8], [3, 9, 10], [9, 11, 12], [6, 12, 13]],
  },

  drago: {
    name: 'un drago',
    points: [
      [-118, 50], [-95, 74], [-100, 36], [-70, 30], [-40, 0], [10, 15], [55, 0],
      [90, -26], [116, -4], [104, 28], [-15, 22], [20, 96], [76, 72], [50, 30],
      [-42, -62], [60, -64],
    ],
    chains: [[0, 1, 3], [0, 2, 3], [3, 10, 5, 6, 7, 8, 9], [3, 4, 6], [4, 14], [6, 15], [10, 11, 12, 13, 5]],
  },

  pesce: {
    name: 'un pesce',
    points: [
      [-116, 2], [-70, 42], [-25, 52], [5, 84], [35, 40], [80, 0],
      [120, 42], [100, 0], [120, -42], [35, -38], [-70, -40], [-82, 12],
    ],
    chains: [[0, 1, 2, 4, 5, 9, 10, 0], [2, 3, 4], [5, 6, 7, 8, 5]],
  },

  lumaca: {
    name: 'una lumaca',
    points: [
      [-112, -48], [0, -50], [100, -42], [92, -6], [114, 40], [82, 42],
      [-14, 18], [2, 28], [8, 4], [-18, -8], [-42, 18], [-26, 52], [12, 58], [46, 26], [42, -22], [-8, -40],
    ],
    chains: [[0, 1, 2, 3], [3, 4], [3, 5], [3, 14], [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 1]],
  },

  scarabeo: {
    name: 'uno scarabeo',
    points: [
      ...ring(0, 78, 22, 5),
      [0, 44], [-30, 28], [30, 28], [-40, 10], [40, 10], [-44, -40], [44, -40], [0, -78], [0, 10],
      [-68, 48], [-82, -6], [-72, -84], [68, 48], [82, -6], [72, -84],
    ],
    chains: [
      loop(0, 5),
      [6, 5, 7], [6, 8, 10, 12, 11, 9, 7], [13, 12],
      [6, 14], [8, 15], [10, 16], [7, 17], [9, 18], [11, 19],
    ],
  },
};

export const FIGURE_IDS = Object.keys(FIGURES) as FigureId[];
