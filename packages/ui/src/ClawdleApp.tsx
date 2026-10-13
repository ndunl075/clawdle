import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { create } from 'zustand';
import clawdleLogo from './assets/clawdle.png';
const FLIP_MS=500;const FLIP_STAGGER_MS=300;const FLIPPED_MS=4*FLIP_STAGGER_MS+FLIP_MS;const REVEAL_MS=FLIPPED_MS+1500;
import { observeVisibleClock } from './visibleClock';
import type { AppController } from '@clawdle/app-core';
import { dailyKey, dailyPuzzleNumber, mergeKeyboardStates, type Mode } from '@clawdle/game';

type Dialog = 'help' | 'stats' | 'settings' | 'connect' | 'share' | 'saved' | null;
const usePresentation = create<{draft:string;dialog:Dialog;setDraft:(draft:string)=>void;setDialog:(dialog:Dialog)=>void}>(set => ({draft:'',dialog:null,setDraft:draft=>set({draft}),setDialog:dialog=>set({dialog})}));
export interface IntegrationActions {
  isVisible: () => Promise<boolean>;
  doctor: () => Promise<unknown>;
  install: (scope:'user'|'project', project?:string) => Promise<unknown>;
  uninstall: (scope:'user'|'project', project?:string) => Promise<unknown>;
  configure: (autoLaunch:boolean) => Promise<void>;
  exportData: (text:string) => Promise<string|null>;
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
  const [utcDay,setUtcDay] = useState(dailyKey(Date.now()));
  const [autoLaunch,setAutoLaunch] = useState(false);
  const {draft,dialog,setDraft,setDialog} = usePresentation();
  const surface = useRef<HTMLElement>(null);
  const [revealRow,setRevealRow]=useState<number|null>(null);
  const [holdRow,setHoldRow]=useState<number|null>(null);
  const [shakeRow,setShakeRow]=useState(false);
  const submission = useRef(false);
  const state = controller.state;
  const game = state.activeGameId ? state.games[state.activeGameId] : undefined;
  const race = state.activeRaceId ? state.races[state.activeRaceId] : undefined;
  const latestAgent = useMemo(() => Object.values(state.agentStatuses).reduce<(typeof state.agentStatuses)[string] | undefined>((latest,item) => !latest || item.lastSeq > latest.lastSeq ? item : latest, undefined),[state.agentStatuses]);
  const agent = race ? state.agentStatuses[JSON.stringify([race.provider,race.sessionId])] : latestAgent;
  const run = state.activeSpeedrunId ? state.speedruns[state.activeSpeedrunId] : undefined;
  const settings = state.settings;
  const stats = useMemo(() => controller.stats(mode),[controller,state,mode,utcDay]);
  // Like Wordle, the keyboard learns a row's colours only once that row has finished flipping.
  const keyboard = useMemo(() => mergeKeyboardStates((game?.guesses ?? []).filter((_,row)=>row!==holdRow)),[game?.guesses,holdRow]);
  const offers = useMemo(() => Object.values(state.races).filter(item=>item.state==='offered'&&item.raceId!==state.activeRaceId),[state.races,state.activeRaceId]);
  const currentMode = game?.mode ?? mode;

