import type { Config, ConfigValue } from '../api/types';
import { Dropdown } from '../components/Dropdown';
import { resolvePreset, toast, useStore } from '../state/store';
import { selectionValues } from './view';
import './extruder-rows.css';
import { extruderLabel, valuesOf } from '../multinozzle/config';
import { INSTALLED } from './records';
import { setPrinterNozzle } from './record-edits';

const TYPES = ['Direct Drive', 'Bowden'];
const split = (variant: string) => { const type = TYPES.find((t) => variant.startsWith(`${t} `)) ?? 'Direct Drive'; return { type, volume: variant.slice(type.length).trim() || 'Standard' }; };
export function extruderChoices(config: Config) {
  const count = extruderCount(config), lists = valuesOf(config.extruder_variant_list);
  const volume = config.nozzle_volume_type ?? config.default_nozzle_volume_type;
  const rows = Array.from({ length: count }, (_, i) => {
    const installed = `${valueAt(config.extruder_type, i, 'Direct Drive')} ${valueAt(volume, i, 'Standard')}`;
    const options = [...new Set([installed, ...(lists[i] ?? '').split(',').map((v) => v.trim()).filter(Boolean)])];
    return { installed, options, nozzle: valueAt(config.nozzle_diameter, i) };
  });
  return count > 1 || rows.some((r) => r.options.length > 1) ? rows : null;
}
export function installVariant(config: Config, i: number, variant: string): Record<string, ConfigValue> {
  const count = extruderCount(config), { type, volume } = split(variant);
  return { nozzle_volume_type: replaceAt(config.nozzle_volume_type ?? config.default_nozzle_volume_type, i, volume, count),
    extruder_type: replaceAt(config.extruder_type, i, type, count) };
}
async function saveOnPrinter(i: number, variant: string) {
  const s = getState(), source = findProfile(s, 'machine', s.printer);
  if (!source || source.archived) throw new Error('Please select a saved printer first.');
  const key = profileKey(source), config = resolvePreset(s, 'machine', key).config;
  const [{ saveProfile }, { commitProfileRecords }] = await Promise.all([import('./model'), import('./transactions')]);
  const record = { ...saveProfile(s, 'machine', source.name, key, { ...config, ...installVariant(config, i, variant) }), id: key };
  await commitProfileRecords([record], { apply: (st: State) => {
    if (st.printer !== key || !('nozzle_volume_type' in st.dirty.machine || 'extruder_type' in st.dirty.machine)) return {};
    const { nozzle_volume_type: _volume, extruder_type: _type, ...rest } = st.dirty.machine;
    return { dirty: { ...st.dirty, machine: rest } };
  } });
}

export function ExtruderRows({ printerId, disabled, grid }: { printerId?: string; disabled?: boolean; grid?: boolean }) {
  const selected = useStore((s) => s.printer), id = printerId ?? selected;
  const printer = useStore((s) => s.records.printers.find((p) => p.id === id));
  const known = useStore((s) => id !== s.printer || selectionValues(s, 'machine', 0).state === 'ready');
  const lists = valuesOf(useStore((s) => resolvePreset(s, 'machine', id).config.extruder_variant_list));
  if (!printer) return null;
  const rows = printer.nozzles.map((n, i) => {
    const installed = `${n.type ?? INSTALLED.type} ${n.volume ?? INSTALLED.volume}`;
    return { installed, nozzle: String(n.diameter), options: [...new Set([...(lists[i] ?? '').split(',').map((v) => v.trim()).filter(Boolean), installed])] };
  });
  if (rows.length < 2 && (!known || !rows.some((r) => r.options.length > 1))) return null;
  const bambu = printer.vendor === 'BBL';
  const set = (i: number, variant: string) => void setPrinterNozzle(id, i, split(variant))
    .catch((error) => toast('extruderrows_failed', { detail: error instanceof Error ? error.message : String(error) }));
  return <div className={grid ? 'extruder-rows grid' : 'extruder-rows'} role="group" aria-label="Extruders">{rows.map((row, i) => {
    const label = rows.length > 1 ? extruderLabel(i, rows.length, bambu).replace(/ nozzle$/, '') : 'Extruder';
    const control = row.options.length > 1 ? <Dropdown className="combo two-line" aria-label={`${label} extruder`} disabled={disabled} value={row.installed}
      options={row.options.map((value) => ({ value, label: value, short: value.replace(/^Direct Drive /, ''), sub: `${row.nozzle} mm` }))} onValueChange={(value) => value !== row.installed && set(i, value)}/>
      : <span className="extruder-variant"><span className="dropdown-value">{row.installed.replace(/^Direct Drive /, '')}<span className="dropdown-sub">{row.nozzle} mm</span></span></span>;
    return <div key={i} className={grid ? 'opt-line extruder-row' : 'extruder-row'}>
      <span className={grid ? 'opt-label' : 'extruder-name'}>{label}</span>{grid ? <span className="opt-field">{control}</span> : control}
    </div>;
  })}</div>;
}
