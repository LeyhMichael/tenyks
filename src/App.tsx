import { useState, useEffect, useRef } from 'react';
import type { AppConfig } from './types';
import apps from './apps.generated';

// ── Auth / team state ──────────────────────────────────────────────────────────
// /api/me is served by server.js and reads Azure EasyAuth headers server-side.
// On localhost (no EasyAuth) the server returns isTeamMember:true when TEAM_EMAILS
// is not set, so local dev always sees full access.

type AuthState = 'loading' | 'team' | 'bcg' | 'none';

function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>('loading');
  useEffect(() => {
    fetch('/api/me', { credentials: 'include' })
      .then((r) => r.json())
      .then((data: { email: string | null; isTeamMember: boolean }) => {
        if (data.isTeamMember) setState('team');
        else if (data.email)   setState('bcg');   // BCG employee, not on team
        else                   setState('none');   // Not signed in at all
      })
      .catch(() => setState('none'));
  }, []);
  return state;
}

// ── Group-by ───────────────────────────────────────────────────────────────────

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

// ── Tile helpers ───────────────────────────────────────────────────────────────

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

function AppTile({ app, index = 0 }: { app: AppConfig; index?: number }) {
  return (
    <a className="app-tile" href={app.url} style={{ ...tileVars(app), '--tile-i': index } as React.CSSProperties}>
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

// ── Main app ───────────────────────────────────────────────────────────────────

export default function App() {
  const auth = useAuth();
  const [groupBy, setGroupBy] = useState<GroupBy>('none');

  const liveApps   = apps.filter((a) => a.status === 'live');
  const comingApps = apps.filter((a) => a.status === 'coming_soon');

  const publicApps = liveApps.filter((a) => a.visibility === 'public');
  const teamApps   = liveApps.filter((a) => a.visibility === 'team');

  const publicGroups = groupBy !== 'none' ? groupApps(publicApps, groupBy) : null;

  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);

  const [showBackButton, setShowBackButton] = useState(
    () => localStorage.getItem('showBackButton') === 'true'
  );
  const toggleShowBackButton = () => {
    setShowBackButton((v) => {
      localStorage.setItem('showBackButton', String(!v));
      return !v;
    });
  };

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const handleLogin = () => {
    window.location.href =
      '/.auth/login/aad?post_login_redirect_uri=' + encodeURIComponent(window.location.pathname);
  };

  return (
    <>
      <div className="mesh-bg" aria-hidden="true" />
      <div className="corner-ornament" aria-hidden="true">
        <svg width="38" height="38" viewBox="0 0 38 38" fill="none" xmlns="http://www.w3.org/2000/svg">
          <line x1="9" y1="9" x2="38" y2="9" stroke="currentColor" strokeWidth="0.75"/>
          <line x1="9" y1="9" x2="9" y2="38" stroke="currentColor" strokeWidth="0.75"/>
          <line x1="5.5" y1="9" x2="12.5" y2="9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
          <line x1="9" y1="5.5" x2="9" y2="12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
          <line x1="6.3" y1="6.3" x2="11.7" y2="11.7" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
          <line x1="11.7" y1="6.3" x2="6.3" y2="11.7" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
        </svg>
      </div>
      <header>
        <div className="header-left">
          <div className="header-brand">
            <span className="bcg-badge">BCG TDA</span>
            <span className="header-title">Vantage Platform</span>
          </div>
          <div className="header-subtitle">AI tools built by the team — explore, share, use</div>
        </div>
        <div className="header-right">
          <div className="settings-dropdown" ref={settingsRef}>
            <button
              className="settings-btn"
              onClick={() => setSettingsOpen((o) => !o)}
              aria-label="Settings"
              aria-expanded={settingsOpen}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>
            {settingsOpen && (
              <div className="settings-menu">
                <label className="settings-item">
                  <div className="settings-item-top">
                    <input
                      type="checkbox"
                      checked={showBackButton}
                      onChange={toggleShowBackButton}
                    />
                    <span className="settings-item-label">Show back button on app pages</span>
                  </div>
                  <p className="settings-item-caption">
                    Show a back button when navigating from the platform page to app pages. Does not show when opening a URL starting on an app page. Can be hidden once-off as well.
                  </p>
                </label>
              </div>
            )}
          </div>
          {auth === 'team' && (
            <a
              className="add-app-btn"
              href="https://github.com/bcgx-pi-60017564-1-2/tenyks"
              target="_blank"
              rel="noreferrer"
            >
              + Add your app
            </a>
          )}
          {auth === 'none' && (
            <button className="add-app-btn" onClick={handleLogin}>
              BCG sign-in →
            </button>
          )}
        </div>
      </header>

      <div className="grid-container">

        {/* ── Public showcase — all BCG employees ── */}
        <div className="section-header">
          <span className="section-label">Our tools</span>
          <span className="section-fill" />
          <GroupByMenu value={groupBy} onChange={setGroupBy} />
        </div>
        <p className="section-sub">Explore what the TDA Vantage team has built. Available to everyone at BCG.</p>

        {publicGroups ? (
          publicGroups.map(([key, groupedApps]) => (
            <div key={key} className="swimlane">
              <div className="swimlane-label">{key}</div>
              <div className="grid">
                {groupedApps.map((app, i) => <AppTile key={app.folder} app={app} index={i} />)}
              </div>
            </div>
          ))
        ) : (
          <div className="grid">
            {publicApps.map((app, i) => <AppTile key={app.folder} app={app} index={i} />)}
          </div>
        )}

        {/* ── Team-only tools — only visible to team members ── */}
        {teamApps.length > 0 && auth === 'team' && (
          <>
            <div className="section-title section-team">
              Team tools
            </div>
            <p className="section-sub">Internal tools for the TDA GenAI Vantage team.  Only accessible to team members.</p>
            <div className="grid">
              {teamApps.map((app, i) => (
                <AppTile key={app.folder} app={app} index={i} />
              ))}
            </div>
          </>
        )}

        {/* ── Coming soon ── */}
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
