import type { AppConfig } from './types';
import apps from './apps.generated';

const liveApps = apps.filter((a) => a.status === 'live');
const comingApps = apps.filter((a) => a.status === 'coming_soon');

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

export default function App() {
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
        <div className="section-title">All apps</div>
        <div className="grid">
          {liveApps.map((app) => <AppTile key={app.folder} app={app} />)}
        </div>

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
