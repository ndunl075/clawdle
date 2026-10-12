import { createRoot } from 'react-dom/client';
import type { AppController } from '@clawdle/app-core';
import { ClawdleApp, type IntegrationActions } from './ClawdleApp';
import './styles.css';
import clawdleLogo from './assets/clawdle.png';

export async function mountClawdle(create: () => Promise<AppController>, integration?: IntegrationActions) {
  const element = document.getElementById('root');
  if (!element) throw new Error('Missing application root');
  const root = createRoot(element);
  root.render(<main className="boot"><img className="brand-mark" src={clawdleLogo} alt="Clawdle" width="36" height="36"/><p>Opening your word break…</p></main>);
  try {
    const controller = await create();
    root.render(<ClawdleApp controller={controller} integration={integration} />);
    return controller;
  } catch (error) {
    root.render(<main className="boot"><h1>Clawdle couldn’t open your save</h1><p>{error instanceof Error ? error.message : 'Storage is unavailable.'}</p><p>Your data has not been reset. Check available disk space and reload to try again.</p><button onClick={() => location.reload()}>Try again</button></main>);
    return null;
  }
}
