import { noticeText } from '../notice-codes';
import { getState, toast } from '../state/store';
import { commitRecords } from './transactions';
import type { FilamentRecord, LibraryRecords, PrinterRecord } from './records';
import { printerVendors, type CatalogModel, type CatalogVendor } from './catalog-reads';
import { catalogLine, defaultVariant, listRead, useCatalogRead } from '../catalog/read';
import type { CatalogEntry } from '../catalog/types';
import { feedOf, layoutSetup } from '../printers/feeds';
import { randomId } from '../random-id';

export type CatalogRead = { vendors: CatalogVendor[] } | { products: CatalogEntry[] };
export function useCatalog(type: 'machine' | 'filament' | 'process', adding: boolean): { data?: CatalogRead; error?: string } {
  const read = useCatalogRead(listRead(type === 'machine' ? 'printers' : 'filaments'));
  if (!adding || type === 'process') return {};
  if (!read.value) return read.error ? { error: read.error } : {};
  return type === 'machine' ? { data: { vendors: printerVendors(read.value) } } : { data: { products: read.value.entries } };
}

const plain = (name: string) => name.replace(/\s+@.*$/, '').trim();
const anchor = (name: string, vendor: string) => ({ name, engineName: name, version: '', vendor });

export interface PrinterChoice { vendor: string; model: CatalogModel; nozzle: string }
export interface FamilyChoice { family: CatalogFamily; colour?: string; label?: string }
export interface AddResult { keys: string[]; existing: string[]; skipped: string[]; chosen: string[] }

export async function printDefaults({ vendor, model, nozzle }: PrinterChoice): Promise<Config | undefined> {
  const machine = model.machines[nozzle], api = getState().api;
  if (!machine) throw new Error(`${model.name} doesn't have a ${nozzle} mm nozzle preset.`);
  const preset = findCatalogBase(getState(), 'machine', machine).base ?? (api && (await api.presets(vendor, [], undefined, [machine])).machines.find((p) => p.name === machine));
  const supplied = (preset as { print_defaults?: Config } | undefined)?.print_defaults;
  return supplied && Object.fromEntries(Object.entries(supplied).filter(([key]) => !SPEED_KEYS.has(key)));
}
const owned = (s: State) => s.userPresets.filter((p) => !p.archived);
const namer = (s: State) => {
  const planned: UserPreset[] = [];
  return { name: (type: 'machine' | 'filament', wanted: string) => uniqueName({ ...s, userPresets: [...s.userPresets, ...planned] }, type, wanted), keep: (p: UserPreset) => { planned.push(p); return p; } };
};

export async function addCatalogPrinters(choices: PrinterChoice[]): Promise<AddResult> {
  const defaults = await Promise.all(choices.map(printDefaults));
  let existing: string[] = [], chosen: string[] = [];
  const result = await profileBatchCreation((s) => {
    const names = namer(s), taken = new Map(owned(s).filter((p) => p.type === 'machine').map((p) => [p.base?.name ?? p.inherits, profileKey(p)]));
    const skipped: string[] = [], records: UserPreset[] = [];
    existing = []; chosen = [];
    choices.forEach((choice, i) => {
      const { vendor, model, nozzle } = choice, machine = model.machines[nozzle], label = plain(nozzle === '0.4' || model.nozzles.length === 1 ? model.name : `${model.name} ${nozzle} nozzle`);
      if (taken.has(machine)) { skipped.push(label); existing.push(taken.get(machine)!); chosen.push(taken.get(machine)!); return; }
      taken.set(machine, '');
      const id = `profile:${randomId()}`; chosen.push(id);
      records.push(names.keep({ id, type: 'machine', kind: 'profile', name: names.name('machine', label), revision: 0, inherits: machine,
        base: anchor(machine, vendor), overlay: {}, overrides: {}, ...(defaults[i] && Object.keys(defaults[i]!).length ? { printOverrides: { ...defaults[i] } } : {}) } as UserPreset));
    });
    return { records, skipped };
  }).commit();
  return { keys: result.keys, existing, skipped: result.skipped, chosen };
}
export async function addCatalogPrinter(vendor: string, model: CatalogModel, nozzle: string): Promise<string> {
  const { keys, skipped } = await addCatalogPrinters([{ vendor, model, nozzle }]);
  if (!keys.length) throw new Error(`${skipped[0]} is already in your printers list.`);
  return keys[0];
}

export function addCatalogProducts(choices: ProductChoice[]): Promise<AddResult> {
  return add('filament', (doc) => {
    const name = namer(doc.filaments), live = doc.filaments.filter((f) => !f.archived);
    const records: FilamentRecord[] = [], existing: string[] = [], skipped: string[] = [], chosen: string[] = [], wanted: string[] = [];
    for (const { product, label } of choices) {
      const want = plain(label ?? product.id), have = [...live, ...records].find((f) => f.product === product.id);
      if (have) { skipped.push(want); existing.push(have.id); chosen.push(have.id); continue; }
      const record: FilamentRecord = { id: `profile:${randomId()}`, name: name(want), revision: 0, product: product.id };
      records.push(record); chosen.push(record.id); wanted.push(want);
    }
    return { records, existing, skipped, chosen, wanted };
  });
}
export async function addCatalogProduct(product: CatalogEntry, label?: string): Promise<string> {
  const { keys, skipped } = await addCatalogProducts([{ product, label }]);
  if (!keys.length) throw new Error(`${skipped[0]} is already in your filaments list.`);
  return keys[0];
}

export async function addPrinterOnVariant(model: CatalogModel, variantId: string, name?: string): Promise<string> {
  const variant = (await catalogLine('printers', model.id)).variants.find((v) => v.id === variantId);
  if (!variant) throw new Error(`Oops! We couldn't find ${variantId} in the catalog.`);
  const { keys, existing } = await addCatalogPrinters([{ vendor: model.vendor, model, nozzle: variant.nozzle }]);
  const key = keys[0] ?? existing[0];
  const printers = getState().records.printers, record = printers.find((p) => p.id === key);
  if (record && name && record.name !== name) await commitRecords([{ kind: 'printer', record: { ...record, name: namer(printers.filter((p) => p.id !== key))(name) } }], { label: 'Rename printer' });
  return key;
}
