import data from './words.generated.json';

export type Mode = 'daily' | 'endless' | 'race' | 'speedrun';
export type TileState = 'absent' | 'present' | 'correct';
export type PuzzleStatus = 'playing' | 'solved' | 'exhausted' | 'given_up';
export interface Guess { word: string; tiles: readonly TileState[]; submittedSeq: number; elapsedMs: number | null }
export interface Puzzle { gameId: string; mode: Mode; rulesVersion: 'wordle-5x6-v1'; dictionaryVersion: string; wordId: string; guesses: readonly Guess[]; status: PuzzleStatus; startedAtUtc: string; finishedAtUtc: string | null; elapsedMs: number | null; timingValid: boolean; dailyKey: string | null; speedrunId: string | null }
export const dictionaryVersion = 'en-v1';
export const scheduleVersion = 'daily-v1';
export const answerIds: readonly string[] = Object.freeze(data.answers.map(w => `en-v1:${w.toLowerCase()}`));
export const acceptedGuesses: ReadonlySet<string> = new Set(data.guesses);
export const dailySchedule: readonly string[] = Object.freeze(data.daily);
export function wordFromId(id: string): string {
  if (!/^en-v1:[a-z]{5}$/.test(id) || !acceptedGuesses.has(id.slice(6).toUpperCase())) throw new Error('Unknown word ID');
  return id.slice(6).toUpperCase();
}
export function normalizeInput(input: string): string { return /^[a-zA-Z]*$/.test(input) ? input.toUpperCase() : input; }
export type GuessError = 'invalid_format' | 'not_in_dictionary' | 'puzzle_finished' | 'duplicate_submission';
export function validateGuess(input: string): {valid: boolean; word?: string; error?: GuessError} {
  const word = normalizeInput(input);
  if (!/^[A-Z]{5}$/.test(word)) return {valid:false,error:'invalid_format'};
  return acceptedGuesses.has(word) ? {valid:true,word} : {valid:false,error:'not_in_dictionary'};
}
export function scoreGuess(answer: string, guess: string): TileState[] {
  if (!/^[A-Z]{5}$/.test(answer) || !/^[A-Z]{5}$/.test(guess)) throw new Error('Scoring requires five uppercase ASCII letters');
  const tiles: TileState[] = Array<TileState>(5).fill('absent');
  const remaining = new Map<string, number>();
  for (let i=0;i<5;i++) { const a=answer.charAt(i); if(a===guess.charAt(i)) tiles[i]='correct'; else remaining.set(a,(remaining.get(a) ?? 0)+1); }
  for (let i=0;i<5;i++) { const g=guess.charAt(i); if(tiles[i]!=='correct' && (remaining.get(g) ?? 0)>0) { tiles[i]='present'; remaining.set(g,(remaining.get(g) ?? 0)-1); } }
  return tiles;
}
export function mergeKeyboardStates(guesses: readonly Pick<Guess,'word'|'tiles'>[]): Record<string,TileState> {
  const result: Record<string,TileState>={}; const strength={absent:0,present:1,correct:2};
  for(const guess of guesses) guess.tiles.forEach((tile,i)=>{const letter=guess.word.charAt(i); if(result[letter]===undefined || strength[tile]>strength[result[letter]!]) result[letter]=tile;});
  return result;
}
const DAY_MS=86400000; const EPOCH_MS=Date.UTC(2026,9,12);
export function dailyKey(nowMs: number): string { if(!Number.isFinite(nowMs)) throw new Error('Invalid date'); return new Date(nowMs).toISOString().slice(0,10); }
export function dailyPuzzleNumber(nowMs: number): number { return Math.floor((Date.parse(dailyKey(nowMs))-EPOCH_MS)/DAY_MS)+1; }
export function selectDailyWord(nowMs: number,schedule: readonly string[]=dailySchedule): string { if(!schedule.length) throw new Error('Empty daily schedule'); const day=dailyPuzzleNumber(nowMs)-1; return schedule[((day%schedule.length)+schedule.length)%schedule.length]!; }
export function selectEndlessWord(randomUnit: number,recentIds: readonly string[]=[],pool: readonly string[]=answerIds): string {
  if(!Number.isFinite(randomUnit)||randomUnit<0||randomUnit>=1) throw new Error('Random value must be in [0,1)');
  if(!pool.length) throw new Error('Empty answer collection');
  const recent=new Set(recentIds.slice(-50)); const available=pool.filter(id=>!recent.has(id)); const choices=available.length ? available : pool;
  return choices[Math.floor(randomUnit*choices.length)]!;
}
export function createPuzzle(input: {gameId:string;mode:Mode;wordId:string;startedAtUtc:string;dailyKey?:string|null;speedrunId?:string|null}): Puzzle {
  wordFromId(input.wordId);
  return {...input,rulesVersion:'wordle-5x6-v1',dictionaryVersion,guesses:[],status:'playing',finishedAtUtc:null,elapsedMs:null,timingValid:true,dailyKey:input.dailyKey ?? null,speedrunId:input.speedrunId ?? null};
}
export interface GuessReceipt {seq:number;utc:string;elapsedMs?:number|null}
export function submitGuess(puzzle: Puzzle,input: string,receipt: GuessReceipt): {puzzle:Puzzle;accepted:boolean;error?:GuessError} {
  if(puzzle.guesses.some(g=>g.submittedSeq===receipt.seq)) return {puzzle,accepted:false,error:'duplicate_submission'};
  if(puzzle.status!=='playing') return {puzzle,accepted:false,error:'puzzle_finished'};
  const valid=validateGuess(input); if(!valid.valid || !valid.word) return {puzzle,accepted:false,error:valid.error!};
  const tiles=scoreGuess(wordFromId(puzzle.wordId),valid.word); const guesses=[...puzzle.guesses,{word:valid.word,tiles,submittedSeq:receipt.seq,elapsedMs:receipt.elapsedMs ?? null}];
  const status=tiles.every(t=>t==='correct') ? 'solved' : guesses.length===6 ? 'exhausted' : 'playing';
  return {accepted:true,puzzle:{...puzzle,guesses,status,finishedAtUtc:status==='playing'?null:receipt.utc,elapsedMs:receipt.elapsedMs ?? null}};
}
export function giveUp(puzzle:Puzzle,utc:string):Puzzle { return puzzle.status==='playing'?{...puzzle,status:'given_up',finishedAtUtc:utc}:puzzle; }

