import { useProject } from '../flow/project';
import './projects.css';

export function ProjectStatus() {
  return <><LifecycleStatus /><NoticeLog /></>;
}

function LifecycleStatus() {
  const value = useProject((s) => s.value);
  if (value === 'missing') return (
    <div className="pj-status" role="status"><span>Project not found</span>
      <a className="btn" href={projectsHref()} onClick={(e) => { e.preventDefault(); showProjects(); }}>Projects</a>
    </div>
  );
  if (value === 'opening') return <div className="pj-status" role="status"><span>Opening…</span></div>;
  return null;
}
