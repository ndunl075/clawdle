import {describe,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {acceptedGuesses,answerIds,createPuzzle,createRace,createSpeedrun,dailyKey,dailyPuzzleNumber,dailySchedule,giveUp,mergeKeyboardStates,reduceRace,reduceSpeedrun,scoreGuess,selectDailyWord,selectEndlessWord,submitGuess,validateGuess,wordFromId,type RaceEvent} from '../src/index';

const utc='2026-10-12T00:00:00Z';
const puzzle=()=>createPuzzle({gameId:'game',mode:'endless',wordId:'en-v1:apple',startedAtUtc:utc});
const race=()=>createRace({raceId:'race',gameId:'game',provider:'claude',sessionId:'session',turnId:'turn',startedSeq:1,startedAtUtc:utc,runtimeEpoch:'epoch',startedMonoMs:100});
const event=(type:RaceEvent['type'],seq:number,extra:Partial<RaceEvent>={}):RaceEvent=>({type,seq,utc,monoMs:100+seq,runtimeEpoch:'epoch',provider:'claude',sessionId:'session',turnId:'turn',scope:'root',...extra});
describe('duplicate letter scoring',()=>{
  it.each([
    ['APPLE','ALLEY',['correct','present','absent','present','absent']],
    ['APPLE','APPLE',Array(5).fill('correct')],
    ['APPLE','ZZZZZ',Array(5).fill('absent')],
    ['ABBEY','BABES',['present','present','correct','correct','absent']],
    ['BANAL','LLAMA',['present','absent','present','absent','present']],
  ])('scores %s / %s',(answer,guess,tiles)=>expect(scoreGuess(answer as string,guess as string)).toEqual(tiles));
  it('never colors more occurrences than available, across the curated answer corpus',()=>{
    for(const id of answerIds){const answer=wordFromId(id); for(const guess of [answer,'AAAAA','EEEEE','LLAMA','ALLEY','APPLE']){
      const tiles=scoreGuess(answer,guess);
      for(const letter of new Set(guess)){expect(tiles.filter((tile,i)=>tile!=='absent'&&guess[i]===letter).length).toBeLessThanOrEqual([...answer].filter(l=>l===letter).length);}
      [...answer].forEach((letter,i)=>{if(letter===guess[i])expect(tiles[i]).toBe('correct');});
    }}
  });
  it('never weakens keyboard evidence',()=>expect(mergeKeyboardStates([{word:'APPLE',tiles:scoreGuess('APPLE','APPLE')},{word:'ALLEY',tiles:scoreGuess('APPLE','ALLEY')}]).L).toBe('correct'));
});
describe('dictionary and immutable puzzle operations',()=>{
  it('includes every curated answer with stable recoverable IDs',()=>{for(const id of answerIds)expect(acceptedGuesses.has(wordFromId(id))).toBe(true); expect(acceptedGuesses.size).toBeGreaterThan(5000);});
  it.each(['','ABCD','ABCDEF','caféx','ＡＰＰＬＥ','ßPPLE',' APPLE','ZZZZZ'])('rejects invalid guess %s without a row',input=>{const p=puzzle();expect(validateGuess(input).valid).toBe(false);expect(submitGuess(p,input,{seq:1,utc}).puzzle).toBe(p);});
  it('normalizes ASCII lowercase only',()=>expect(validateGuess('apple')).toEqual({valid:true,word:'APPLE'}));
  it('solves on every accepted row including the sixth',()=>{for(let winning=1;winning<=6;winning++){let p=puzzle();for(let seq=1;seq<winning;seq++)p=submitGuess(p,'CRANE',{seq,utc}).puzzle;p=submitGuess(p,'APPLE',{seq:winning,utc,elapsedMs:300}).puzzle;expect(p.status).toBe('solved');expect(p.guesses).toHaveLength(winning);expect(p.elapsedMs).toBe(300);expect(submitGuess(p,'APPLE',{seq:9,utc}).puzzle).toBe(p);}});
  it('exhausts six wrong rows and ignores retries',()=>{let p=puzzle();for(let seq=1;seq<=6;seq++){p=submitGuess(p,'CRANE',{seq,utc}).puzzle;expect(submitGuess(p,'CRANE',{seq,utc}).puzzle).toBe(p);}expect(p.status).toBe('exhausted');expect(puzzle().guesses).toHaveLength(0);});
  it('give up terminates once',()=>{const p=giveUp(puzzle(),utc);expect(p.status).toBe('given_up');expect(giveUp(p,'later')).toBe(p);});
  it('matches all manifest checksums',()=>{
    const root=new URL('../../../',import.meta.url);const manifest=JSON.parse(readFileSync(new URL('assets/words/manifest.json',root),'utf8')) as {checksums:Record<string,string>;sourceChecksum:string;sourceArchive:string;entryCounts:{answers:number;guesses:number;daily:number}};
    for(const [path,checksum]of Object.entries(manifest.checksums))expect(createHash('sha256').update(readFileSync(new URL(path,root))).digest('hex'),path).toBe(checksum);
    expect(createHash('sha256').update(readFileSync(new URL(`assets/words/${manifest.sourceArchive}`,root))).digest('hex')).toBe(manifest.sourceChecksum);
    expect(manifest.entryCounts).toEqual({answers:answerIds.length,guesses:acceptedGuesses.size,daily:dailySchedule.length});
  });
});
describe('selection',()=>{
  it('freezes epoch, UTC midnight, pre-epoch wrap, leap dates, and schedule wrap',()=>{
    const start=Date.parse(utc);expect(dailyPuzzleNumber(start)).toBe(1);expect(selectDailyWord(start)).toBe(dailySchedule[0]);expect(selectDailyWord(start-1)).toBe(dailySchedule.at(-1));expect(selectDailyWord(start+86399999)).toBe(dailySchedule[0]);expect(selectDailyWord(start+86400000)).toBe(dailySchedule[1]);expect(selectDailyWord(start+dailySchedule.length*86400000)).toBe(dailySchedule[0]);
    expect(dailyKey(Date.parse('2028-02-29T23:59:59Z'))).toBe('2028-02-29');expect(dailyKey(Date.parse('2026-11-01T01:30:00-04:00'))).toBe('2026-11-01');
    expect(()=>selectDailyWord(start,[])).toThrow();
  });
  it('has permanently frozen first daily fixture',()=>expect(selectDailyWord(Date.parse(utc))).toBe('en-v1:cocoa'));
  it('excludes last fifty choices, falls back if exhausted, and samples endpoints',()=>{
    const pool=['a','b','c'];expect(selectEndlessWord(0,['a'],pool)).toBe('b');expect(selectEndlessWord(0.999,[],pool)).toBe('c');expect(selectEndlessWord(0,pool,pool)).toBe('a');expect(()=>selectEndlessWord(1)).toThrow();
    expect(selectEndlessWord(0,['a',...Array<string>(50).fill('b')],pool)).toBe('a');
  });
});
describe('race ordering and identity',()=>{
  it('solve before completion wins permanently; later animation has no role',()=>{const running=reduceRace(race(),event('presented',2));const won=reduceRace(running,event('solved',3,{guessCount:1}));expect(won.outcome).toBe('player_win');expect(won.ranked).toBe(true);expect(reduceRace(won,event('completed',4))).toBe(won);});
  it('completion first preserves a loss after casual solve',()=>{const loss=reduceRace(reduceRace(race(),event('presented',2)),event('completed',3));expect(loss.outcome).toBe('agent_first');expect(reduceRace(loss,event('solved',4))).toBe(loss);const continued=reduceRace(loss,event('continued_solved',5));expect(continued.outcome).toBe('agent_first');expect(continued.continuedPuzzleSolved).toBe(true);expect(continued.playerSolvedBeforeBoundary).toBe(false);});
  it('does not rank an unpresented or late join offer',()=>{expect(reduceRace(race(),event('completed',2)).ranked).toBe(false);const join=reduceRace(race(),event('presented',2,{lateJoin:true}));expect(reduceRace(join,event('solved',3)).ranked).toBe(false);});
  it('ignores children, old turns, other sessions, stale sequence and providers',()=>{const r=race();for(const extra of [{scope:'child' as const},{turnId:'other'},{sessionId:'other'},{provider:'other'}])expect(reduceRace(r,event('completed',2,extra))).toBe(r);expect(reduceRace(r,event('completed',1))).toBe(r);});
  it('uncorrelated completions cannot finish a race',()=>{const r=race();expect(reduceRace(r,event('completed',2,{turnId:undefined}))).toBe(r);expect(reduceRace(r,event('completed',2,{scope:'unknown'}))).toBe(r);});
  it('attention does not pause time or finish',()=>{const r=reduceRace(reduceRace(race(),event('presented',2)),event('attention',3));expect(r.state).toBe('running');expect(reduceRace(r,event('solved',4,{monoMs:2100})).elapsedMs).toBe(2000);});
  it.each([['leave','abandoned'],['session_ended','agent_disconnected'],['interrupt','interrupted']] as const)('classifies %s neutrally',(type,outcome)=>{const r=reduceRace(race(),event(type,2));expect(r.outcome).toBe(outcome);expect(r.ranked).toBe(false);});
  it('interrupts restart, invalid monotonic clock, and provider error',()=>{for(const extra of [{runtimeEpoch:'new'},{monoMs:0},{endReason:'provider_error'}])expect(reduceRace(race(),event('completed',2,extra)).outcome).toBe('interrupted');});
  it('ranks exhausted guesses only for a running puzzle',()=>{const r=reduceRace(reduceRace(race(),event('presented',2)),event('exhausted',3,{guessCount:6}));expect(r.outcome).toBe('guesses_exhausted');expect(r.guessCountAtEnd).toBe(6);expect(r.ranked).toBe(true);});
});
describe('speedrun strict deadlines',()=>{
  it('counts pre-deadline solves and advances immediately after solve/skip/exhaustion',()=>{let run=createSpeedrun('run','e',0,1);for(const [seq,type]of [[2,'solved'],[3,'skip'],[4,'exhausted']] as const)run=reduceSpeedrun(run,{type,seq,monoMs:59999,runtimeEpoch:'e'});expect(run.solved).toBe(1);expect(run.puzzles).toBe(4);expect(run.status).toBe('running');});
  it('exact tie belongs to the clock and terminal scores never change',()=>{const end=reduceSpeedrun(createSpeedrun('r','e',0,1),{type:'solved',seq:2,monoMs:60000,runtimeEpoch:'e'});expect(end.solved).toBe(0);expect(end.status).toBe('finished');expect(reduceSpeedrun(end,{type:'solved',seq:3,monoMs:59999,runtimeEpoch:'e'})).toBe(end);});
  it('interrupts timing on restart, sleep or reverse clock',()=>{for(const extra of [{runtimeEpoch:'new'},{type:'interrupt' as const},{monoMs:-1}])expect(reduceSpeedrun(createSpeedrun('r','e',0,1),{type:'tick',seq:2,monoMs:1,runtimeEpoch:'e',...extra}).status).toBe('interrupted');});
});
