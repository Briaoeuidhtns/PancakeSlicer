import { Popover } from 'radix-ui';
import { useMemo, useRef, useState } from 'react';
import { useAddSettingsRequest } from './add-settings-request';
import type { Config, ConfigValue } from '../api/types';
import objectKeys from '../object_options.json';
import { toolValue } from '../config-values';
import { display } from '../profiles/format';
import { effectiveConfig, getState, removeObjectOptions, removeVolumeOptions, selectionOf, setObjectOption, setState, setVolumeOption, useStore,
  isSelected, type LayerRange, type PlateObject, type State } from '../state/store';
import { undoable } from '../state/history';
import { selectionValues } from '../profiles/view';
import { addRangeAfter, canAddAfter, deleteRange, editRange, rangeLabel, removeRangeOptions, setRangeOption } from '../plater/ranges';
import { Caret } from './Caret';
import { SettingsTab, type ProfileFields } from './SettingsTab';
import './object-overrides.css';

const REGION_KEYS = new Set(objectKeys.region);
const OBJECT_KEYS = new Set([...objectKeys.region, ...objectKeys.object]);
const plain = (name: string) => name.replace(/\.(stl|obj|3mf|drc|step|stp)$/i, '');
const editable = (o: PlateObject) => !o.project;
const instanceKeys = (o: PlateObject) => o.instances.map((i) => `${o.id}:${i.id}`);

export interface ObjectOverrides extends ProfileFields { keys: Set<string>; mixed: Record<string, string>;
  target: { kind: 'objects'; ids: number[] } | { kind: 'part'; object: number; volume: number } | { kind: 'range'; object: number; range: LayerRange } }

const same = (key: string, a: ConfigValue | undefined, b: ConfigValue | undefined) => a === b || (a !== undefined && b !== undefined && toolValue(key, a) === toolValue(key, b));

function overridesOf(s: State, project: Config): ObjectOverrides | null {
  const sel = s.selected, object = sel ? s.objects.find((o) => o.id === sel.object) : undefined;
  const single = (kind: 'part' | 'range', settings: Config, name: string, set: (k: string, v: ConfigValue) => void, remove: (keys: string[]) => void, target: ObjectOverrides['target']): ObjectOverrides => {
    const baseline = { ...project, ...object!.settings };
    return { name, keys: REGION_KEYS, mixed: {}, target, config: { ...baseline, ...settings }, baseline, changes: settings,
      set: (k, v) => undoable(kind === 'part' ? 'Edit part settings' : 'Edit range settings', () => same(k, v, baseline[k]) ? remove([k]) : set(k, v), `${name}:${k}`),
      reset: (k) => undoable('Reset to object', () => remove([k])) };
  };
  if (object && editable(object) && sel?.range !== undefined) {
    const range = object.ranges?.find((r) => r.id === sel.range);
    if (range) return single('range', range.settings, rangeLabel(range), (k, v) => setRangeOption(object.id, range.id, k, v), (keys) => removeRangeOptions(object.id, range.id, keys), { kind: 'range', object: object.id, range });
  }
  if (object && editable(object) && sel?.volume !== undefined) {
    const volume = object.volumes?.find((v) => v.id === sel.volume);
    if (volume && (volume.type === 'part' || volume.type === 'modifier'))
      return single('part', volume.settings ?? {}, volume.name, (k, v) => setVolumeOption(object.id, volume.id, k, v), (keys) => removeVolumeOptions(object.id, volume.id, keys), { kind: 'part', object: object.id, volume: volume.id });
  }
  const objects = s.objects.filter((o) => editable(o) && o.instances.some((i) => isSelected(sel, o.id, i.id)));
  if (!objects.length) return null;
  const ids = objects.map((o) => o.id);
  const config: Config = { ...project }, changes: Config = {}, mixed: Record<string, string> = {};
  const touched = new Set(objects.flatMap((o) => Object.keys(o.settings)));
  for (const k of touched) {
    const values = objects.map((o) => o.settings[k] ?? project[k]);
    config[k] = values[0];
    changes[k] = values[0];
    const distinct = [...new Map(values.filter((v) => v !== undefined).map((v) => [toolValue(k, v), v])).values()];
    if (distinct.length > 1) mixed[k] = distinct.slice(0, 3).map((v) => display(k, v)).join(', ') + (distinct.length > 3 ? ', …' : '');
  }
  return {
    name: objects.length === 1 ? plain(objects[0].name) : `${objects.length} objects`, keys: OBJECT_KEYS, mixed, target: { kind: 'objects', ids },
    config, baseline: project, changes,
    set: (k, v) => undoable('Edit object settings', () => objects.forEach((o) => same(k, v, project[k]) ? removeObjectOptions(o.id, [k]) : setObjectOption(o.id, k, v)), `objects:${ids}:${k}`),
    reset: (k) => undoable('Reset to project', () => objects.forEach((o) => removeObjectOptions(o.id, [k]))),
  };
}

export function useObjectOverrides(): ObjectOverrides | null {
  const objects = useStore((s) => s.objects), selected = useStore((s) => s.selected);
  const project = useStore((s) => effectiveConfig(s, 'process'));
  const answer = { state: useStore((s) => selectionValues(s, 'process').state), error: useStore((s) => selectionValues(s, 'process').error) };
  return useMemo(() => { const o = overridesOf(getState(), project); return o && { ...o, state: answer.state, error: answer.error }; }, [objects, selected, project, answer.state, answer.error]);
}

export function RangeEditor({ objectId, range }: { objectId: number; range: LayerRange }) {
  const object = useStore((s) => s.objects.find((o) => o.id === objectId));
  const field = (label: string, value: number, commit: (v: number) => boolean) => (
    <label className="form-row">
      <span>{label}</span>
      <input key={`${range.id}:${value}`} className="text" type="number" step={0.01} defaultValue={value} aria-label={label}
        onBlur={(e) => { const v = Number(e.target.value); if (v !== value && !(Number.isFinite(v) && commit(v))) e.target.value = String(value); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    </label>
  );
  return (
    <div className="range-editor">
      {field('Min Z (mm)', range.z[0], (v) => editRange(objectId, range.id, { z: [v, range.z[1]] }))}
      {field('Max Z (mm)', range.z[1], (v) => editRange(objectId, range.id, { z: [range.z[0], v] }))}
      {field('Layer height (mm)', range.layer_height, (v) => editRange(objectId, range.id, { layer_height: v }))}
      <span className="range-tools">
        <button type="button" className="btn" disabled={!object || !canAddAfter(object, range.id)} onClick={() => addRangeAfter(objectId, range.id)}>Add range</button>
        <button type="button" className="btn-ghost" onClick={() => deleteRange(objectId, range.id)}>Delete range</button>
      </span>
    </div>
  );
}


export default function ObjectScope() {
  const overrides = useObjectOverrides();
  const top = useRef<HTMLDivElement>(null);
  useAddSettingsRequest(!!overrides, () => top.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  return <>
    <div className="rail-row rail-row-wide" ref={top}><span className="preset-combo"><ObjectPicker overrides={overrides} /></span></div>
    {overrides?.target.kind === 'range' && <RangeEditor objectId={overrides.target.object} range={overrides.target.range} />}
    <div className="process-panel">{overrides ? <SettingsTab type="process" compact hidePreset overrides={overrides} />
      : <div className="settings-load" role="status">Select objects on the plate or in the list</div>}</div>
  </>;
}
