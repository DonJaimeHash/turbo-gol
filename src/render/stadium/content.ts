/**
 * What the LED boards show, per place (pure data; textures.ts draws it). Both harbour themes share
 * the harbour's set; every other theme has its own. A set holds BOARD_CARDS board cards (sponsors
 * with a tagline, an emblem and colours), in the slots the boards read:
 *
 *   cards    the generic sponsors (GENERIC, the same cards in every set, at the same slots;
 *            only the "MÁS GOL." tagline changes per place), a telecom and a games sponsor
 *            (the harbour's sea-named CORALINA and PIXELMAR; the inland places share INLAND) and
 *            the place's own sponsors
 *
 * Every name is invented for Turbogol (none is a real brand, company, product or team), in
 * Spanish, and the place's own names and emblems appear only in its set: the harbour's anchors,
 * lighthouse, waves, PUERTO SUR, LIGA PORTUARIA and harbour sponsors only on the harbour.
 */
import type { ThemeId } from '../theme';
import type { EmblemId } from './emblems';

export type Place = 'harbour' | 'canyon' | 'alpine';

/** The place each theme stands in (the harbour by night and by day share one set). */
export const THEME_PLACE: Readonly<Record<ThemeId, Place>> = {
  'harbour-night': 'harbour',
  'harbour-day': 'harbour',
  'canyon-sunset': 'canyon',
  'alpine-day': 'alpine',
};

export interface BoardCard {
  readonly name: string;
  readonly tag: string;
  readonly logo: EmblemId;
  /** Background gradient (top, bottom), text colour, accent / emblem colour. */
  readonly bg: readonly [string, string];
  readonly fg: string;
  readonly ac: string;
}

export interface ContentSet {
  readonly cards: readonly BoardCard[];
}

// ---- Generic sponsors (every place) -----------------------------------------------------------

const TURBOGOL: BoardCard = { name: 'TURBOGOL', tag: 'turbo-gol.com', logo: 'chevrons', bg: ['#0a0e17', '#04060b'], fg: '#ffffff', ac: '#c6ff2e' };
const CHISPA_VERDE: BoardCard = { name: 'CHISPA VERDE', tag: 'BEBIDA ENERGÉTICA', logo: 'bolt', bg: ['#121705', '#090b02'], fg: '#e9ff9a', ac: '#c6ff2e' };
const CANAL_CANCHA: BoardCard = { name: 'CANAL CANCHA', tag: 'TODOS LOS PARTIDOS', logo: 'ball', bg: ['#a8840f', '#735a05'], fg: '#14110a', ac: '#14110a' };
/** The game's own slogan card; the tagline names the place. */
const masGol = (tag: string): BoardCard => ({ name: 'MÁS GOL.', tag, logo: 'chevrons', bg: ['#0b1d42', '#06122a'], fg: '#ffffff', ac: '#3a9bff' });

/** The generic sponsors' names (in every set). */
export const GENERIC: readonly string[] = [TURBOGOL.name, CHISPA_VERDE.name, CANAL_CANCHA.name, 'MÁS GOL.'];

/** The telecom and games sponsors of the inland places (the harbour has its own sea-named ones). */
const RED_PLENA: BoardCard = { name: 'RED PLENA', tag: 'TELECOMUNICACIONES', logo: 'signal', bg: ['#b81a4e', '#820c33'], fg: '#ffffff', ac: '#ffffff' };
const FICHA_EXTRA: BoardCard = { name: 'FICHA EXTRA', tag: 'VIDEOJUEGOS', logo: 'bolt', bg: ['#250840', '#140423'], fg: '#ffffff', ac: '#ff4fd8' };
type Pair = readonly [telecom: BoardCard, games: BoardCard];
const INLAND_PAIR: Pair = [RED_PLENA, FICHA_EXTRA];
/** Their names (in every set but the harbour's). */
export const INLAND: readonly string[] = INLAND_PAIR.map((c) => c.name);

/**
 * A place's 20 cards: the generic ones at slots 1, 3, 9 and 10, its telecom and games sponsors at
 * 8 and 16, its own 14 (in order) at the others.
 */
function cards(own: readonly BoardCard[], slogan: string, [telecom, games]: Pair): BoardCard[] {
  const fixed: Readonly<Partial<Record<number, BoardCard>>> = { 1: TURBOGOL, 3: CHISPA_VERDE, 8: telecom, 9: CANAL_CANCHA, 10: masGol(slogan), 16: games };
  const out: BoardCard[] = [];
  let k = 0;
  for (let i = 0; i < own.length + 6; i++) out.push(fixed[i] ?? own[k++]);
  return out;
}