/** Validate recovered saves against the original dictionary and rules before use. */
export function validateSavedPuzzle(value:unknown):{valid:true;puzzle:Puzzle}|{valid:false;error:string} {
  const fail=(error:string):{valid:false;error:string}=>({valid:false,error});
  if(!value||typeof value!=='object'||Array.isArray(value))return fail('invalid_puzzle');
  const p=value as Record<string,unknown>;
  // RFC 3339 with an explicit zone. The desktop runtime historically wrote +00:00 rather than Z.
  const timestamp=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v));
  const duration=(v:unknown)=>v===null||(typeof v==='number'&&Number.isFinite(v)&&v>=0);
  if(typeof p.gameId!=='string'||!p.gameId||p.gameId.length>256||!['daily','endless','race','speedrun'].includes(String(p.mode))||p.rulesVersion!=='wordle-5x6-v1'||p.dictionaryVersion!==dictionaryVersion||typeof p.wordId!=='string')return fail('unsupported_puzzle');
  let answer:string;try{answer=wordFromId(p.wordId);}catch{return fail('unknown_word');}
  if(!timestamp(p.startedAtUtc)||!(p.finishedAtUtc===null||timestamp(p.finishedAtUtc))||!duration(p.elapsedMs)||typeof p.timingValid!=='boolean'||!(p.dailyKey===null||(typeof p.dailyKey==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(p.dailyKey)&&Number.isFinite(Date.parse(p.dailyKey))))||!(p.speedrunId===null||typeof p.speedrunId==='string'))return fail('invalid_metadata');
  if((p.mode==='daily')!==(p.dailyKey!==null)||(p.mode==='speedrun')!==(p.speedrunId!==null))return fail('invalid_mode_identity');
  if(!Array.isArray(p.guesses)||p.guesses.length>6)return fail('invalid_guesses');
  let previousSeq=0;let solved=false;
  const guesses:Guess[]=[];
  for(const value of p.guesses){
    if(!value||typeof value!=='object'||solved)return fail('invalid_guess');
    const g=value as Record<string,unknown>;
    if(typeof g.word!=='string'||!validateGuess(g.word).valid||g.word!==g.word.toUpperCase()||!Number.isSafeInteger(g.submittedSeq)||Number(g.submittedSeq)<=previousSeq||!duration(g.elapsedMs)||!Array.isArray(g.tiles))return fail('invalid_guess');
    const savedTiles=g.tiles;const expected=scoreGuess(answer,g.word);if(savedTiles.length!==5||expected.some((tile,i)=>tile!==savedTiles[i]))return fail('invalid_tiles');
    previousSeq=Number(g.submittedSeq);solved=expected.every(tile=>tile==='correct');
    guesses.push({word:g.word,tiles:expected,submittedSeq:previousSeq,elapsedMs:g.elapsedMs as number|null});
  }
  const expected=solved?'solved':guesses.length===6?'exhausted':'playing';
  if(p.status!==expected&&!(p.status==='given_up'&&expected==='playing'))return fail('invalid_outcome');
  if((p.status==='playing')!==(p.finishedAtUtc===null))return fail('invalid_finish_time');
  return {valid:true,puzzle:{gameId:p.gameId,mode:p.mode as Mode,rulesVersion:'wordle-5x6-v1',dictionaryVersion,wordId:p.wordId,guesses,status:p.status as PuzzleStatus,startedAtUtc:p.startedAtUtc as string,finishedAtUtc:p.finishedAtUtc as string|null,elapsedMs:p.elapsedMs as number|null,timingValid:p.timingValid,dailyKey:p.dailyKey as string|null,speedrunId:p.speedrunId as string|null}};
}

