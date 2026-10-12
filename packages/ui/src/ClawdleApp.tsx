import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { create } from 'zustand';
import type { AppController } from '@clawdle/app-core';
import { dailyPuzzleNumber, mergeKeyboardStates, type Mode } from '@clawdle/game';

type Dialog = 'help' | 'stats' | 'settings' | 'connect' | 'share' | 'saved' | null;
const usePresentation = create<{draft:string;dialog:Dialog;setDraft:(draft:string)=>void;setDialog:(dialog:Dialog)=>void}>(set => ({draft:'',dialog:null,setDraft:draft=>set({draft}),setDialog:dialog=>set({dialog})}));
export interface IntegrationActions {
  isVisible: () => Promise<boolean>;
  doctor: () => Promise<unknown>;
  install: (scope:'user'|'project', project?:string) => Promise<unknown>;
  uninstall: (scope:'user'|'project', project?:string) => Promise<unknown>;
}
const modeLabels:Record<Mode,string> = {daily:'Daily',endless:'Endless',race:'Beat Claude',speedrun:'Speedrun'};
const rows = ['QWERTYUIOP','ASDFGHJKL','ZXCVBNM'];
const timeLabel = (ms:number|null|undefined) => ms == null ? '—' : `${Math.floor(ms/60000)}:${Math.floor(ms/1000%60).toString().padStart(2,'0')}`;