export const CONTENT: Readonly<Record<Place, ContentSet>> = {
  // A harbour town: the port league, the sea, ships and cranes.
  harbour: {
    cards: cards(
      [
        { name: 'PUERTO SUR', tag: 'LIGA DEL PUERTO', logo: 'anchor', bg: ['#0b1d42', '#06122a'], fg: '#ffffff', ac: '#ffffff' },
        { name: 'MARELUX', tag: 'ENERGÍA DEL MAR', logo: 'wave', bg: ['#08305a', '#051d3d'], fg: '#ffffff', ac: '#47d2ff' },
        { name: 'FARO ALTO', tag: 'NEUMÁTICOS', logo: 'lighthouse', bg: ['#1a2233', '#0e131f'], fg: '#ffffff', ac: '#ffffff' },
        { name: 'ESTIBA', tag: 'LOGÍSTICA PORTUARIA', logo: 'chevrons', bg: ['#9c420a', '#6a2a04'], fg: '#ffffff', ac: '#ffffff' },
        { name: 'BOYA AZUL', tag: 'SEGUROS', logo: 'ball', bg: ['#164fae', '#0c337a'], fg: '#ffffff', ac: '#ffffff' },
        { name: 'NUDO SIETE', tag: 'ROPA DEPORTIVA', logo: 'anchor', bg: ['#0f0f0f', '#000000'], fg: '#ffffff', ac: '#ffcc00' },
        { name: 'ONDAMAR', tag: 'CRUCEROS', logo: 'lighthouse', bg: ['#052a3e', '#031a27'], fg: '#ffffff', ac: '#ffd36b' },
        { name: 'GRÚA NORTE', tag: 'MAQUINARIA', logo: 'chevrons', bg: ['#14120a', '#0a0904'], fg: '#ffd21f', ac: '#ffd21f' },
        { name: 'SALINA', tag: 'AGUA MINERAL', logo: 'wave', bg: ['#092647', '#05162c'], fg: '#e6f4ff', ac: '#4fb3ff' },
        { name: 'TIMONEL', tag: 'BANCO DIGITAL', logo: 'anchor', bg: ['#181238', '#0c0921'], fg: '#ffffff', ac: '#9b8cff' },
        { name: 'VELA ROJA', tag: 'PIZZERÍA', logo: 'ball', bg: ['#aa0e27', '#74081a'], fg: '#ffffff', ac: '#ffffff' },
        { name: 'MUELLE 9', tag: 'MERCADO', logo: 'anchor', bg: ['#0d3528', '#072118'], fg: '#ffffff', ac: '#7cf0b5' },
        { name: 'AEROFARO', tag: 'AEROLÍNEA', logo: 'wave', bg: ['#0e1527', '#070b15'], fg: '#ffffff', ac: '#8fd0ff' },
        { name: 'LIGA PORTUARIA', tag: 'NOCHE DE PUERTO', logo: 'anchor', bg: ['#0b1d42', '#06122a'], fg: '#ffffff', ac: '#ffffff' },
      ],
      'MÁS TURBO. MÁS PUERTO.',
      [
        { name: 'CORALINA', tag: 'TELECOMUNICACIONES', logo: 'wave', bg: ['#b81a4e', '#820c33'], fg: '#ffffff', ac: '#ffffff' },
        { name: 'PIXELMAR', tag: 'VIDEOJUEGOS', logo: 'bolt', bg: ['#250840', '#140423'], fg: '#ffffff', ac: '#ff4fd8' },
      ],
    ),
  },
  // A red canyon at sunset: mesas, cactus, dust, the sun going down.
  canyon: {
    cards: cards(
      [
        { name: 'CAÑÓN ROJO', tag: 'LIGA DEL CAÑÓN', logo: 'sunMesa', bg: ['#4a1208', '#2c0a04'], fg: '#ffffff', ac: '#ff9a4a' },
        { name: 'SOL BRAVO', tag: 'ENERGÍA SOLAR', logo: 'sunMesa', bg: ['#6e3205', '#431e02'], fg: '#ffffff', ac: '#ffd36b' },
        { name: 'PIEDRA LISA', tag: 'NEUMÁTICOS', logo: 'ball', bg: ['#1c1611', '#0e0b08'], fg: '#f2d2a8', ac: '#e0a060' },
        { name: 'POLVAREDA', tag: 'TRANSPORTE DE CARGA', logo: 'chevrons', bg: ['#8a3a12', '#5a2208'], fg: '#ffffff', ac: '#ffffff' },
        { name: 'ESPINAR', tag: 'SEGUROS', logo: 'cactus', bg: ['#123a2a', '#0a2219'], fg: '#ffffff', ac: '#9be07a' },
        { name: 'VIENTO SECO', tag: 'ROPA DEPORTIVA', logo: 'chevrons', bg: ['#0f0f0f', '#000000'], fg: '#ffffff', ac: '#ff7a2e' },
        { name: 'EL MIRADOR', tag: 'EXCURSIONES AL ATARDECER', logo: 'sunMesa', bg: ['#3b1a3f', '#220e25'], fg: '#ffffff', ac: '#ff9a6b' },
        { name: 'OCRE', tag: 'MAQUINARIA PESADA', logo: 'chevrons', bg: ['#14120a', '#0a0904'], fg: '#ffb347', ac: '#ffb347' },
        { name: 'POZO AZUL', tag: 'AGUA MINERAL', logo: 'cactus', bg: ['#0c2a4a', '#06182c'], fg: '#e6f4ff', ac: '#6fc3ff' },
        { name: 'MESETA', tag: 'BANCO DIGITAL', logo: 'sunMesa', bg: ['#2a1408', '#160a03'], fg: '#ffe0b0', ac: '#e88a2a' },
        { name: 'HORNO DE BARRO', tag: 'PIZZERÍA', logo: 'ball', bg: ['#8a1f0e', '#5a1206'], fg: '#ffffff', ac: '#ffffff' },
        { name: 'POSTA 7', tag: 'MERCADO', logo: 'cactus', bg: ['#2e3a10', '#1a2208'], fg: '#ffffff', ac: '#d8f07c' },
        { name: 'AEROMESA', tag: 'AEROLÍNEA', logo: 'chevrons', bg: ['#0e1527', '#070b15'], fg: '#ffffff', ac: '#ffb38f' },
        { name: 'COPA ATARDECER', tag: 'FINAL AL ATARDECER', logo: 'sunMesa', bg: ['#4a1208', '#2c0a04'], fg: '#ffffff', ac: '#ffffff' },
      ],
      'MÁS TURBO. MÁS CAÑÓN.',
      INLAND_PAIR,
    ),
  },
  // A mountain valley at midday: peaks, pine forest, snow, the valley's farms and lifts.
  alpine: {
    cards: cards(
      [
        { name: 'VALLE ALTO', tag: 'LIGA DEL VALLE', logo: 'peak', bg: ['#0e2a4a', '#071a30'], fg: '#ffffff', ac: '#ffffff' },
        { name: 'SALTO BLANCO', tag: 'ENERGÍA DEL RÍO', logo: 'peak', bg: ['#08305a', '#051d3d'], fg: '#ffffff', ac: '#7fe0ff' },
        { name: 'NIEVE NUEVA', tag: 'NEUMÁTICOS DE INVIERNO', logo: 'chevrons', bg: ['#1a2233', '#0e131f'], fg: '#ffffff', ac: '#bfe6ff' },
        { name: 'TRINEO EXPRESO', tag: 'MENSAJERÍA', logo: 'chevrons', bg: ['#7a1a10', '#4a0e08'], fg: '#ffffff', ac: '#ffd6a0' },
        { name: 'ROBLE FIRME', tag: 'SEGUROS', logo: 'pine', bg: ['#1d4f8a', '#103259'], fg: '#ffffff', ac: '#ffffff' },
        { name: 'CUMBRE BLANCA', tag: 'ROPA DE MONTAÑA', logo: 'peak', bg: ['#0f0f0f', '#000000'], fg: '#ffffff', ac: '#ffffff' },
        { name: 'TELESILLA', tag: 'ESQUÍ Y TRINEO', logo: 'peak', bg: ['#a8180f', '#700e08'], fg: '#ffffff', ac: '#ffffff' },
        { name: 'EL PINAR', tag: 'MADERERA', logo: 'pine', bg: ['#0f3020', '#071c12'], fg: '#ffffff', ac: '#9be07a' },
        { name: 'ARROYO CLARO', tag: 'AGUA MINERAL', logo: 'peak', bg: ['#092647', '#05162c'], fg: '#e6f4ff', ac: '#4fb3ff' },
        { name: 'PICO HELADO', tag: 'HELADERÍA', logo: 'peak', bg: ['#181238', '#0c0921'], fg: '#ffffff', ac: '#c8f0ff' },
        { name: 'HORNO DE LEÑA', tag: 'PIZZERÍA', logo: 'ball', bg: ['#8a1a12', '#5a0f0a'], fg: '#ffffff', ac: '#ffffff' },
        { name: 'CENCERRO', tag: 'QUESOS DEL VALLE', logo: 'pine', bg: ['#3a2412', '#22140a'], fg: '#ffe3c0', ac: '#ffb35a' },
        { name: 'MIRLO AZUL', tag: 'AEROLÍNEA', logo: 'chevrons', bg: ['#0e1527', '#070b15'], fg: '#ffffff', ac: '#a8e0ff' },
        { name: 'COPA DEL PINAR', tag: 'TARDE EN EL VALLE', logo: 'pine', bg: ['#0e2a4a', '#071a30'], fg: '#ffffff', ac: '#ffffff' },
      ],
      'MÁS TURBO. MÁS ALTURA.',
      INLAND_PAIR,
    ),
  },
};

/** The board content of a theme. */
export function themeContent(theme: ThemeId): ContentSet {
  return CONTENT[THEME_PLACE[theme]];
}
