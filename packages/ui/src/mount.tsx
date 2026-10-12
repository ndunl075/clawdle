import { createRoot } from 'react-dom/client';
import type { AppController } from '@clawdle/app-core';
import { ClawdleApp, type IntegrationActions } from './ClawdleApp';
import './styles.css';
import clawdleLogo from './assets/clawdle.png';

export async function mountClawdle(create: () => Promise<AppController>, integration?: IntegrationActions, recovery?:()=>Promise<unknown>) {
  const element = document.getElementById('root');
  if (!element) throw new Error('Missing application root');
  const root = createRoot(element);
  root.render(<main className="boot"><img className="brand-mark" src={clawdleLogo} alt="Clawdle" width="36" height="36"/><p>Opening your word break…</p></main>);
  try {
    const controller = await create();
    root.render(<ClawdleApp controller={controller} integration={integration} />);
    return controller;
  } catch (error) {
    const exportRecovery=async()=>{
      if(!recovery||!window.confirm('Export a diagnostic recovery copy? It may include local session identifiers and damaged saved fields. Keep it private. Connection tokens and endpoint files are not included.'))return;
      try {
        const text=JSON.stringify({format:'clawdle-recovery',version:1,exportedAtUtc:new Date().toISOString(),snapshot:await recovery()},null,2);
        if(integration)await integration.exportData(text);
        else {const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='clawdle-recovery.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
      }catch(failure){window.alert(`Recovery export failed: ${failure instanceof Error?failure.message:String(failure)}. Your original storage is preserved.`);}
    };
    root.render(<main className="boot"><h1>Clawdle couldn’t open your save</h1><p>{error instanceof Error ? error.message : 'Storage is unavailable.'}</p><p>Your data has not been reset. Check available disk space and reload to try again.</p><button onClick={() => location.reload()}>Try again</button>{recovery&&<button onClick={()=>void exportRecovery()}>Export private recovery copy</button>}</main>);
    return null;
  }
}
