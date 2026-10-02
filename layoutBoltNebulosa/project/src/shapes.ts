// Disegni delle costellazioni: scarabeo, drago, leone, pesce, lumaca.
//
// Ogni figura e' fatta a mano con pochi punti guida per ogni tratto (contorni,
// zampe, pinne...). constellation.ts unisce i punti guida con curve morbide e
// ci distribuisce sopra le stelle disponibili.
//
// Coordinate: x verso destra, y verso l'alto, figura centrata sull'origine e
// larga circa 240 unita'.
export type Pt = [number, number];
// Punto guida: il terzo valore (1) segna uno spigolo vivo, dove la curva non
// viene arrotondata (denti, ginocchia, punte).
export type Guide = [x: number, y: number, corner?: 1];
export type ShapePath = {
  name: string;
  pts: Guide[];
  // contorno chiuso
  closed?: boolean;
  // quante stelle rispetto alla media (meno di 1 = piu' rade)
  density?: number;
  // numero minimo di stelle disponibili perche' il tratto compaia: con poche
  // stelle si disegna solo la sagoma, i dettagli arrivano man mano
  from?: number;
};

export type ShapeId = 'scarabeo' | 'drago' | 'leone' | 'pesce' | 'lumaca';

// ── Attrezzi per disegnare ──
const DEG = Math.PI / 180;
const flipY = (pts: Guide[]): Guide[] => pts.map(([x, y, c]) => (c ? [x, -y, 1] : [x, -y]));
const flipX = (pts: Guide[]): Guide[] => pts.map(([x, y, c]) => (c ? [-x, y, 1] : [-x, y]));
// Contorno simmetrico: una meta' + la sua copia specchiata percorsa al
// contrario (i punti sull'asse di simmetria non vengono ripetuti).
const acrossY = (half: Guide[]): Guide[] => [...half, ...flipY(half).reverse().filter(([, y]) => y !== 0)];
const acrossX = (half: Guide[]): Guide[] => [...half, ...flipX(half).reverse().filter(([x]) => x !== 0)];
type Options = Omit<ShapePath, 'name' | 'pts'>;
// Lo stesso tratto sopra e sotto (o a destra e a sinistra) dell'asse.
const bothY = (name: string, pts: Guide[], options: Options = {}): ShapePath[] => [
  { name: `${name}-su`, pts, ...options },
  { name: `${name}-giu`, pts: flipY(pts), ...options },
];
const bothX = (name: string, pts: Guide[], options: Options = {}): ShapePath[] => [
  { name: `${name}-dx`, pts, ...options },
  { name: `${name}-sx`, pts: flipX(pts), ...options },
];
// Stelle isolate (occhi, bolle, baffi): un tratto di un solo punto ciascuna.
const dots = (name: string, pts: Pt[], options: Options = {}): ShapePath[] =>
  pts.map((p, i) => ({ name: `${name}-${i + 1}`, pts: [p], ...options }));
const polar = (cx: number, cy: number, r: number, deg: number): Pt => [
  cx + Math.cos(deg * DEG) * r,
  cy + Math.sin(deg * DEG) * r,
];
const ring = (cx: number, cy: number, r: number, n: number): Pt[] =>
  Array.from({ length: n }, (_, i) => polar(cx, cy, r, (i * 360) / n));
