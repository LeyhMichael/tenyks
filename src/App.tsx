import { useState, useRef, useEffect } from 'react';
import type { AppConfig } from './types';
import apps from './apps.generated';

const liveApps = apps.filter((a) => a.status === 'live');
const comingApps = apps.filter((a) => a.status === 'coming_soon');

type GroupBy = 'none' | 'tag' | 'author';

const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: 'none',   label: 'No grouping' },
  { value: 'tag',    label: 'Tag' },
  { value: 'author', label: 'Author' },
];

function groupApps(list: AppConfig[], by: 'tag' | 'author'): [string, AppConfig[]][] {
  const map = new Map<string, AppConfig[]>();
  for (const app of list) {
    const key = by === 'tag' ? (app.tag ?? 'Other') : app.author;
    (map.get(key) ?? (map.set(key, []), map.get(key)!)).push(app);
  }
  return Array.from(map.entries());
}

function tileVars(app: AppConfig): React.CSSProperties {
  return {
    '--accent': app.accent,
    '--accent-border': `${app.accent}55`,
    '--accent-color': app.accent,
    '--icon-bg': `${app.accent}18`,
    '--badge-bg': `${app.accent}18`,
    '--badge-color': app.accent,
  } as React.CSSProperties;
}

function AppTile({ app }: { app: AppConfig }) {
  return (
    <a className="app-tile" href={app.url} style={tileVars(app)}>
      <div className="tile-header">
        <div className="tile-icon">{app.icon}</div>
        {app.tag && <span className="tile-badge">{app.tag}</span>}
      </div>
      <div>
        <div className="tile-name">{app.name}</div>
        <div className="tile-desc">{app.description}</div>
      </div>
      <div className="tile-footer">
        <span className="tile-author">by {app.author}</span>
        <span className="tile-arrow">→</span>
      </div>
    </a>
  );
}

function GroupByMenu({ value, onChange }: { value: GroupBy; onChange: (v: GroupBy) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  const active = GROUP_OPTIONS.find((o) => o.value === value)!;

  return (
    <div className="group-by-menu" ref={ref}>
      <button
        className={`group-by-btn${value !== 'none' ? ' active' : ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="group-by-prefix">Group by</span>
        {value !== 'none' && <span className="group-by-current">{active.label}</span>}
        <svg className="group-by-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d={open ? 'M2 7l3-4 3 4' : 'M2 3l3 4 3-4'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {open && (
        <div className="group-by-dropdown">
          {GROUP_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={`group-by-option${opt.value === value ? ' selected' : ''}`}
              onClick={() => { onChange(opt.value); setOpen(false); }}
            >
              {opt.label}
              {opt.value === value && (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const groups = groupBy !== 'none' ? groupApps(liveApps, groupBy) : null;

  return (
    <>
      <header>
        <div className="header-left">
          <div className="header-brand">
            <span className="bcg-badge">BCG TDA</span>
            <span className="header-title">Vantage Platform</span>
          </div>
          <div className="header-subtitle">Internal tools built by the team, for the team</div>
        </div>
        <div className="header-right">
          <a
            className="add-app-btn"
            href="https://github.com/bcgx-pi-60017564-1-2/tenyks"
            target="_blank"
            rel="noreferrer"
          >
            + Add your app
          </a>
        </div>
      </header>

      <div className="grid-container">
        <div className="section-header">
          <span className="section-label">All apps</span>
          <span className="section-fill" />
          <GroupByMenu value={groupBy} onChange={setGroupBy} />
        </div>

        {groups ? (
          groups.map(([key, groupApps]) => (
            <div key={key} className="swimlane">
              <div className="swimlane-label">{key}</div>
              <div className="grid">
                {groupApps.map((app) => <AppTile key={app.folder} app={app} />)}
              </div>
            </div>
          ))
        ) : (
          <div className="grid">
            {liveApps.map((app) => <AppTile key={app.folder} app={app} />)}
          </div>
        )}

        {comingApps.length > 0 && (
          <>
            <div className="section-title">Coming soon</div>
            <div className="grid">
              {comingApps.map((app) => (
                <div key={app.folder} className="app-tile tile-coming-soon" style={tileVars(app)}>
                  <div className="tile-header">
                    <div className="tile-icon">{app.icon}</div>
                    <span className="tile-badge">Soon</span>
                  </div>
                  <div>
                    <div className="tile-name">{app.name}</div>
                    <div className="tile-desc">{app.description}</div>
                  </div>
                  <div className="tile-footer">
                    <span className="tile-author">by {app.author}</span>
                    <span className="tile-arrow">→</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <footer>
        <span className="left">TDA Vantage Platform · BCG Boston</span>
        <span className="right">Built with Claude · {liveApps.length} app{liveApps.length !== 1 ? 's' : ''}</span>
      </footer>
    </>
  );
}