export type RaceOutcome='player_win'|'agent_first'|'guesses_exhausted'|'abandoned'|'agent_disconnected'|'interrupted';
export interface Race {raceId:string;gameId:string;provider:string;sessionId:string;turnId:string;state:'offered'|'running'|'terminal';startedSeq:number;presentedSeq:number|null;startedAtUtc:string;endedAtUtc:string|null;runtimeEpoch:string;elapsedMs:number|null;outcome:RaceOutcome|null;guessCountAtEnd:number;playerSolvedBeforeBoundary:boolean;continuedPuzzleSolved:boolean;ranked:boolean;unrankedReason:string|null;startedMonoMs:number;lastMonoMs:number;lastSeq:number}
export interface RaceEvent {type:'presented'|'solved'|'exhausted'|'completed'|'session_ended'|'leave'|'interrupt'|'continued_solved'|'activity'|'attention';seq:number;utc:string;monoMs:number;runtimeEpoch:string;provider?:string;sessionId?:string;turnId?:string;scope?:'root'|'child'|'unknown';lateJoin?:boolean;endReason?:string;guessCount?:number}
export function createRace(input:Pick<Race,'raceId'|'gameId'|'provider'|'sessionId'|'turnId'|'startedSeq'|'startedAtUtc'|'runtimeEpoch'|'startedMonoMs'>):Race {if(!input.turnId||!input.sessionId)throw new Error('Race requires correlated turn identity');return {...input,state:'offered',presentedSeq:null,endedAtUtc:null,elapsedMs:null,outcome:null,guessCountAtEnd:0,playerSolvedBeforeBoundary:false,continuedPuzzleSolved:false,ranked:true,unrankedReason:null,lastSeq:input.startedSeq,lastMonoMs:input.startedMonoMs};}
export function elapsedSince(anchorMs:number,nowMs:number):number|null {return Number.isFinite(anchorMs)&&Number.isFinite(nowMs)&&nowMs>=anchorMs?nowMs-anchorMs:null;}
export function reduceRace(race:Race,event:RaceEvent):Race {
  if(event.seq<=race.lastSeq) return race;
  if(event.type==='completed'&&(!event.provider||!event.sessionId||!event.turnId||event.scope!=='root'))return race;
  if(event.type==='session_ended'&&(!event.provider||!event.sessionId||event.scope!=='root'))return race;
  if(event.scope==='child'||event.scope==='unknown'||(event.provider!==undefined&&event.provider!==race.provider)||(event.sessionId!==undefined&&event.sessionId!==race.sessionId)||(event.turnId!==undefined&&event.turnId!==race.turnId)) return race;
  if(race.state==='terminal') return event.type==='continued_solved'&&race.outcome==='agent_first'?{...race,continuedPuzzleSolved:true,lastSeq:event.seq}:race;
  const elapsed=event.runtimeEpoch===race.runtimeEpoch&&event.monoMs>=race.lastMonoMs?elapsedSince(race.startedMonoMs,event.monoMs):null;
  const next:Race={...race,lastSeq:event.seq,lastMonoMs:event.monoMs};
  const finish=(outcome:RaceOutcome,reason?:string):Race=>({...next,state:'terminal',outcome,endedAtUtc:event.utc,elapsedMs:elapsed,guessCountAtEnd:event.guessCount??race.guessCountAtEnd,playerSolvedBeforeBoundary:outcome==='player_win',ranked:next.ranked&&!reason&&!['abandoned','agent_disconnected','interrupted'].includes(outcome),unrankedReason:reason??next.unrankedReason});
  if(elapsed===null||event.type==='interrupt'||event.endReason==='provider_error'||event.endReason==='interrupted') return finish('interrupted','timing_interrupted');
  if(event.type==='leave') return finish('abandoned','abandoned');
  if(event.type==='session_ended') return finish('agent_disconnected','agent_disconnected');
  if(event.type==='completed') return finish('agent_first',race.state==='offered'?'not_presented':undefined);
  if(event.type==='presented'&&race.state==='offered') return {...next,state:'running',presentedSeq:event.seq,ranked:!event.lateJoin,unrankedReason:event.lateJoin?'late_join':null};
  if(race.state==='running'&&event.type==='solved') return finish('player_win');
  if(race.state==='running'&&event.type==='exhausted') return finish('guesses_exhausted');
  return next;
}
export interface Speedrun {runId:string;runtimeEpoch:string;startedMonoMs:number;deadlineMonoMs:number;status:'running'|'finished'|'interrupted';solved:number;puzzles:number;lastSeq:number}
export function createSpeedrun(runId:string,runtimeEpoch:string,monoMs:number,seq:number):Speedrun {return {runId,runtimeEpoch,startedMonoMs:monoMs,deadlineMonoMs:monoMs+60000,status:'running',solved:0,puzzles:1,lastSeq:seq};}
export function reduceSpeedrun(run:Speedrun,event:{type:'solved'|'skip'|'exhausted'|'tick'|'interrupt';monoMs:number;runtimeEpoch:string;seq:number}):Speedrun {
  if(run.status!=='running'||event.seq<=run.lastSeq)return run;
  if(event.runtimeEpoch!==run.runtimeEpoch||!Number.isFinite(event.monoMs)||event.monoMs<run.startedMonoMs||event.type==='interrupt')return {...run,status:'interrupted',lastSeq:event.seq};
  if(event.monoMs>=run.deadlineMonoMs)return {...run,status:'finished',lastSeq:event.seq};
  const advance=['solved','skip','exhausted'].includes(event.type);
  return {...run,lastSeq:event.seq,solved:run.solved+(event.type==='solved'?1:0),puzzles:run.puzzles+(advance?1:0)};
}