  useEffect(() => {if(dialog==='connect'&&integration)void integration.doctor().then(report=>{if(report&&typeof report==='object'&&'autoLaunch' in report)setAutoLaunch(report.autoLaunch===true);}).catch(e=>setIntegrationReport(String(e)));},[dialog,integration]);
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
  useEffect(() => observeVisibleClock({
    active: race?.state === 'running' || run?.status === 'running',
    deadline: run?.status === 'running' ? run.deadlineMonoMs : undefined,
    readMono: () => controller.clock().monoMs,
    onTime: setNow,
    onDay: utcMs => setUtcDay(dailyKey(utcMs)),
    onDeadline: () => { void controller.dispatch({type:'tick'}).catch(e=>setNotice(String(e))); },
  }),[controller,race?.raceId,race?.state,run?.speedrunId,run?.status,run?.deadlineMonoMs]);
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
      if(draft.length !== 5) {setNotice('Enter a five-letter word.');shake();return;}
      const previous = game.guesses.length;
      await dispatch({type:'submitGuess',word:draft});
      if(controller.state.games[game.gameId]?.guesses.length > previous) {setDraft('');setRevealRow(previous);setHoldRow(previous);window.setTimeout(()=>setHoldRow(row=>row===previous?null:row),FLIPPED_MS);window.setTimeout(()=>setRevealRow(row=>row===previous?null:row),REVEAL_MS);}
      else shake();
    } else if(key==='BACKSPACE') setDraft(draft.slice(0,-1));
    else if(/^[A-Z]$/.test(key) && draft.length<5) {setDraft(draft+key);setNotice('');}
  }
  function shake() {setShakeRow(false);window.requestAnimationFrame(()=>setShakeRow(true));window.setTimeout(()=>setShakeRow(false),600);}
  function keydown(event:KeyboardEvent<HTMLElement>) {
    if(event.nativeEvent.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return;
    if(event.target instanceof Element && event.target.closest('dialog')) return;
    const key=event.key.toUpperCase();
    const onControl=event.target instanceof Element && event.target!==surface.current && !!event.target.closest('button,a,summary');
    // Enter activates a focused control, unless a guess is being typed: then it always submits.
    if(key==='ENTER' && onControl && !draft) return;
    if(/^[A-Z]$/.test(key)||key==='ENTER'||key==='BACKSPACE') {event.preventDefault();if(onControl)surface.current?.focus();void input(key);}
  }
  async function chooseMode(next:Mode) {
    setDraft('');setNotice('');setMode(next);
    if(next==='race') await dispatch({type:'enterRaceMode'});
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
    try {await copyText(text);setNotice('Copied your result.');} catch {setNotice('Select the share text to copy it.');}
  }
  async function copyText(text:string) {
    if(controller.platform.clipboard)await controller.platform.clipboard(text);else await navigator.clipboard.writeText(text);
  }
  async function exportData() {
    if(integration){try{const path=await integration.exportData(controller.exportData());if(path)setNotice('Your export was saved.');}catch(e){setNotice(String(e));}return;}
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
  const outcomeLabel = race?.outcome === 'player_win' ? 'You beat Claude.' : race?.outcome === 'agent_first' ? (race.unrankedReason === 'not_presented' ? 'That turn was too short to race.' : 'Claude finished first.') : race?.outcome === 'guesses_exhausted' ? 'Out of guesses.' : race?.outcome ? 'Race ended without a ranked result.' : '';
  const feedback = state.feedback ? ({not_in_dictionary:'Not in the word list. Try another word.',invalid_format:'Enter five letters from A to Z.',puzzle_finished:'This puzzle is complete.',duplicate_submission:'Your guess is already saved.'} as Record<string,string>)[state.feedback]??state.feedback : '';

  return <main ref={surface} className={`app ${settings.highContrast?'high-contrast':''} ${settings.reducedMotion?'reduce-motion':''}`} tabIndex={0} onKeyDown={keydown} aria-label="Clawdle word game">
    <header className="header"><a className="wordmark" href="#" onClick={e=>e.preventDefault()} aria-label="Clawdle home"><img className="brand-mark" src={clawdleLogo} alt="" width="36" height="36"/>clawdle<span className="wordmark-dot">.</span></a><div className="header-actions"><button className="icon-button" onClick={()=>setDialog('help')} aria-label="How to play">?</button><button className="icon-button bars-icon" onClick={()=>setDialog('stats')} aria-label="Statistics"><span/><span/><span/></button><button className="icon-button" onClick={()=>setDialog('settings')} aria-label="Settings"><svg className="gear-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M19.14 12.94c.04-.31.06-.62.06-.94s-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.71 8.87a.48.48 0 0 0 .12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/></svg></button></div></header>
    <nav className="mode-nav" aria-label="Game mode">{(['daily','endless','race',...(settings.speedrunEnabled?['speedrun']:[])] as Mode[]).map(item=><button key={item} aria-current={mode===item?'page':undefined} className={mode===item?'selected':''} onClick={()=>void chooseMode(item)} disabled={busy}>{modeLabels[item]}</button>)}</nav>
    <section className="game-heading"><div><p className="eyebrow">{mode==='daily'?`NO. ${dailyPuzzleNumber(game?.dailyKey?Date.parse(game.dailyKey):Date.now())} · ${new Date(game?.dailyKey??utcDay).toLocaleDateString(undefined,{month:'short',day:'numeric',timeZone:'UTC'})} UTC`:mode==='endless'?'A FRESH LITTLE CHALLENGE':mode==='speedrun'?'SIXTY SECONDS. KEEP GOING.':'YOUR NEXT WORD BREAK'}</p><h1>{mode==='daily'?'One word. A new day.':mode==='endless'?'Just one more word.':mode==='speedrun'?'Make every second count.':'Can you beat Claude?'}</h1></div>{mode==='race'&&<span className="agent-indicator"><i/> {agent?.status==='attention'?'Needs attention':agent?.status==='working'?'Working':agent?.status==='completed'?'Finished':agent?.status==='disconnected'?'Disconnected':agent?.status==='interrupted'?'Interrupted':agent?.status==='ready'?'Ready':integration?'Waiting':'Not connected'}</span>}</section>
    {mode==='daily'&&game?.dailyKey&&game.dailyKey!==utcDay&&<button className="offer" onClick={()=>void dispatch({type:'startDaily'})}>Today's puzzle is ready · keep this puzzle saved →</button>}
    {mode==='race'&&!race?<section className="connection-empty"><div className="mini-grid" aria-hidden="true">{['C','L','A','W','D'].map((letter,i)=><span className={i===0?'correct':i===3?'present':''} key={letter}>{letter}</span>)}</div><h2>A word while Claude works.</h2><p>Solve a five-letter puzzle before your coding agent finishes its turn. Everything stays on your computer.</p><button className="primary" onClick={()=>setDialog('connect')}>Connect Claude</button><button className="text-button" onClick={()=>void chooseMode('endless')}>Practice with Endless →</button></section>:<>
      {(currentMode==='race'||currentMode==='speedrun')&&<div className="timer" aria-label={currentMode==='speedrun'?'Time remaining':'Elapsed race time'}>{currentMode==='speedrun'?timeLabel(run?.status==='running'?Math.max(0,run.deadlineMonoMs-now):0):timeLabel(elapsed)}{currentMode==='speedrun'&&<span>{run?.solved??0} solved</span>}{race&&!race.ranked&&<span>Unranked</span>}</div>}
      <section className="grid" aria-label="Puzzle, six guesses of five letters" aria-busy={busy}>{Array.from({length:6},(_,row)=>{const guess=game?.guesses[row];const revealing=row===revealRow;const shaking=shakeRow&&row===(game?.guesses.length??0);const won=revealing&&guess?.tiles.every(t=>t==='correct');return <div className={`grid-row ${shaking?'shake':''}`} key={row} role="group" aria-label={`Guess ${row+1}`}>{Array.from({length:5},(_,col)=>{const letter=guess?.word[col]??(row===(game?.guesses.length??0)&&!terminal?draft[col]:'')??'';const tile=guess?.tiles[col];return <div key={col} className={`tile ${tile??''} ${letter&&!tile?'filled':''} ${revealing?'reveal':''} ${won?'win':''}`} style={revealing?{'--reveal-delay':`${col*FLIP_STAGGER_MS}ms`,'--bounce-delay':`${5*FLIP_STAGGER_MS+FLIP_MS+col*100}ms`} as CSSProperties:undefined} aria-label={letter?`${letter}${tile?`, ${tile}`:', draft'}`:'Empty'}><span>{letter}</span>{tile&&<span className="tile-pattern" aria-hidden="true">{tile==='correct'?'●':tile==='present'?'◐':'×'}</span>}</div>;})}</div>;})}</section>
      <div className="feedback" role="status" aria-live="polite">{notice||controller.error||feedback||(outcomeLabel?outcomeLabel:terminal?(game.status==='solved'?'A lovely little solve.':'A fresh word is always waiting.'):'')}</div>
      {runEnded?<section className="result-panel"><h2>{run.status==='finished'?`${run.solved} ${run.solved===1?'word':'words'} solved.`:'Your run was interrupted.'}</h2><p>{run.status==='finished'?'Sixty seconds, well spent.':'Your guesses are saved. This run has no competitive score.'}</p><button className="primary" onClick={()=>void chooseMode('speedrun')}>Start another run →</button></section>:terminal?<section className="result-panel"><p>{game.status==='solved'?`Solved in ${game.guesses.length} ${game.guesses.length===1?'guess':'guesses'}.`:< >The word was <strong>{controller.answer()}</strong>.</>}</p><div className="result-actions"><button className="primary" onClick={()=>void share()}>Share result ↗</button>{currentMode!=='daily'&&<button onClick={()=>void chooseMode(currentMode==='race'?'endless':currentMode)}>Next word →</button>}</div>{currentMode==='daily'&&<button className="text-button" onClick={()=>void chooseMode('endless')}>Keep playing in Endless →</button>}</section>:<section className="keyboard" aria-label="On-screen keyboard">{rows.map((letters,index)=><div className="keyboard-row" key={letters}>{index===2&&<button className="key wide" aria-label="Submit guess" onClick={()=>void input('ENTER')} disabled={busy}>ENTER</button>}{[...letters].map(letter=><button className={`key ${keyboard[letter]??''}`} key={letter} aria-label={`${letter}${keyboard[letter]?`, ${keyboard[letter]}`:''}`} onClick={()=>void input(letter)} disabled={busy}>{letter}</button>)}{index===2&&<button className="key wide" aria-label="Delete letter" onClick={()=>void input('BACKSPACE')} disabled={busy}>⌫</button>}</div>)}</section>}
      {race?.outcome==='agent_first'&&!terminal&&<p className="continuation-note">Keep solving at your own pace. Your race result is saved.</p>}
      {game?.status==='playing'&&currentMode==='speedrun'&&!runEnded&&<button className="text-button skip" onClick={()=>void dispatch({type:'skipWord'})}>Skip this word →</button>}
      {race?.state==='running'&&currentMode==='race'&&<button className="text-button skip" onClick={()=>void dispatch({type:'leaveRace'})}>Leave race · keep puzzle</button>}
      {game?.status==='playing'&&currentMode==='endless'&&<button className="text-button skip" onClick={()=>{if(window.confirm('Reveal the answer and record a practice loss?'))void dispatch({type:'giveUp'});}}>Give up & reveal</button>}
    </>}
    {offers.map(offer=><button className="offer" key={offer.raceId} onClick={()=>void dispatch({type:'presentRace',raceId:offer.raceId,lateJoin:true})}>Claude is working · Join an unranked puzzle →</button>)}
    <div className="sr-only" aria-live="polite" aria-atomic="true">{game?.guesses.length?`Guess ${game.guesses.length}: ${[...game.guesses.at(-1)!.word].map((letter,i)=>`${letter} ${game.guesses.at(-1)!.tiles[i]}`).join(", ")}.`:""}</div>
    <footer className="footer"><span className="footer-flower" aria-hidden="true">✳</span><p>Five letters. Six guesses. A little room to think.</p><span className="local-note"><i/> Free. Local. Yours.</span></footer>
    {dialog&&<Modal title={dialog==='help'?'A little word break.':dialog==='stats'?'Your word habit.':dialog==='settings'?'Make yourself at home.':dialog==='share'?'A solve worth sharing.':dialog==='saved'?'Pick up where you left off.':'Connect Claude.'} returnFocus={surface} onClose={()=>{setDialog(null);}}>
      {dialog==='help'&&<><p>Find the five-letter word in six guesses. Every guess must be a word in the bundled dictionary.</p><div className="example">{['W','O','R','D','S'].map((letter,i)=><span className={`tile ${i===0?'correct':i===2?'present':'absent'}`} key={i}>{letter}</span>)}</div><dl className="rules"><dt><i className="correct"/> Correct</dt><dd>Right letter, right place.</dd><dt><i className="present"/> Present</dt><dd>Right letter, another place.</dd><dt><i className="absent"/> Absent</dt><dd>No unmatched copy in the answer.</dd></dl><p>Daily changes at midnight UTC. Endless is always ready. Beat Claude races a separate puzzle against an observed coding-agent turn.</p><p className="muted">Closing Clawdle saves your accepted guesses. A race never changes your daily streak.</p></>}
      {dialog==='stats'&&<><p className="eyebrow">{modeLabels[mode]} STATISTICS</p><div className="stats-summary">{[[stats.played,'Played'],[Math.round(stats.winPercentage),'Win %'],[stats.currentStreak,'Streak'],[stats.longestStreak,'Best streak']].map(([value,label])=><div key={label}><strong>{value}</strong><span>{label}</span></div>)}</div><h3>Guess distribution</h3><div className="distribution">{stats.distribution.map((count,index)=><div key={index}><span>{index+1}</span><b style={{width:`${Math.max(6,100*count/Math.max(1,...stats.distribution))}%`}}>{count}</b></div>)}</div><p className="muted">{stats.losses} losses · {stats.neutral} neutral results</p><p>Fastest eligible solve <strong>{timeLabel(stats.fastestMs)}</strong></p><p>Average eligible solve <strong>{timeLabel(stats.averageMs)}</strong></p></>}
      {dialog==='settings'&&<><div className="settings-list">{([{key:'highContrast',label:'High contrast',description:'Add symbols to colored tiles.'},{key:'reducedMotion',label:'Reduced motion',description:'Keep tile feedback still.'},{key:'speedrunEnabled',label:'Show Speedrun',description:'A sixty-second word sprint.'},...(integration?[{key:'autoRace',label:'Automatic races',description:'Offer correlated turns while Claude works.'},{key:'alwaysOnTop',label:'Always on top',description:'Keep the desktop game visible.'}]:[])] as const).map(item=><label className="setting" key={item.key}><span><strong>{item.label}</strong><small>{item.description}</small></span><input type="checkbox" disabled={busy} checked={pendingSettings[item.key as keyof typeof settings]??settings[item.key as keyof typeof settings]} onChange={e=>void changeSetting(item.key as keyof typeof settings,e.target.checked)}/></label>)}</div><button className="full-width" onClick={()=>setDialog('saved')}>Resume a saved puzzle →</button><button className="full-width" onClick={()=>void exportData()}>Export my games & statistics ↓</button><p className="muted">Saves stay on this device. Browser storage can be cleared by your browser; export to keep a copy. Exports exclude connection secrets and raw agent identities.</p><div className="danger-actions"><button className="text-button danger" onClick={()=>{if(window.confirm('Reset statistics? Active puzzles and your official daily game stay saved.'))void dispatch({type:'resetStatistics',confirmed:true});}}>Reset statistics</button><button className="text-button danger" onClick={()=>{if(window.confirm('Delete all local games and statistics? This cannot be undone. Export a copy first. Claude hooks must be removed separately.'))void dispatch({type:'resetAll',confirmed:true}).then(()=>dispatch({type:'startDaily'}));}}>Delete all game data</button></div>{integration&&<button className="text-button" onClick={()=>setDialog('connect')}>Claude connection settings →</button>}</>}
      {dialog==='saved'&&<><p className="muted">Continue an unfinished puzzle. Older daily games keep their original UTC date.</p>{Object.values(state.games).filter(saved=>saved.status==='playing'&&saved.mode!=='speedrun').map(saved=><button className="full-width" key={saved.gameId} onClick={async()=>{await dispatch({type:'resumeGame',gameId:saved.gameId});setDialog(null);}}>{modeLabels[saved.mode]} · {saved.dailyKey??new Date(saved.startedAtUtc).toLocaleDateString()} · {saved.guesses.length}/6 guesses →</button>)}{!Object.values(state.games).some(saved=>saved.status==='playing'&&saved.mode!=='speedrun')&&<p>No unfinished puzzles. A fresh word is waiting.</p>}</>}
      {dialog==='share'&&<><p>{notice||'Copy the grid below. Your answer and agent details stay private.'}</p><textarea className="share-text" readOnly value={shareText} aria-label="Share result" onFocus={e=>e.target.select()}/><button className="primary full-width" onClick={()=>void copyText(shareText).then(()=>setNotice('Copied your result.')).catch(()=>setNotice('Select the text above and copy manually.'))}>Copy result</button></>}
      {dialog==='connect'&&<><p>Clawdle observes local Claude Code lifecycle hooks. It never reads prompts, responses, code, or transcripts, and never approves permissions.</p>{integration?<><label className="field">Hook scope<select value={scope} onChange={e=>setScope(e.target.value as 'user'|'project')}><option value="user">Global user settings</option><option value="project">Selected project only</option></select></label>{scope==='project'&&<label className="field">Absolute project path<input value={project} onChange={e=>setProject(e.target.value)} placeholder="C:\Projects\my-project"/></label>}<label className="setting"><span><strong>Launch Clawdle when Claude starts</strong><small>Allow a local start hook to open Clawdle when it is closed.</small></span><input type="checkbox" checked={autoLaunch} disabled={busy} onChange={e=>{const checked=e.target.checked;void integrationAction(async()=>{await integration.configure(checked);setAutoLaunch(checked);return checked?'Automatic launch enabled.':'Automatic launch disabled.';});}}/></label><button disabled={busy||(scope==='project'&&!project)} className="primary full-width" onClick={()=>void integrationAction(()=>integration.install(scope,scope==='project'?project:undefined))}>Install local Claude hooks</button><div className="result-actions"><button disabled={busy} onClick={()=>void integrationAction(integration.doctor)}>Check connection</button><button disabled={busy} onClick={()=>void integrationAction(()=>integration.uninstall(scope,scope==='project'?project:undefined))}>Remove owned hooks</button></div>{integrationReport&&<pre className="diagnostics" aria-label="Connection result">{integrationReport}</pre>}<p className="muted">Windows-native Claude Code is the initial target. Without trustworthy prompt identity, status is available but ranked races are disabled. Restart or refresh your Claude session after installing hooks.</p></>:<><p>Agent races are available in the Windows desktop app. This browser version plays Daily, Endless, and Speedrun locally.</p><a className="button primary full-width" href="https://github.com/ndunl075/clawdle/releases" target="_blank" rel="noreferrer">Get the Windows app ↗</a></>}</>}
    </Modal>}
  </main>;
}

function Modal({title,onClose,returnFocus,children}:{title:string;onClose:()=>void;returnFocus:RefObject<HTMLElement|null>;children:ReactNode}) {
  const ref=useRef<HTMLDialogElement>(null);
  // Focus can only leave a modal dialog once it is closed, so restore it here: to the opener when it
  // was reached by keyboard (and is still on the page), otherwise to the game surface so typing goes on.
  useEffect(()=>{const element=ref.current;const opener=document.activeElement;const byKeyboard=opener instanceof HTMLElement&&opener.matches(':focus-visible');element?.showModal();return()=>{element?.close();const target=byKeyboard&&opener instanceof HTMLElement&&opener.isConnected&&!opener.closest('dialog')?opener:returnFocus.current;target?.focus();};},[returnFocus]);
  return <dialog ref={ref} className="dialog" onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===e.currentTarget)onClose();}}><div className="dialog-heading"><h2>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}>×</button></div>{children}</dialog>;
}
