// goal: centralizes visual theme tokens and canvas draw styles for the popup UI

import { UIColors } from '@nexus/audio-engine';

export const COLORS = UIColors;

// EQ_GRADIENT: drawing parameters for the equalizer's frequency response curve canvas
export const EQ_GRADIENT = {
  TOP: 'rgba(37, 99, 235, 0.25)',
  BOTTOM: 'rgba(37, 99, 235, 0.0)',
  SHADOW: 'rgba(37, 99, 235, 0.5)',
  STROKE: '#2563eb',
} as const;

export type ColorKey = keyof typeof COLORS;
