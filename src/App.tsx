import { useState, useEffect } from 'react';
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

// ── Main app ───────────────────────────────────────────────────────────────────

export default function App() {
  const auth = useAuth();

  const liveApps   = apps.filter((a) => a.status === 'live');
  const comingApps = apps.filter((a) => a.status === 'coming_soon');

  const publicApps = liveApps.filter((a) => a.visibility === 'public');
  const teamApps   = liveApps.filter((a) => a.visibility === 'team');

  const handleLogin = () => {
    window.location.href =
      '/.auth/login/aad?post_login_redirect_uri=' + encodeURIComponent(window.location.pathname);
  };

  return (
    <>
      <header>
        <div className="header-left">
          <div className="header-brand">
            <span className="bcg-badge">BCG TDA</span>
            <span className="header-title">Vantage Platform</span>
          </div>
          <div className="header-subtitle">AI tools built by the team — explore, share, use</div>
        </div>
        <div className="header-right">
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
        <div className="section-title">Our tools</div>
        <p className="section-sub">Explore what the TDA Vantage team has built. Available to everyone at BCG.</p>
        <div className="grid">
          {publicApps.map((app) => (
            <AppTile key={app.folder} app={app} />
          ))}
        </div>

        {/* ── Team-only tools — only visible to team members ── */}
        {teamApps.length > 0 && auth === 'team' && (
          <>
            <div className="section-title section-team">
              Team tools
              <span className="section-team-badge">✓ team member</span>
            </div>
            <p className="section-sub">Internal tools for the TDA Vantage team.</p>
            <div className="grid">
              {teamApps.map((app) => (
                <AppTile key={app.folder} app={app} />
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
