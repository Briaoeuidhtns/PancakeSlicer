import { useId, useState } from 'react';

const desktop = typeof window !== 'undefined' && 'orcaDesktop' in window;

function panelURL(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && url.origin !== location.origin) return url;
  } catch { }
}

export function DeviceWebPanel({ printer, name }: { printer: string; name: string }) {
  const key = `orca.device.web-panel:${printer}`, errorId = useId();
  const [url, setURL] = useState(() => {
    try { return panelURL(localStorage.getItem(key) ?? '')?.href ?? ''; } catch { return ''; }
  });
  const [editing, setEditing] = useState(!url);
  const [draft, setDraft] = useState(url), [error, setError] = useState('');
  const save = (next: string) => {
    try {
      if (next) localStorage.setItem(key, next);
      else localStorage.removeItem(key);
    } catch { setError('Couldn\'t save the web panel URL in this browser.'); return; }
    setURL(next); setDraft(next); setError(''); setEditing(!next);
  };
  return <section className="device-panel device-web-panel" aria-label={`Web panel for ${name}`}>
    <header className="device-web-panel-head"><h1>Web panel</h1>
      {url && <div className="device-web-panel-actions">
        {!editing && <button type="button" className="btn" onClick={() => setEditing(true)}>Edit URL</button>}
        <a className="btn" href={url} target={desktop ? undefined : '_blank'} rel="noreferrer">{desktop ? 'Open in browser' : 'Open in new tab'}</a>
      </div>}
    </header>
    {editing && <form className="device-web-panel-form" noValidate onSubmit={(e) => {
      e.preventDefault();
      const next = panelURL(draft.trim());
      if (next) save(next.href);
      else setError('Enter a full HTTP or HTTPS URL on a different origin, without a username or password.');
    }}>
      <label>Web panel URL<input className="text" type="url" placeholder="https://mainsail.example.com" value={draft} autoComplete="off" spellCheck={false}
        aria-invalid={!!error} aria-describedby={error ? errorId : undefined} onChange={(e) => { setDraft(e.target.value); setError(''); }} /></label>
      <div className="device-web-panel-actions">
        <button type="submit" className="btn-primary">Save URL</button>
        {url && <><button type="button" className="btn" onClick={() => { setDraft(url); setError(''); setEditing(false); }}>Cancel</button>
          <button type="button" className="btn-ghost" onClick={() => save('')}>Remove URL</button></>}
      </div>
      {error && <p className="device-error" id={errorId} role="alert">{error}</p>}
    </form>}
    {desktop ? <p className="device-web-panel-note">The desktop app opens web panels in your browser instead of embedding them.</p>
      : <>
        <p className="device-web-panel-note">Use the Mainsail web address, not the Moonraker API URL. The site must allow embedding; HTTPS pages may block HTTP panels.</p>
        {url && <iframe className="device-web-frame" src={url} title={`Web panel for ${name}`} referrerPolicy="no-referrer" sandbox="allow-downloads allow-forms allow-same-origin allow-scripts" />}
      </>}
  </section>;
}
