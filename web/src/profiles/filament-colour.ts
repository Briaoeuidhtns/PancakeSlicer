import type { Config } from '../api/types';
import { getState, type State } from '../state/store';
import { editSetup } from '../printers/device-slots';
import { paletteName } from '../components/filament-palette';
import { DEFAULT_FILAMENT_COLOUR as DEFAULT_COLOUR } from './metadata';
import { randomId } from '../random-id';

const hex = (value: unknown): string | undefined => {
  const v = String(Array.isArray(value) ? value[0] ?? '' : value ?? '');
  return /^#[\da-f]{6}/i.test(v) ? v.slice(0, 7).toUpperCase() : undefined;
};
export const configColour = (config: Config) => hex(config.filament_colour) ?? hex(config.default_filament_colour);

export function profileSlotColour(s: State, slot: number): string {
  const key = s.filamentSlots[slot] ?? s.filamentSlots[0];
  return key ? configColour(resolvePreset(s, 'filament', key).config) ?? DEFAULT_COLOUR : DEFAULT_COLOUR;
}
export function slotColour(s: State, slot: number, printer = s.printer): string {
  const mix = mixAt(s, printer, slot);
  if (mix) return blend(mix.components.map((c) => c >= 1 && slotAt(s, printer, c - 1) ? slotColour(s, c - 1, printer) : '#808080'), mix.ratios);
  const reported = reportedTray(s, slot, printer);
  if (reported) return 'colour' in reported ? reported.colour : EMPTY_SLOT_COLOUR;
  return hex(slotAt(s, printer, slot)?.colour) ?? DEFAULT_COLOUR;
}

export function setSlotColour(slot: number, colour: string, printer = getState().printer): Promise<void> {
  const value = hex(colour), s = getState();
  if (!value) throw new Error('Pick a color first.');
  if (printer === s.printer && slotMixes(s)[slot]) throw new Error('A mixed slot gets its colour from the filaments it blends together.');
  const id = slotAt(s, printer, slot)?.id;
  if (!id) throw new Error('That slot is no longer on this printer.');
  return editSetup(printer, (setup) => ({ ...setup, slots: setup.slots.map((x) => (x.id === id ? { ...x, colour: value } : x)) }));
}

const ownedSource = (s: State, slot: number) => {
  const p = findProfile(s, 'filament', s.filamentSlots[slot] ?? '');
  if (!p || p.archived) throw new Error('Pick a saved filament for this slot first.');
  return p;
};
const withColour = (config: Config, colour: string): Config =>
  ({ ...config, filament_colour: Array.isArray(config.filament_colour) ? [colour] : colour });

export async function changeFilamentColour(slot: number, colour: string): Promise<void> {
  const value = hex(colour); if (!value) throw new Error('Pick a color first.');
  const s = getState(), source = ownedSource(s, slot), key = profileKey(source);
  const [{ saveProfile }, { commitProfileRecords }] = await Promise.all([import('./model'), import('./transactions')]);
  const record = { ...saveProfile(s, 'filament', source.name, key, withColour(resolvePreset(s, 'filament', key).config, value)), id: key };
  await commitProfileRecords([record], { apply: (st) => (st.filamentSlots[slot] === key ? followProfile(st, slot) : {}) });
}

const COLOUR_NAMES: [number, string][] = [[15, 'Red'], [40, 'Orange'], [65, 'Yellow'], [165, 'Green'], [195, 'Cyan'], [255, 'Blue'], [290, 'Purple'], [335, 'Pink'], [360, 'Red']];
export function colourName(colour: string): string {
  const v = hex(colour) ?? DEFAULT_COLOUR, preset = paletteName(v);
  if (preset) return preset;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (l < 0.12) return 'Black';
  if (l > 0.92) return 'White';
  if (sat < 0.15) return l > 0.6 ? 'Silver' : 'Gray';
  const h = d === 0 ? 0 : max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  const hue = (h + 360) % 360, name = COLOUR_NAMES.find(([limit]) => hue < limit)![1];
  return (name === 'Orange' || name === 'Red') && l < 0.35 ? 'Brown' : name;
}
