/**
 * The dashboard palette: the validated reference palette of the data-viz method (categorical
 * order, sequential blue ramp, blue/red diverging pair, fixed status colors, chart chrome),
 * light and dark steps chosen separately. The stylesheet's tokens are generated from this file,
 * so charts, CSS and exports never disagree.
 */
export const CATEGORICAL = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
} as const;

export const SEQUENTIAL_BLUE = [
  '#cde2fb',
  '#b7d3f6',
  '#9ec5f4',
  '#86b6ef',
  '#6da7ec',
  '#5598e7',
  '#3987e5',
  '#2a78d6',
  '#256abf',
  '#1c5cab',
  '#184f95',
  '#104281',
  '#0d366b',
] as const;

export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const;

export interface ThemeTokens {
  plane: string;
  surface: string;
  surfaceRaised: string;
  ink: string;
  inkSecondary: string;
  inkMuted: string;
  grid: string;
  axis: string;
  border: string;
  other: string;
  deltaGood: string;
  deltaBad: string;
  accent: string;
  accentWash: string;
  /** In-cell data bars in tables: the first series hue, quieter than a chart mark. */
  databar: string;
  divergingMid: string;
  focus: string;
  hover: string;
  /** Text inside a light sequential cell and inside a dark one. */
  seqInkLow: string;
  seqInkHigh: string;
}

export const THEME: Record<'light' | 'dark', ThemeTokens> = {
  light: {
    plane: '#f9f9f7',
    surface: '#fcfcfb',
    surfaceRaised: '#ffffff',
    ink: '#0b0b0b',
    inkSecondary: '#52514e',
    inkMuted: '#6f6e69',
    grid: '#e1e0d9',
    axis: '#c3c2b7',
    border: 'rgba(11,11,11,0.10)',
    other: '#898781',
    deltaGood: '#006300',
    deltaBad: '#b42f2f',
    accent: '#2a78d6',
    accentWash: 'rgba(42,120,214,0.10)',
    databar: 'rgba(42,120,214,0.55)',
    divergingMid: '#f0efec',
    focus: '#2a78d6',
    hover: 'rgba(11,11,11,0.05)',
    seqInkLow: '#0b0b0b',
    seqInkHigh: '#ffffff',
  },
  dark: {
    plane: '#0d0d0d',
    surface: '#1a1a19',
    surfaceRaised: '#232322',
    ink: '#f0efec',
    inkSecondary: '#c3c2b7',
    inkMuted: '#9c9b94',
    grid: '#2c2c2a',
    axis: '#383835',
    border: 'rgba(255,255,255,0.10)',
    other: '#898781',
    deltaGood: '#0ca30c',
    deltaBad: '#e66767',
    accent: '#3987e5',
    accentWash: 'rgba(57,135,229,0.16)',
    databar: 'rgba(57,135,229,0.65)',
    divergingMid: '#383835',
    focus: '#86b6ef',
    hover: 'rgba(255,255,255,0.06)',
    seqInkLow: '#f0efec',
    seqInkHigh: '#0b0b0b',
  },
};

function tokenBlock(mode: 'light' | 'dark'): string {
  const t = THEME[mode];
  const lines = [
    `--plane: ${t.plane}`,
    `--surface: ${t.surface}`,
    `--surface-raised: ${t.surfaceRaised}`,
    `--ink: ${t.ink}`,
    `--ink-2: ${t.inkSecondary}`,
    `--ink-3: ${t.inkMuted}`,
    `--grid: ${t.grid}`,
    `--axis: ${t.axis}`,
    `--border: ${t.border}`,
    `--series-other: ${t.other}`,
    `--delta-good: ${t.deltaGood}`,
    `--delta-bad: ${t.deltaBad}`,
    `--accent: ${t.accent}`,
    `--accent-wash: ${t.accentWash}`,
    `--databar: ${t.databar}`,
    `--diverging-mid: ${t.divergingMid}`,
    `--focus: ${t.focus}`,
    `--hover: ${t.hover}`,
    `--seq-ink-low: ${t.seqInkLow}`,
    `--seq-ink-high: ${t.seqInkHigh}`,
    ...CATEGORICAL[mode].map((c, i) => `--series-${i + 1}: ${c}`),
    // Sequential flips its anchor in dark mode: low values sit near the dark surface.
    ...(mode === 'light' ? SEQUENTIAL_BLUE : [...SEQUENTIAL_BLUE].reverse()).map(
      (c, i) => `--seq-${i}: ${c}`,
    ),
  ];
  return lines.join(';\n  ');
}

/**
 * The token stylesheet: every token on bare `:root` (light), redefined for dark under the OS
 * preference (unless the viewer chose light) and under an explicit dark choice.
 */
export function themeCss(): string {
  const status = Object.entries(STATUS)
    .map(([k, v]) => `--status-${k}: ${v}`)
    .join(';\n  ');
  return [
    `:root {\n  color-scheme: light;\n  ${tokenBlock('light')};\n  ${status};\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n  color-scheme: dark;\n  ${tokenBlock('dark')};\n  }\n}`,
    `:root[data-theme="dark"] {\n  color-scheme: dark;\n  ${tokenBlock('dark')};\n}`,
  ].join('\n');
}

/** A sequential step (0 = lightest) for a value in [0, 1]. */
export function sequentialStep(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return Math.round(clamped * (SEQUENTIAL_BLUE.length - 1));
}
