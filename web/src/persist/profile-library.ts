import { mutation, responseError } from '../api/access';
import { LIBRARY_SCHEMA, type LibraryRecords } from '../profiles/records';
import { setState, type State } from '../state/store';

export interface LibraryProblem { code: string; message: string }
export interface LibraryHealth { problems: Record<string, LibraryProblem>; notices: LibraryProblem[] }
interface LibraryAnswer { document: LibraryRecords; problems: Record<string, LibraryProblem>; notices: LibraryProblem[] }

export function problemText(problem: LibraryProblem | undefined, name: string): string | undefined {
  if (!problem) return undefined;
  const text = problem.message.startsWith(`${name}: `) ? problem.message.slice(name.length + 2) : problem.message;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function recordProblems(s: Pick<State, 'libraryHealth' | 'records'>, kind: 'machine' | 'process' | 'filament', id: string, name: string): string[] {
  const { problems } = s.libraryHealth, out = [problemText(problems[id], name)];
  if (kind !== 'process') for (const c of s.records.calibrations) {
    const problem = problems[c.id];
    if (!problem || (kind === 'filament' ? c.filament : c.printer) !== id) continue;
    const filament = s.records.filaments.find((f) => f.id === c.filament)?.name ?? '', printer = s.records.printers.find((p) => p.id === c.printer)?.name ?? '';
    const owner = `${filament} on ${printer}: `, rest = problem.message.startsWith(owner) ? problem.message.slice(owner.length) : problem.message;
    out.push(kind === 'filament' ? `On ${printer}: ${rest}` : `${filament}: ${rest}`);
  }
  return out.filter((t): t is string => !!t);
}

function adopted(answer: LibraryAnswer): LibraryRecords {
  const doc = checked(answer.document);
  setState({ libraryHealth: { problems: answer.problems ?? {}, notices: answer.notices ?? [] } });
  return doc;
}

async function toV4(p: ProfileOverlay): Promise<V4Record> {
  const type = v4Type[p.type], extra = p as ProfileOverlay & { printOverrides?: Config; auto?: { scales?: ScaleRow[]; preferredHeight?: number; heightRule?: string; speedModel?: SpeedModel } };
  const base: V4Record = { id: p.id!, type, name: p.name.replace(/\s+@.*$/, '').trim() || p.name, revision: p.revision ?? 0, ...(p.archived ? { archived: p.archived } : {}) };
  const overlay = { ...p.overlay };
  if (type === 'printer') {
    const name = p.base.name, catalog = await printerCatalog();
    for (const v of catalog) for (const m of v.models) for (const [nozzle, machine] of Object.entries(m.machines ?? {}))
      if (machine === name) return { ...base, vendor: v.id, model: m.id, nozzle: Number(nozzle), ...(Object.keys(overlay).length ? { machine: overlay } : {}),
        ...(extra.printOverrides && Object.keys(extra.printOverrides).length ? { printOverrides: extra.printOverrides } : {}) };
    const model = first(overlay.printer_model), nozzle = Number(first(overlay.nozzle_diameter));
    return { ...base, vendor: p.base.vendor ?? '', model, nozzle, ...(Object.keys(overlay).length ? { machine: overlay } : {}) };
  }
  if (type === 'filament') {
    const vendor = p.base.vendor ?? 'BBL', list = await filamentCatalog(vendor).catch(() => []);
    const family = String(p.metadata?.family ?? '') || list.find((f) => f.fallback === p.base.name || Object.values(f.variants ?? {}).includes(p.base.name))?.id || `${vendor}/${p.base.name.replace(/\s+@.*$/, '')}`;
    writtenFilaments.set(p.id!, { family, base: p.base, ...(p.metadata ? { metadata: p.metadata } : {}) });
    const known = list.find((f) => f.id === family), colour = first(overlay.filament_colour);
    delete overlay.filament_colour;
    const rule = (p as { applicability?: { printers?: { models?: string[] }; nozzle?: { sizes?: number[] } } }).applicability;
    const fits = rule?.printers?.models?.length || rule?.nozzle?.sizes?.length ? { ...(rule.printers?.models?.length ? { models: rule.printers.models } : {}), ...(rule.nozzle?.sizes?.length ? { nozzles: rule.nozzle.sizes } : {}) } : undefined;
    return { ...base, family, ...(known?.brand ? { brand: known.brand } : {}), ...(known?.material ? { material: known.material } : {}), ...(colour ? { colour } : {}),
      ...(Object.keys(overlay).length ? { settings: overlay } : {}), ...(fits ? { fits } : {}) };
  }
  return { ...base, ...(Object.keys(overlay).length ? { values: overlay } : {}), ...(extra.auto?.scales?.length ? { scales: extra.auto.scales } : {}),
    ...(extra.auto?.speedModel ? { speedModel: extra.auto.speedModel } : {}),
    ...(extra.auto?.preferredHeight ? { preferredHeight: extra.auto.preferredHeight } : {}), ...(extra.auto?.heightRule ? { heightRule: extra.auto.heightRule } : {}) };
}

export async function readProfileLibrary(_mock = false): Promise<ProfileLibraryDocument> {
  const response = await fetch('/api/library');
  if (!response.ok) throw await responseError(response);
  return adopted(await response.json() as LibraryAnswer);
}
export async function persistProfileLibrary(write: ProfileLibraryWrite, _mock = false): Promise<ProfileLibraryWriteResult> {
  const { document } = write;
  const v4: V4Document = { schema: 4, revision: document.revision, ...(document.epoch ? { epoch: document.epoch } : {}),
    profiles: await Promise.all(document.profiles.filter((p) => p.id).map(toV4)), setups: document.printers.setups };
  const response = await mutation('/api/library', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operationId: write.operationId, expectedRevision: write.expectedRevision, document: v4 }) });
  if (!response.ok) throw await responseError(response);
  return adopted(await response.json() as LibraryAnswer);
}