export function ClawdleApp({controller,integration}:{controller:AppController;integration?:IntegrationActions}) {
  const [,rerender] = useState(0);
  const [mode,setMode] = useState<Mode>('daily');
  const [busy,setBusy] = useState(false);
  const [notice,setNotice] = useState('');
  const [shareText,setShareText] = useState('');
  const [now,setNow] = useState(controller.clock().monoMs);
  const [scope,setScope] = useState<'user'|'project'>('user');
  const [project,setProject] = useState('');
  const [integrationReport,setIntegrationReport] = useState('');
  const [pendingSettings,setPendingSettings] = useState<Partial<typeof controller.state.settings>>({});
  const [visibilityRevision,setVisibilityRevision] = useState(0);
  const {draft,dialog,setDraft,setDialog} = usePresentation();
  const surface = useRef<HTMLElement>(null);
  const submission = useRef(false);
  const state = controller.state;
  const game = state.activeGameId ? state.games[state.activeGameId] : undefined;
  const race = state.activeRaceId ? state.races[state.activeRaceId] : undefined;
  const agent = race ? state.agentStatuses[JSON.stringify([race.provider,race.sessionId])] : undefined;
  const run = state.activeSpeedrunId ? state.speedruns[state.activeSpeedrunId] : undefined;
  const settings = state.settings;
  const stats = controller.stats(mode);
  const keyboard = mergeKeyboardStates(game?.guesses ?? []);
  const currentMode = game?.mode ?? mode;

  useEffect(() => controller.subscribe(() => rerender(n=>n+1)),[controller]);
  useEffect(() => {
    if (!controller.state.activeGameId) void controller.dispatch({type:'startDaily'}).catch(e=>setNotice(String(e)));
  },[controller]);
  useEffect(() => { setDraft(''); if (game) setMode(game.mode); },[game?.gameId,setDraft]);
  useEffect(() => {
    if (race?.state === 'offered' && settings.autoRace && game?.gameId === race.gameId) {
      let cancelled=false;
      void (async()=>{const visible=integration?await integration.isVisible():document.visibilityState==='visible';if(!cancelled&&visible)await controller.dispatch({type:'presentRace',raceId:race.raceId,lateJoin:false});})().catch(e=>setNotice(String(e)));
      return ()=>{cancelled=true;};
    }
  },[controller,integration,race?.raceId,race?.state,settings.autoRace,game?.gameId,visibilityRevision]);
  useEffect(() => {
    if (!race && !run) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') { setNow(controller.clock().monoMs); if (run?.status === 'running') void controller.dispatch({type:'tick'}).catch(e=>setNotice(String(e))); }
    },250);
    return ()=>window.clearInterval(timer);
  },[controller,race?.raceId,run?.speedrunId,run?.status]);
  useEffect(() => {
    const refresh = () => { setVisibilityRevision(n=>n+1);if(document.visibilityState === 'visible') void controller.refresh().catch(e=>setNotice(String(e))); };
    document.addEventListener('visibilitychange',refresh);
    window.addEventListener('clawdle-window-presented',refresh);
    return ()=>{document.removeEventListener('visibilitychange',refresh);window.removeEventListener('clawdle-window-presented',refresh);};
  },[controller]);

  async function dispatch(command:Parameters<AppController['dispatch']>[0]) {
    if (submission.current) return;
    submission.current = true; setBusy(true); setNotice('');
    try { await controller.dispatch(command); }
    catch(e) { setNotice(e instanceof Error ? e.message : 'Your move could not be saved. Please try again.'); }
    finally { submission.current=false;setBusy(false); }
  }
  async function input(key:string) {
    if (dialog || busy || !game || game.status !== 'playing' || (game.mode==='speedrun'&&run?.status!=='running')) return;
    if(key==='ENTER') {
      if(draft.length !== 5) {setNotice('Enter a five-letter word.');return;}
      const previous = game.guesses.length;
      await dispatch({type:'submitGuess',word:draft});
      if(controller.state.games[game.gameId]?.guesses.length > previous) setDraft('');
    } else if(key==='BACKSPACE') setDraft(draft.slice(0,-1));
    else if(/^[A-Z]$/.test(key) && draft.length<5) {setDraft(draft+key);setNotice('');}
  }
  function keydown(event:KeyboardEvent<HTMLElement>) {
    if(event.nativeEvent.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return;
    const key=event.key.toUpperCase();
    if(/^[A-Z]$/.test(key)||key==='ENTER'||key==='BACKSPACE') {event.preventDefault();void input(key);}
  }
  async function chooseMode(next:Mode) {
    setDraft('');setNotice('');setMode(next);
    if(next==='daily') await dispatch({type:'startDaily'});
    if(next==='endless') await dispatch({type:'startEndless'});
    if(next==='speedrun') await dispatch({type:'startSpeedrun'});
  }
  async function changeSetting(key:keyof typeof settings,value:boolean) {
    setPendingSettings(previous=>({...previous,[key]:value}));
    await dispatch({type:'changeSettings',settings:{[key]:value}});
    setPendingSettings(previous=>{const next={...previous};delete next[key];return next;});
  }
  async function share() {
    const text=controller.share();setShareText(text);setDialog('share');
    try {await navigator.clipboard.writeText(text);setNotice('Copied your result.');} catch {setNotice('Select the share text to copy it.');}
  }
  function exportData() {
    const url=URL.createObjectURL(new Blob([controller.exportData()],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download=`clawdle-${new Date().toISOString().slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function integrationAction(action:()=>Promise<unknown>) {
    setBusy(true);try {const result=await action();setIntegrationReport(typeof result==='string'?result:JSON.stringify(result,null,2));}catch(e){setIntegrationReport(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  const anchor = game ? state.gameAnchors[game.gameId] : undefined;
  const elapsed = race?.elapsedMs ?? (anchor ? Math.max(0,now-anchor.monoMs) : 0);
  const terminal = game && game.status!=='playing';
  const runEnded = currentMode==='speedrun' && run && run.status!=='running';
  const outcomeLabel = race?.outcome === 'player_win' ? 'You beat Claude.' : race?.outcome === 'agent_first' ? 'Claude finished first.' : race?.outcome === 'guesses_exhausted' ? 'Out of guesses.' : race?.outcome ? 'Race ended without a ranked result.' : '';
  const feedback = state.feedback ? ({not_in_dictionary:'Not in the word list. Try another word.',invalid_format:'Enter five letters from A to Z.',puzzle_finished:'This puzzle is complete.',duplicate_submission:'Your guess is already saved.'} as Record<string,string>)[state.feedback]??state.feedback : '';

  return <main ref={surface} className={`app ${settings.highContrast?'high-contrast':''} ${settings.reducedMotion?'reduce-motion':''}`} tabIndex={0} onKeyDown={keydown} aria-label="Clawdle word game">
    <header className="header"><a className="wordmark" href="#" onClick={e=>e.preventDefault()} aria-label="Clawdle home"><span className="brand-mark" aria-hidden="true">c</span>clawdle<span className="wordmark-dot">.</span></a><div className="header-actions"><button className="icon-button" onClick={()=>setDialog('help')} aria-label="How to play">?</button><button className="icon-button bars-icon" onClick={()=>setDialog('stats')} aria-label="Statistics"><span/><span/><span/></button><button className="icon-button" onClick={()=>setDialog('settings')} aria-label="Settings">⚙</button></div></header>
    <nav className="mode-nav" aria-label="Game mode">{(['daily','endless','race',...(settings.speedrunEnabled?['speedrun']:[])] as Mode[]).map(item=><button key={item} aria-current={mode===item?'page':undefined} className={mode===item?'selected':''} onClick={()=>void chooseMode(item)} disabled={busy}>{modeLabels[item]}</button>)}</nav>
    <section className="game-heading"><div><p className="eyebrow">{mode==='daily'?`NO. ${dailyPuzzleNumber(game?.dailyKey?Date.parse(game.dailyKey):Date.now())} · ${new Date().toLocaleDateString(undefined,{month:'short',day:'numeric',timeZone:'UTC'})} UTC`:mode==='endless'?'A FRESH LITTLE CHALLENGE':mode==='speedrun'?'SIXTY SECONDS. KEEP GOING.':'YOUR NEXT WORD BREAK'}</p><h1>{mode==='daily'?'One word. A new day.':mode==='endless'?'Just one more word.':mode==='speedrun'?'Make every second count.':'Can you beat Claude?'}</h1></div>{mode==='race'&&<span className="agent-indicator"><i/> {agent?.status==='attention'?'Needs attention':agent?.status==='working'?'Working':agent?.status==='completed'?'Finished':agent?.status==='disconnected'?'Disconnected':integration?'Waiting':'Not connected'}</span>}</section>
    {mode==='race'&&!race?<section className="connection-empty"><div className="mini-grid" aria-hidden="true">{['C','L','A','W','D'].map((letter,i)=><span className={i===0?'correct':i===3?'present':''} key={letter}>{letter}</span>)}</div><h2>A word while Claude works.</h2><p>Solve a five-letter puzzle before your coding agent finishes its turn. Everything stays on your computer.</p><button className="primary" onClick={()=>setDialog('connect')}>Connect Claude</button><button className="text-button" onClick={()=>void chooseMode('endless')}>Practice with Endless →</button></section>:<>
      {(currentMode==='race'||currentMode==='speedrun')&&<div className="timer" aria-label={currentMode==='speedrun'?'Time remaining':'Elapsed race time'}>{currentMode==='speedrun'?timeLabel(run?.status==='running'?Math.max(0,run.deadlineMonoMs-now):0):timeLabel(elapsed)}{currentMode==='speedrun'&&<span>{run?.solved??0} solved</span>}{race&&!race.ranked&&<span>Unranked</span>}</div>}
      <section className="grid" aria-label="Puzzle, six guesses of five letters" aria-busy={busy}>{Array.from({length:6},(_,row)=>{const guess=game?.guesses[row];return <div className="grid-row" key={row} role="group" aria-label={`Guess ${row+1}`}>{Array.from({length:5},(_,col)=>{const letter=guess?.word[col]??(row===(game?.guesses.length??0)&&!terminal?draft[col]:'')??'';const tile=guess?.tiles[col];return <div key={col} className={`tile ${tile??''} ${letter&&!tile?'filled':''}`} aria-label={letter?`${letter}${tile?`, ${tile}`:', draft'}`:'Empty'}><span>{letter}</span>{tile&&<span className="tile-pattern" aria-hidden="true">{tile==='correct'?'●':tile==='present'?'◐':'×'}</span>}</div>;})}</div>;})}</section>
      <div className="feedback" role="status" aria-live="polite">{notice||controller.error||feedback||(outcomeLabel?outcomeLabel:terminal?(game.status==='solved'?'A lovely little solve.':'A fresh word is always waiting.'):'')}</div>
      {runEnded?<section className="result-panel"><h2>{run.status==='finished'?`${run.solved} ${run.solved===1?'word':'words'} solved.`:'Your run was interrupted.'}</h2><p>{run.status==='finished'?'Sixty seconds, well spent.':'Your guesses are saved. This run has no competitive score.'}</p><button className="primary" onClick={()=>void chooseMode('speedrun')}>Start another run →</button></section>:terminal?<section className="result-panel"><p>{game.status==='solved'?`Solved in ${game.guesses.length} ${game.guesses.length===1?'guess':'guesses'}.`:< >The word was <strong>{controller.answer()}</strong>.</>}</p><div className="result-actions"><button className="primary" onClick={()=>void share()}>Share result ↗</button>{currentMode!=='daily'&&<button onClick={()=>void chooseMode(currentMode==='race'?'endless':currentMode)}>Next word →</button>}</div>{currentMode==='daily'&&<button className="text-button" onClick={()=>void chooseMode('endless')}>Keep playing in Endless →</button>}</section>:<section className="keyboard" aria-label="On-screen keyboard">{rows.map((letters,index)=><div className="keyboard-row" key={letters}>{index===2&&<button className="key wide" aria-label="Submit guess" onClick={()=>void input('ENTER')} disabled={busy}>ENTER</button>}{[...letters].map(letter=><button className={`key ${keyboard[letter]??''}`} key={letter} aria-label={`${letter}${keyboard[letter]?`, ${keyboard[letter]}`:''}`} onClick={()=>void input(letter)} disabled={busy}>{letter}</button>)}{index===2&&<button className="key wide" aria-label="Delete letter" onClick={()=>void input('BACKSPACE')} disabled={busy}>⌫</button>}</div>)}</section>}
      {race?.outcome==='agent_first'&&!terminal&&<p className="continuation-note">Keep solving at your own pace. Your race result is saved.</p>}
      {game?.status==='playing'&&currentMode==='speedrun'&&!runEnded&&<button className="text-button skip" onClick={()=>void dispatch({type:'skipWord'})}>Skip this word →</button>}
      {race?.state==='running'&&currentMode==='race'&&<button className="text-button skip" onClick={()=>void dispatch({type:'leaveRace'})}>Leave race · keep puzzle</button>}
      {game?.status==='playing'&&currentMode==='endless'&&<button className="text-button skip" onClick={()=>{if(window.confirm('Reveal the answer and record a practice loss?'))void dispatch({type:'giveUp'});}}>Give up & reveal</button>}
    </>}
    {mode==='race'&&Object.values(state.races).filter(item=>item.state==='offered'&&item.raceId!==state.activeRaceId).map(offer=><button className="offer" key={offer.raceId} onClick={()=>void dispatch({type:'presentRace',raceId:offer.raceId,lateJoin:true})}>Another turn is working · Join unranked →</button>)}
    <footer className="footer"><span className="footer-flower" aria-hidden="true">✳</span><p>Five letters. Six guesses. A little room to think.</p><span className="local-note"><i/> Free. Local. Yours.</span></footer>
    {dialog&&<Modal title={dialog==='help'?'A little word break.':dialog==='stats'?'Your word habit.':dialog==='settings'?'Make yourself at home.':dialog==='share'?'A solve worth sharing.':dialog==='saved'?'Pick up where you left off.':'Connect Claude.'} onClose={()=>{setDialog(null);surface.current?.focus();}}>
      {dialog==='help'&&<><p>Find the five-letter word in six guesses. Every guess must be a word in the bundled dictionary.</p><div className="example">{['W','O','R','D','S'].map((letter,i)=><span className={`tile ${i===0?'correct':i===2?'present':'absent'}`} key={i}>{letter}</span>)}</div><dl className="rules"><dt><i className="correct"/> Correct</dt><dd>Right letter, right place.</dd><dt><i className="present"/> Present</dt><dd>Right letter, another place.</dd><dt><i className="absent"/> Absent</dt><dd>No unmatched copy in the answer.</dd></dl><p>Daily changes at midnight UTC. Endless is always ready. Beat Claude races a separate puzzle against an observed coding-agent turn.</p><p className="muted">Closing Clawdle saves your accepted guesses. A race never changes your daily streak.</p></>}
      {dialog==='stats'&&<><p className="eyebrow">{modeLabels[mode]} STATISTICS</p><div className="stats-summary">{[[stats.played,'Played'],[Math.round(stats.winPercentage),'Win %'],[stats.currentStreak,'Streak'],[stats.longestStreak,'Best streak']].map(([value,label])=><div key={label}><strong>{value}</strong><span>{label}</span></div>)}</div><h3>Guess distribution</h3><div className="distribution">{stats.distribution.map((count,index)=><div key={index}><span>{index+1}</span><b style={{width:`${Math.max(6,100*count/Math.max(1,...stats.distribution))}%`}}>{count}</b></div>)}</div><p className="muted">{stats.losses} losses · {stats.neutral} neutral results</p><p>Fastest eligible solve <strong>{timeLabel(stats.fastestMs)}</strong></p><p>Average eligible solve <strong>{timeLabel(stats.averageMs)}</strong></p></>}
      {dialog==='settings'&&<><div className="settings-list">{([{key:'highContrast',label:'High contrast',description:'Add symbols to colored tiles.'},{key:'reducedMotion',label:'Reduced motion',description:'Keep tile feedback still.'},{key:'speedrunEnabled',label:'Show Speedrun',description:'A sixty-second word sprint.'},...(integration?[{key:'autoRace',label:'Automatic races',description:'Offer correlated turns while Claude works.'},{key:'alwaysOnTop',label:'Always on top',description:'Keep the desktop game visible.'}]:[])] as const).map(item=><label className="setting" key={item.key}><span><strong>{item.label}</strong><small>{item.description}</small></span><input type="checkbox" disabled={busy} checked={pendingSettings[item.key as keyof typeof settings]??settings[item.key as keyof typeof settings]} onChange={e=>void changeSetting(item.key as keyof typeof settings,e.target.checked)}/></label>)}</div><button className="full-width" onClick={()=>setDialog('saved')}>Resume a saved puzzle →</button><button className="full-width" onClick={exportData}>Export my games & statistics ↓</button><p className="muted">Saves stay on this device. Browser storage can be cleared by your browser; export to keep a copy. Exports exclude connection secrets and raw agent identities.</p><button className="text-button danger" onClick={()=>{if(window.confirm('Reset statistics? Active puzzles and your official daily game stay saved.'))void dispatch({type:'resetStatistics',confirmed:true});}}>Reset statistics</button>{integration&&<button className="text-button" onClick={()=>setDialog('connect')}>Claude connection settings →</button>}</>}
      {dialog==='saved'&&<><p className="muted">Continue an unfinished puzzle. Older daily games keep their original UTC date.</p>{Object.values(state.games).filter(saved=>saved.status==='playing'&&saved.mode!=='speedrun').map(saved=><button className="full-width" key={saved.gameId} onClick={async()=>{await dispatch({type:'resumeGame',gameId:saved.gameId});setDialog(null);surface.current?.focus();}}>{modeLabels[saved.mode]} · {saved.dailyKey??new Date(saved.startedAtUtc).toLocaleDateString()} · {saved.guesses.length}/6 guesses →</button>)}{!Object.values(state.games).some(saved=>saved.status==='playing'&&saved.mode!=='speedrun')&&<p>No unfinished puzzles. A fresh word is waiting.</p>}</>}
      {dialog==='share'&&<><p>{notice||'Copy the grid below. Your answer and agent details stay private.'}</p><textarea className="share-text" readOnly value={shareText} aria-label="Share result" onFocus={e=>e.target.select()}/><button className="primary full-width" onClick={()=>void navigator.clipboard.writeText(shareText).then(()=>setNotice('Copied your result.')).catch(()=>setNotice('Select the text above and copy manually.'))}>Copy result</button></>}
      {dialog==='connect'&&<><p>Clawdle observes local Claude Code lifecycle hooks. It never reads prompts, responses, code, or transcripts, and never approves permissions.</p>{integration?<><label className="field">Hook scope<select value={scope} onChange={e=>setScope(e.target.value as 'user'|'project')}><option value="user">Global user settings</option><option value="project">Selected project only</option></select></label>{scope==='project'&&<label className="field">Absolute project path<input value={project} onChange={e=>setProject(e.target.value)} placeholder="C:\Projects\my-project"/></label>}<button disabled={busy||(scope==='project'&&!project)} className="primary full-width" onClick={()=>void integrationAction(()=>integration.install(scope,scope==='project'?project:undefined))}>Install local Claude hooks</button><div className="result-actions"><button disabled={busy} onClick={()=>void integrationAction(integration.doctor)}>Check connection</button><button disabled={busy} onClick={()=>void integrationAction(()=>integration.uninstall(scope,scope==='project'?project:undefined))}>Remove owned hooks</button></div>{integrationReport&&<pre className="diagnostics" aria-label="Connection result">{integrationReport}</pre>}<p className="muted">Windows-native Claude Code is the initial target. Without trustworthy prompt identity, status is available but ranked races are disabled. Restart or refresh your Claude session after installing hooks.</p></>:<><p>Agent races are available in the Windows desktop app. This browser version plays Daily, Endless, and Speedrun locally.</p><a className="button primary full-width" href="https://github.com/ndunl075/clawdle/releases" target="_blank" rel="noreferrer">Get the Windows app ↗</a></>}</>}
    </Modal>}
  </main>;
}

function Modal({title,onClose,children}:{title:string;onClose:()=>void;children:ReactNode}) {
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const element=ref.current;element?.showModal();return()=>element?.close();},[]);
  return <dialog ref={ref} className="dialog" onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===e.currentTarget)onClose();}}><div className="dialog-heading"><h2>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}>×</button></div>{children}</dialog>;
}
