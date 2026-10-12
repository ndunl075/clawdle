import { describe, it, expect } from 'vitest';
import { wordFromId } from '@clawdle/game';
import { createController, type Platform, type Checkpoint, type JournalEntry, type Command, type ResultRow, type AppState } from './index';
class Memory implements Platform {
    epoch = 'epoch-a';
    mono = 0;
    utc = '2026-10-12T12:00:00Z';
    checkpoint: Checkpoint | null = null;
    entries: JournalEntry[] = [];
    fail = false;
    counter = 0;
    id() { return `00000000-0000-4000-8000-${(++this.counter).toString(16).padStart(12, '0')}`; }
    ;
    randomUnit() { return .5; }
    ;
    async subscribe() { return () => { }; }
    ;
    async snapshot() { return { runtimeEpoch: this.epoch, receivedAtUtc: this.utc, receivedMonoMs: this.mono, latestSeq: this.entries.length, checkpoint: structuredClone(this.checkpoint) }; }
    async append(eventId: string, command: Command) { return this.add(command, 'command', eventId); }
    add(payload: unknown, kind: JournalEntry['kind'] = 'agent', eventId = this.id()) {
        const old = this.entries.find(e => e.eventId === eventId);
        if (old)
            return old;
        const entry = { seq: this.entries.length + 1, eventId, payload, kind, runtimeEpoch: this.epoch, receivedMonoMs: this.mono, receivedAtUtc: this.utc };
        this.entries.push(entry);
        return entry;
    }
    async read(after: number) { return this.entries.filter(e => e.seq > after); }
    async commit(expected: number, state: AppState, _results: ResultRow[]) {
        if (this.fail)
            throw new Error('disk full');
        if (expected !== (this.checkpoint?.stateVersion ?? 0))
            throw new Error('conflict');
        this.checkpoint = { stateVersion: expected + 1, processedSeq: state.processedSeq, state: structuredClone({ ...state, stateVersion: expected + 1 }) };
        return this.checkpoint;
    }
}
const start = { type: 'agent.started', provider: 'claude', sessionId: 's', turnId: 'turn', scope: 'root' };
const stop = { ...start, type: 'agent.turn_completed' };
async function race() { const p = new Memory(); const c = await createController(p); p.add(start); await c.refresh(); const id = Object.keys(c.state.races)[0]!; await c.dispatch({ type: 'presentRace', raceId: id, lateJoin: false }); return { p, c, id }; }
describe('durable application controller', () => {
    it('persists a daily unique result and deduplicates retried actions', async () => { const p = new Memory(), c = await createController(p); await c.dispatch({ type: 'startDaily' }); const id = c.state.activeGameId!; const word = wordFromId(c.state.games[id]!.wordId); const action = p.id(); await c.dispatch({ type: 'submitGuess', word }, action); await c.dispatch({ type: 'submitGuess', word }, action); await c.dispatch({ type: 'startDaily' }); expect(c.state.activeGameId).toBe(id); expect(c.state.results).toHaveLength(1); expect(c.stats().wins).toBe(1); expect(c.share()).not.toContain(word); const reopened = await createController(p); expect(reopened.state.games[id]?.status).toBe('solved'); });
    it('does not publish an unsaved move and replays its chosen answer deterministically', async () => { const p = new Memory(), c = await createController(p); p.fail = true; await expect(c.dispatch({ type: 'startEndless' })).rejects.toThrow('disk full'); expect(c.state.activeGameId).toBeNull(); p.fail = false; await c.refresh(); const answer = c.state.games[c.state.activeGameId!]!.wordId; p.checkpoint = null; const recovered = await createController(p); expect(recovered.state.games[recovered.state.activeGameId!]!.wordId).toBe(answer); });
    it('rejects invalid guesses without consuming a row', async () => { const p = new Memory(), c = await createController(p); await c.dispatch({ type: 'startDaily' }); await c.dispatch({ type: 'submitGuess', word: '12345' }); expect(c.state.games[c.state.activeGameId!]!.guesses).toHaveLength(0); expect(c.state.feedback).toBe('invalid_format'); });
    it('orders hidden Stop before later solve and keeps casual completion separate', async () => { const { p, c, id } = await race(); p.mono = 100; p.add(stop); await c.dispatch({ type: 'submitGuess', word: wordFromId(c.state.games[c.state.activeGameId!]!.wordId) }); expect(c.state.races[id]?.outcome).toBe('agent_first'); expect(c.state.races[id]?.continuedPuzzleSolved).toBe(true); expect(c.state.results).toHaveLength(1); expect(c.stats('daily').played).toBe(0); });
    it('freezes player win before later Stop', async () => { const { p, c, id } = await race(); p.mono = 50; await c.dispatch({ type: 'submitGuess', word: wordFromId(c.state.games[c.state.activeGameId!]!.wordId) }); p.add(stop); await c.refresh(); expect(c.state.races[id]?.outcome).toBe('player_win'); expect(c.stats('race').wins).toBe(1); });
    it('ignores child/other-turn completion and remembers completion-before-start tombstones', async () => { const { p, c, id } = await race(); p.add({ ...stop, scope: 'child' }); p.add({ ...stop, turnId: 'other' }); await c.refresh(); expect(c.state.races[id]?.state).toBe('running'); p.add({ ...stop, turnId: 'future' }); p.add({ ...start, turnId: 'future' }); await c.refresh(); expect(Object.values(c.state.races).some(r => r.turnId === 'future')).toBe(false); });
    it('replays pre-restart completion before interrupting remaining live races', async () => { const { p, c, id } = await race(); p.add(stop); p.epoch = 'epoch-b'; p.add({ type: 'runtime.interrupted' }, 'runtime'); const reopened = await createController(p); expect(reopened.state.races[id]?.outcome).toBe('agent_first'); expect(c.state.races[id]?.state).toBe('running'); });
    it('turns remaining live races neutral after restart', async () => { const { p, id } = await race(); p.epoch = 'epoch-b'; const reopened = await createController(p); expect(reopened.state.races[id]?.outcome).toBe('interrupted'); expect(reopened.stats('race').neutral).toBe(1); });
    it('uses strict speedrun deadline and interrupts restarted runs', async () => { const p = new Memory(), c = await createController(p); await c.dispatch({ type: 'changeSettings', settings: { speedrunEnabled: true } }); await c.dispatch({ type: 'startSpeedrun' }); const run = c.state.speedruns[c.state.activeSpeedrunId!]!; p.mono = run.deadlineMonoMs; await c.dispatch({ type: 'submitGuess', word: wordFromId(c.state.games[c.state.activeGameId!]!.wordId) }); expect(c.state.speedruns[run.speedrunId]?.status).toBe('finished'); expect(c.state.speedruns[run.speedrunId]?.solved).toBe(0); await c.dispatch({ type: 'startSpeedrun' }); p.epoch = 'epoch-b'; const reopened = await createController(p); expect(reopened.state.speedruns[reopened.state.activeSpeedrunId!]!.status).toBe('interrupted'); });
    it('resets statistics while retaining completed official daily identity', async () => { const p = new Memory(), c = await createController(p); await c.dispatch({ type: 'startDaily' }); const id = c.state.activeGameId!; await c.dispatch({ type: 'submitGuess', word: wordFromId(c.state.games[id]!.wordId) }); await c.dispatch({ type: 'resetStatistics', confirmed: true }); expect(c.stats().played).toBe(0); await c.dispatch({ type: 'startDaily' }); expect(c.state.activeGameId).toBe(id); expect(c.state.games[id]?.status).toBe('solved'); });
    it('exports no live session binding or receipt clocks', async () => { const { c } = await race(); const output = c.exportData(); expect(output).not.toContain('sessionId'); expect(output).not.toContain('runtimeEpoch'); expect(output).not.toContain('receivedMonoMs'); });
});
