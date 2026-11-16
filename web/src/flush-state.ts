import type { State } from './state/store';
import { plateSetup } from './profiles/plate-setup';
import { slotFilaments } from './profiles/slots';

export const MULTIPLIER_RANGE: [number, number] = [0, 3];
export const MAX_FLUSH_VOLUME = 20000;

export function nozzleFlush(s: State, nozzle = 0) {
  return plateSetup(s)?.flushing?.nozzles[nozzle] ?? null;
}

export function allFlush(s: State): { matrix: number[]; multipliers: number[] } | null {
  const nozzles = plateSetup(s)?.flushing?.nozzles;
  return nozzles ? { matrix: nozzles.flatMap((n) => n.matrix), multipliers: nozzles.map((n) => n.multiplier) } : null;
}

export function defaultMultiplier(s: State, nozzle = 0): number {
  const v = effectiveConfig(s, 'process').flush_multiplier ?? (OPTIONS.flush_multiplier?.default as number[] | undefined);
  const first = Array.isArray(v) ? v[Math.min(nozzle, v.length - 1)] : v;
  return Number.isFinite(Number(first)) ? Number(first) : 1;
}

export function currentFlush(s: State, nozzle = 0): { matrix: number[]; multiplier: number } {
  const n = s.filamentSlots.length;
  const table = s.flush.matrix ?? (s.project ? s.projectMaterials?.matrix : null);
  const count = extruderCount(effectiveConfig(s, 'machine'));
  const saved = table?.length === n * n * count ? table.slice(nozzle * n * n, (nozzle + 1) * n * n) : table?.length === n * n ? table : null;
  return { matrix: saved ?? autoFlushMatrix(s, nozzle), multiplier: s.flush.multiplier ?? defaultMultiplier(s, nozzle) };
}

export function allFlush(s: State): { matrix: number[]; multipliers: number[] } {
  const tables = Array.from({ length: extruderCount(effectiveConfig(s, 'machine')) }, (_, nozzle) => currentFlush(s, nozzle));
  return { matrix: tables.flatMap((t) => t.matrix), multipliers: tables.map((t) => t.multiplier) };
}

export function flushModified(s: State): boolean {
  const flushing = s.records.printers.find((p) => p.id === s.printer)?.flushing;
  return !!plateSetup(s)?.flushing && !!(flushing?.volumes?.length || flushing?.multipliers?.length);
}
