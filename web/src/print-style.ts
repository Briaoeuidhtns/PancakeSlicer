import type { Config, ConfigValue } from './api/types';
import type { IconId } from './components/icons';
import { OPTIONS } from './options';
import { STYLE_NAMES, styleOf, type StyleId } from './style-names';

export { styleOf, type StyleId };
import { undoable } from './state/history';
import { effectiveConfig, getState, removeObjectOptions, resetOption, resolvePreset, setObjectOption, setOption } from './state/store';

export const isRotary = (machine: Config) => String(machine.nonplanar_kinematics ?? 'none') !== 'none';

const same = (key: string, a: ConfigValue | undefined, b: ConfigValue | undefined) =>
  toolValue(key, a ?? (OPTIONS[key]?.default as ConfigValue) ?? '') === toolValue(key, b ?? (OPTIONS[key]?.default as ConfigValue) ?? '');

export function applyStyle(id: StyleId, objectId?: number) {
  undoable(`Change print style to "${styleById(id).name}"`, () => writeStyle(id, objectId));
}

function writeStyle(id: StyleId, objectId?: number) {
  const s = getState();
  const keys = styleById(id).keys;
  if (objectId === undefined) {
    const system = resolvePreset(s, 'process', s.process).config;
    for (const [k, v] of Object.entries(keys)) {
      if (same(k, v, system[k])) resetOption('process', k);
      else setOption('process', k, v);
    }
    return;
  }
  const global = effectiveConfig(s, 'process');
  const drop = Object.keys(keys).filter((k) => same(k, keys[k], global[k]));
  for (const [k, v] of Object.entries(keys)) if (!drop.includes(k)) setObjectOption(objectId, k, v);
  if (drop.length) removeObjectOptions(objectId, drop);
}

export const processShortName = (name: string) => name.replace(/\s*@.*$/, '');