// Corpo a "nastro": una linea centrale con una larghezza in ogni punto,
// restituisce i due bordi (sinistro e destro rispetto al verso della linea).
function ribbon(center: Pt[], widths: number[]): { left: Pt[]; right: Pt[] } {
  const left: Pt[] = [];
  const right: Pt[] = [];
  center.forEach((p, i) => {
    const a = center[Math.max(0, i - 1)];
    const b = center[Math.min(center.length - 1, i + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / len;
    const ny = (b[0] - a[0]) / len;
    left.push([p[0] + (nx * widths[i]) / 2, p[1] + (ny * widths[i]) / 2]);
    right.push([p[0] - (nx * widths[i]) / 2, p[1] - (ny * widths[i]) / 2]);
  });
  return { left, right };
}

// ── Scarabeo stercorario ──
// Visto dall'alto come quello egizio, con la testa verso la pallottola. E'
// simmetrico: si disegna la meta' superiore e l'altra si ottiene per specchio.
const BALL = { cx: -79, cy: 0, r: 40 };
// Pallottola leggermente irregolare: e' sterco impastato, non una sfera.
const ballPoint = (deg: number, k = 1): Pt => {
  const a = deg * DEG;
  const wobble = 1 + 0.025 * Math.sin(3 * a + 1.1) + 0.016 * Math.sin(5 * a + 0.4);
  return [BALL.cx + Math.cos(a) * BALL.r * k * wobble, BALL.cy + Math.sin(a) * BALL.r * k * wobble];
};
const ballArc = (from: number, to: number, k: number, n: number): Pt[] =>
  Array.from({ length: n }, (_, i) => ballPoint(from + ((to - from) * i) / (n - 1), k));

const SCARABEO: ShapePath[] = [
  { name: 'pallottola', closed: true, density: 0.62, pts: ballArc(0, 345, 1, 24) },
  // archi interni che le danno volume
  { name: 'pallottola-ombra', density: 0.62, from: 185, pts: ballArc(200, 270, 0.72, 6) },
  { name: 'pallottola-paglia', density: 0.62, from: 185, pts: ballArc(100, 145, 0.55, 4) },
  { name: 'pallottola-trama-1', density: 0.62, from: 340, pts: ballArc(300, 350, 0.6, 4) },
  { name: 'pallottola-trama-2', density: 0.62, from: 340, pts: ballArc(165, 215, 0.42, 4) },

  // testa: clipeo a quattro denti sul davanti
  {
    name: 'testa',
    density: 1.05,
    pts: acrossY([
      [-6.5, 22],
      [-12.5, 24, 1], // dente esterno
      [-14.5, 12.5, 1], // tacca
      [-26, 10.5, 1], // dente interno
      [-20, 0, 1], // tacca centrale
    ]),
  },
  ...bothY('occhio', [[-7, 8.5]], { from: 150 }),
  ...bothY('antenna', [[-9, 23.5], [-13, 30], [-18.5, 33, 1], [-22.5, 31]], { from: 260, density: 1.1 }),

  // pronoto: lo scudo largo dietro la testa
  {
    name: 'pronoto',
    closed: true,
    pts: acrossY([
      [-1.5, 0],
      [-3, 9],
      [-2.5, 19.5, 1], // angolo anteriore
      [3, 28],
      [12, 33.5],
      [21, 34.5],
      [27, 32, 1], // angolo posteriore
      [29, 16],
      [29.5, 0],
    ]),
  },
  { name: 'pronoto-solco', density: 0.9, from: 340, pts: [[3, 0], [25, 0]] },

  // elitre: contorno, sutura centrale e strie
  {
    name: 'elitre',
    density: 0.95,
    pts: acrossY([
      [31.5, 33.5, 1], // omero
      [42, 37],
      [56, 37.5],
      [70, 34.5],
      [83, 27.5],
      [93, 17],
      [98.5, 7],
      [100, 0],
    ]),
  },
  { name: 'sutura', density: 0.9, from: 150, pts: [[35, 0], [93, 0]] },
  { name: 'scutello', density: 1.1, from: 260, pts: [[31.5, 5, 1], [38, 0, 1], [31.5, -5, 1]] },
  ...bothY('stria-interna', [[35.5, 11.5], [52, 13], [69, 12.5], [81, 10], [88, 6.5]], { from: 150, density: 0.85 }),
  ...bothY('stria-media', [[35.5, 17.5], [51, 19.5], [67, 18.5], [79, 15], [86.5, 10.5]], { from: 260, density: 0.85 }),
  ...bothY('stria-esterna', [[36, 23], [50, 25.5], [65, 24.5], [77, 20], [85, 14]], { from: 150, density: 0.85 }),

  // zampe: femore -> tibia -> tarso. Le anteriori abbracciano la pallottola.
  ...bothY(
    'zampa-anteriore',
    [
      [1.5, 31],
      [-8, 46, 1], // ginocchio
      [-25, 46.5],
      [-41, 41.5, 1], // punta della tibia
      [-48, 39],
      [-53.5, 34],
    ],
    { from: 90 }
  ),
  ...bothY('zampa-media', [[40, 41], [44.5, 57, 1], [65, 60, 1], [73, 57.5], [79, 52]], { from: 90 }),
  ...bothY('zampa-posteriore', [[79, 34.5], [86.5, 47.5, 1], [108, 43, 1], [115.5, 38.5], [120, 31]], { from: 90 }),
  // denti delle tibie e speroni
  ...bothY('dente-tibia-1', [[-17, 47.5], [-19.5, 52.5]], { from: 340 }),
  ...bothY('dente-tibia-2', [[-27, 46.5], [-30.5, 51]], { from: 340 }),
  ...bothY('dente-tibia-3', [[-36.5, 44], [-40.5, 47.5]], { from: 340 }),
  ...bothY('sperone-medio', [[66.5, 62], [70, 65.5]], { from: 340 }),
  ...bothY('sperone-posteriore', [[110, 45], [114.5, 47.5]], { from: 340 }),
];

// ── Drago ──
// Di profilo, rivolto a sinistra: collo a S, ala da pipistrello, coda che
// risale e finisce a punta di lancia.
const DRAGON_SPINE: Pt[] = [
  [-70, 42], // attacco della testa
  [-62, 34],
  [-60, 22],
  [-66, 10],
  [-66, -2],
  [-54, -12], // petto
  [-32, -16],
  [-5, -15],
  [20, -16], // anca
  [42, -21],
  [62, -27],
  [82, -27],
  [99, -18],
  [108, -3],
  [110, 14], // fine della coda
];
const DRAGON_WIDTH = [10, 11, 12, 14, 19, 27, 31, 27, 28, 20, 14, 10.5, 8.5, 7, 6];
const DRAGON = ribbon(DRAGON_SPINE, DRAGON_WIDTH);
// Cresta: un dentino a V sopra il dorso, nel punto `i` della spina.
const dragonSpike = (i: number): Guide[] => {
  const [bx, by] = DRAGON.left[i];
  const [cx, cy] = DRAGON_SPINE[i];
  const len = Math.hypot(bx - cx, by - cy) || 1;
  const nx = (bx - cx) / len;
  const ny = (by - cy) / len;
  return [
    [bx + nx * 3.8 + ny * 3.2, by + ny * 3.8 - nx * 3.2],
    [bx + nx * 9.5, by + ny * 9.5, 1],
    [bx + nx * 3.8 - ny * 3.2, by + ny * 3.8 + nx * 3.2],
  ];
};

const DRAGO: ShapePath[] = [
  {
    name: 'corpo',
    closed: true,
    pts: [
      // dorso, dalla nuca alla coda
      ...DRAGON.left,
      // punta di lancia
      [99.5, 18.5, 1],
      [111.5, 39, 1],
      [122, 17.5, 1],
      // ventre, dalla coda alla gola
      ...[...DRAGON.right].reverse(),
      // testa: mandibola, bocca aperta, muso, fronte
      [-83, 33],
      [-96, 29],
      [-108, 30, 1], // punta della mandibola
      [-89, 39.5, 1], // angolo della bocca
      [-115, 43, 1], // labbro
      [-117, 50, 1], // naso
      [-104, 55],
      [-91, 60],
      [-77, 57.5],
    ],
  },
  { name: 'occhio', from: 90, pts: [[-94, 51.5]] },
  { name: 'corno', from: 90, pts: [[-73, 60.5], [-63, 66], [-51, 65.5]] },
  ...[9, 10, 11, 12].map((i, k) => ({ name: `cresta-${k + 1}`, from: 185, pts: dragonSpike(i) })),

  // ala da pipistrello: braccio, punte delle dita e membrana smerlata
  {
    name: 'ala',
    pts: [
      [-35, 5],
      [-45, 27, 1], // gomito
      [-16, 51, 1], // polso
      [12, 61.5],
      [40, 64, 1], // prima punta
      [52, 54.5],
      [72, 46, 1], // seconda punta
      [60, 33],
      [70, 18, 1], // terza punta
      [48, 16],
      [34, 8.5],
      [26, 2.5],
    ],
  },
  { name: 'dito-1', from: 150, density: 0.8, pts: [[-9, 49.5], [28, 50], [62, 46.5]] },
  { name: 'dito-2', from: 150, density: 0.8, pts: [[-9.5, 45.5], [28, 32.5], [61, 22]] },

  // zampe con il piede artigliato
  {
    name: 'zampa-anteriore',
    from: 90,
    pts: [[-60, -31], [-66, -40], [-62, -48], [-72, -57, 1], [-62, -60], [-52, -57, 1], [-52, -47], [-54, -39], [-44, -34]],
  },
  {
    name: 'zampa-posteriore',
    from: 90,
    pts: [[10, -33], [4, -44], [14, -50], [6, -57, 1], [17, -61], [27, -58, 1], [27, -49], [36, -42], [36, -33]],
  },
  { name: 'coscia', from: 185, density: 0.8, pts: [[7, -27], [13, -13], [28, -10], [39, -24]] },
  // fiamma e denti
  { name: 'fiamma', from: 260, pts: [[-119, 40], [-129, 44, 1], [-125, 39], [-136, 37, 1], [-127, 34], [-132, 29, 1], [-117, 35]] },
  { name: 'dente-1', from: 340, pts: [[-106, 42.5], [-105, 39]] },
  { name: 'dente-2', from: 340, pts: [[-98, 41.5], [-97.5, 38.2]] },
];

// ── Leone ──
// Il muso di fronte, dentro la criniera. Simmetrico: si disegna la meta'
// destra e l'altra si ottiene per specchio.
const MANE_TUFTS = 12;
const mane: Guide[] = [];
for (let i = 0; i < MANE_TUFTS; i++) {
  const tip = 90 + (i * 360) / MANE_TUFTS;
  const half = 180 / MANE_TUFTS;
  // ogni ciuffo: punta, fianco bombato, incavo, fianco bombato
  mane.push(
    [...polar(0, 0, 76, tip), 1],
    [...polar(0, 0, 71.5, tip + half * 0.5)],
    [...polar(0, 0, 59, tip + half), 1],
    [...polar(0, 0, 71.5, tip + half * 1.5)]
  );
}

const LEONE: ShapePath[] = [
  { name: 'criniera', closed: true, pts: mane },
  {
    name: 'muso',
    closed: true,
    pts: acrossX([[0, 40], [16, 39], [30, 30], [38, 14], [37, -4], [30, -20], [19, -33], [8, -41], [0, -43]]),
  },
  ...bothX('orecchio', [[24.5, 38.5], [26.5, 44.5], [32, 46.5], [37.5, 43], [38.5, 35.5]], { from: 90 }),
  ...bothX('occhio', [[7, 9, 1], [14, 15], [23, 12, 1], [15, 6.5]], { closed: true, density: 1.1 }),
  ...bothX('pupilla', [[15, 10.5]], { from: 185 }),
  { name: 'naso', closed: true, pts: [[-9, -9, 1], [0, -7.5], [9, -9, 1], [5, -15], [0, -19, 1], [-5, -15]] },
  { name: 'bocca', from: 90, pts: [[-18, -26], [-9, -31], [0, -24, 1], [9, -31], [18, -26]] },
  ...bothX('canna-del-naso', [[6, 4], [8.5, -1], [9, -5]], { from: 150 }),
  ...bothX('baffo-1', [[14, -19]], { from: 185 }),
  ...bothX('baffo-2', [[21, -17]], { from: 185 }),
  ...bothX('baffo-3', [[18, -23]], { from: 185 }),
  // ciuffi interni della criniera e fronte
  ...bothX('ciuffo-alto', [[14, 45], [22, 53, 1], [30, 49]], { from: 260 }),
  ...bothX('ciuffo-lato', [[44, 12], [51, 5, 1], [45, -4]], { from: 260 }),
  ...bothX('ciuffo-basso', [[33, -27], [36, -37, 1], [26, -38]], { from: 260 }),
  { name: 'fronte', from: 340, pts: [[-6, 31], [0, 26, 1], [6, 31]] },
  { name: 'mento', from: 340, pts: [[-6, -36], [0, -38], [6, -36]] },
];

// ── Pesce ──
// Di profilo, rivolto a sinistra.
const PESCE: ShapePath[] = [
  {
    name: 'corpo',
    closed: true,
    pts: [
      [-98, -2, 1], // bocca
      [-92, 9],
      [-76, 24],
      [-50, 35],
      [-20, 38],
      [10, 33],
      [36, 21],
      [56, 8, 1], // attacco della coda
      [76, 22],
      [100, 44, 1],
      [93, 20],
      [89, 0, 1], // forcella
      [93, -20],
      [100, -44, 1],
      [76, -22],
      [56, -8, 1],
      [36, -20],
      [10, -31],
      [-20, -36],
      [-50, -33],
      [-76, -23],
      [-92, -12],
    ],
  },
  { name: 'bocca', from: 150, pts: [[-92, -5.5], [-84, -7]] },
  { name: 'occhio', closed: true, from: 90, density: 1.25, pts: ring(-74, 9, 5.5, 6) },
  { name: 'pupilla', from: 185, pts: [[-74, 9]] },
  { name: 'branchia', from: 90, pts: [[-56, 27], [-49, 12], [-48, -4], [-54, -20]] },
  { name: 'pinna-dorsale', pts: [[-36, 40.5], [-25, 53], [-8, 60, 1], [4, 51], [14, 44], [23, 31.5]] },
  { name: 'pinna-ventrale', from: 90, pts: [[-4, -39.5], [4, -53, 1], [15, -46], [20, -33]] },
  { name: 'pinna-pettorale', from: 90, pts: [[-42, -4], [-30, -12], [-19, -23, 1], [-21, -9], [-32, 0]] },
  { name: 'linea-laterale', from: 150, density: 0.6, pts: [[-38, 7], [-10, 9], [22, 6], [46, 1]] },
  ...dots('bolla', [[-106, 13], [-112, 28], [-105, 42]], { from: 120 }),
  // squame e raggi delle pinne
  { name: 'squama-1', from: 150, pts: [[-30, 27], [-23, 19.5], [-29, 12]] },
  { name: 'squama-2', from: 150, pts: [[-12, 28], [-5, 20.5], [-11, 13]] },
  { name: 'squama-3', from: 150, pts: [[6, 25], [13, 18], [7, 11]] },
  { name: 'squama-4', from: 260, pts: [[-22, -4], [-15, -11], [-21, -18]] },
  { name: 'squama-5', from: 260, pts: [[-3, -3], [4, -10], [-2, -17]] },
  { name: 'squama-6', from: 260, pts: [[16, -2], [23, -8.5], [17, -15]] },
  { name: 'raggio-coda-su', from: 260, density: 0.8, pts: [[66, 3], [86, 12]] },
  { name: 'raggio-coda-giu', from: 260, density: 0.8, pts: [[66, -3], [86, -12]] },
  { name: 'raggio-dorsale-1', from: 340, pts: [[-20, 43], [-10, 54]] },
  { name: 'raggio-dorsale-2', from: 340, pts: [[-5, 43], [3, 47]] },
];

// ── Lumaca ──
// Di profilo, rivolta a sinistra. Il guscio e' una spirale logaritmica che
// finisce in basso a sinistra, dove esce il corpo.
const SHELL = { cx: 22, cy: 4, r0: 6, r1: 50, turns: 2.8, end: 215 };
const shellRadius = (deg: number) =>
  SHELL.r0 * Math.pow(SHELL.r1 / SHELL.r0, 1 - (SHELL.end - deg) / (SHELL.turns * 360));
const shellStart = SHELL.end - SHELL.turns * 360;
const shell: Pt[] = [];
for (let deg = shellStart; deg < SHELL.end; deg += 30) shell.push(polar(SHELL.cx, SHELL.cy, shellRadius(deg), deg));
shell.push(polar(SHELL.cx, SHELL.cy, SHELL.r1, SHELL.end));
// Riga di crescita sull'ultimo giro del guscio, a un certo angolo.
const shellRib = (deg: number): Pt[] => [
  polar(SHELL.cx, SHELL.cy, shellRadius(deg) * 0.6, deg + 4),
  polar(SHELL.cx, SHELL.cy, shellRadius(deg) * 0.76, deg - 2),
  polar(SHELL.cx, SHELL.cy, shellRadius(deg) * 0.92, deg - 5),
];

const LUMACA: ShapePath[] = [
  { name: 'guscio', pts: shell },
  {
    name: 'corpo',
    pts: [
      [42, -26],
      [66, -34],
      [86, -44],
      [99, -52, 1], // punta della coda
      [70, -55],
      [20, -56],
      [-40, -56],
      [-78, -54],
      [-95, -46],
      [-99, -30],
      [-95, -13],
      [-85, -3],
      [-72, -6],
      [-56, -21],
      [-38, -28],
      [-24, -28],
    ],
  },
  { name: 'tentacolo-1', from: 60, pts: [[-89.5, 3.5], [-97, 21], [-101, 38]] },
  { name: 'tentacolo-2', from: 60, pts: [[-78.5, 2.5], [-80, 22], [-78, 39]] },
  { name: 'tentacolino-1', from: 150, pts: [[-102, -19.5], [-110, -17]] },
  { name: 'tentacolino-2', from: 150, pts: [[-102.5, -27.5], [-110, -30]] },
  { name: 'orlo-del-piede', from: 150, density: 0.6, pts: [[-78, -45], [-45, -47.5], [-10, -46], [30, -48], [68, -46.5]] },
  ...dots('bava', [[107, -56], [115, -56.5], [123, -56]], { from: 120 }),
  { name: 'costa-1', from: 260, pts: shellRib(SHELL.end - 60) },
  { name: 'costa-2', from: 260, pts: shellRib(SHELL.end - 105) },
  { name: 'costa-3', from: 260, pts: shellRib(SHELL.end - 150) },
  { name: 'costa-4', from: 340, pts: shellRib(SHELL.end - 195) },
  { name: 'costa-5', from: 340, pts: shellRib(SHELL.end - 240) },
  { name: 'bocca', from: 340, pts: [[-97, -36], [-91, -38]] },
];

export const SHAPES: Record<ShapeId, ShapePath[]> = {
  scarabeo: SCARABEO,
  drago: DRAGO,
  leone: LEONE,
  pesce: PESCE,
  lumaca: LUMACA,
};
