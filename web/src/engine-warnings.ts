export const bareName = (name: string) => name.replace(/\.(stl|obj|3mf|amf|step|stp|drc|ply|off)$/i, '');

export const bareName = (name: string) => name.replace(/\.(stl|obj|3mf|amf|step|stp|drc|ply|off)$/i, '');

export interface PlainWarning {
  object?: string;
  text?: string | null;
  raw: string;
}

export function plainWarnings(warnings: string[], objectNames: string[]): PlainWarning[] {
  const names = objectNames.map(bareName).filter(Boolean).sort((a, b) => b.length - a.length);
  const seen = new Set<string>();
  const out: PlainWarning[] = [];
  for (const raw of warnings) {
    const w = raw.trim();
    const prefix = /^([^:\n]+?):\s+([\s\S]+)$/.exec(w);
    const named = prefix && names.find((name) => bareName(prefix[1].trim()) === name);
    const object = named ?? names.find((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.\\w+)?\\b`).test(w));
    const body = named ? prefix![2] : w;
    const hit = KNOWN.find(([re]) => re.test(body));
    const text = hit ? (hit[1] ? hit[1](body.match(hit[0])!) : null) : undefined;
    const key = `${object ?? ''}|${text ?? w}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...(object ? { object } : {}), text, raw: named ? body : w });
  }
  return out;
}
