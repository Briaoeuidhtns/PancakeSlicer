import { useState } from 'react';
import { OPTIONS } from '../options';
import { getState, printerPreset, setState, toast, useStore } from '../state/store';
import { undo, undoable } from '../state/history';
import { flushModified } from '../flush-state';
import { Dropdown } from '../components/Dropdown';
import { Glyph } from '../components/Glyph';
import { MenuButton, type MenuEntry } from '../components/Menu';
import './profiles.css';
import { NozzleSize } from './NozzleSize';
import { slotFilaments, slotMixes } from './slots';
import { slotExtruder } from '../printers/feeds';

export function NozzleField() {
  const printer = useStore((s) => s.printer);
  return printer ? <NozzleSize printerId={printer} grid/> : null;
}

const PLATE_SHORT: Record<string, string> = { 'Smooth Cool Plate': 'Cool Plate', 'Engineering Plate': 'Engineering', 'Smooth High Temp Plate': 'High Temp',
  'Smooth PEI Plate': 'Smooth PEI', 'Textured PEI Plate': 'Textured PEI', 'Textured Cool Plate': 'Textured Cool', 'Cool Plate (SuperTack)': 'SuperTack' };

export function addFilament() {
  void import('../plater/mixed').then((m) => m.addPhysical()).catch((error) => toast(String(error)));
}

export function addSlot(name: string) {
  void import('../plater/mixed').then((m) => m.addPhysical(undefined, name)).catch((error) => toast(String(error)));
}

export function removeSlot(i: number) {
  void import('../plater/mixed').then(({ removeSlotAt }) => {
    const done = removeSlotAt(i + 1);
    if (!done) return;
    const notes = [done.moved ? `${done.moved} object${done.moved === 1 ? '' : 's'} moved to slot ${done.to}` : '', ...done.merged.map((d) => `mix ${d.mix} merged into slot ${d.into}`)].filter(Boolean);
    toast([`Removed filament ${i + 1}`, ...notes].join('; '), { label: 'Undo', run: undo });
  });
}

export function FilamentMenu({ extra = [] }: { extra?: MenuEntry[] }) {
  const slots = useStore((s) => slotFilaments(s).length);
  const physical = slots - Object.keys(useStore((s) => slotMixes(s))).length;
  const flushChanged = useStore((st) => flushModified(st));
  const amsPrinter = useStore((st) => st.printerConnections.connections.some((c) => c.printer === st.printer && c.kind === 'bambu-lan') ? st.printer : undefined);
  const [syncing, setSyncing] = useState(false);
  const sync = () => {
    if (!amsPrinter || syncing) return;
    setSyncing(true);
    void import('../plater/amsSync').then((m) => m.syncAms(amsPrinter)).finally(() => setSyncing(false));
  };
  const items: MenuEntry[] = [
    ...(physical > 1 ? [{ label: flushChanged ? 'Flushing volumes (edited)…' : 'Flushing volumes…', action: () => setState({ flushDialog: true }) }] : []),
    ...(amsPrinter ? [{ label: syncing ? 'Syncing from AMS…' : 'Sync from AMS', disabled: syncing, action: sync }] : []),
    ...(physical > 1 ? [{ label: 'Mixed filament…', action: () => setState({ appDialog: 'mixed' }) }] : []),
  ];
  return items.length ? <MenuButton className="icon-btn rail-act" label="Slot tools" items={items}><Glyph name="more"/></MenuButton> : null;
}
