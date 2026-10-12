import { createPuzzle, submitGuess, giveUp, selectDailyWord, selectEndlessWord, dailyKey, dailyPuzzleNumber, wordFromId, createRace, reduceRace, createSpeedrun, reduceSpeedrun, validateSavedPuzzle } from '@clawdle/game';
import { emptyState, type AppState, type Platform, type Command, type JournalEntry, type ResultRow } from './types';
import { deriveStatistics, exportProfile } from './statistics';
export class AppController {
    private clockAnchor = { runtimeEpoch: '', monoMs: 0, localMonoMs: performance.now() };
    private listeners = new Set<() => void>();
    private queue: Promise<unknown> = Promise.resolve();
    private unsubscribe: () => void = () => { };
    state: AppState = emptyState();
    error: string | null = null;
    constructor(readonly platform: Platform) { }
    async initialize() {
        this.unsubscribe = await this.platform.subscribe(() => { void this.refresh().catch(() => { }); });
        const snapshot = await this.platform.snapshot();
        this.clockAnchor = { runtimeEpoch: snapshot.runtimeEpoch, monoMs: snapshot.receivedMonoMs, localMonoMs: performance.now() };
        this.state = snapshot.checkpoint ? { ...snapshot.checkpoint.state, stateVersion: snapshot.checkpoint.stateVersion, processedSeq: snapshot.checkpoint.processedSeq } : emptyState();
        this.validateRecovery();
        if (!this.platform.readonly)
            await this.platform.alwaysOnTop?.(this.state.settings.alwaysOnTop);
        await this.refresh();
        if (!this.platform.readonly)
            await this.interruptStale(snapshot.runtimeEpoch);
        return this;
    }
    private validateRecovery() {
        if (this.state.schemaVersion !== 1 || !this.state.games || !Array.isArray(this.state.results))
            throw new Error('Unsupported saved profile; original storage has been preserved');
        this.state.quarantinedGames ??= {};
        for (const [id, value] of Object.entries(this.state.games)) {
            const checked = validateSavedPuzzle(value);
            if (checked.valid)
                this.state.games[id] = checked.puzzle;
            else {
                this.state.quarantinedGames[id] = value;
                delete this.state.games[id];
                if (this.state.activeGameId === id)
                    this.state.activeGameId = null;
                this.state.feedback = 'A saved puzzle needs recovery; other games remain available';
            }
        }
    }
    subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    private publish() {
        for (const listener of this.listeners)
            listener();
    }
    private serialize<T>(fn: () => Promise<T>): Promise<T> { const next = this.queue.then(fn, fn); this.queue = next.catch(() => { }); return next; }
    refresh(): Promise<void> { return this.serialize(() => this.consume()); }
    dispatch(command: Command, actionId = this.platform.id()): Promise<void> {
        return this.serialize(async () => {
            if (this.platform.readonly)
                throw new Error('Another tab owns this profile.');
            try {
                await this.platform.append(actionId, command);
                await this.consume();
                this.error = null;
            }
            catch (error) {
                this.error = error instanceof Error ? error.message : 'Unable to save';
                this.publish();
                throw error;
            }
        });
    }
    private async consume() {
        const snapshot = await this.platform.snapshot();
        this.clockAnchor = { runtimeEpoch: snapshot.runtimeEpoch, monoMs: snapshot.receivedMonoMs, localMonoMs: performance.now() };
        if ((snapshot.checkpoint?.stateVersion ?? 0) > this.state.stateVersion)
            this.state = { ...snapshot.checkpoint!.state, stateVersion: snapshot.checkpoint!.stateVersion, processedSeq: snapshot.checkpoint!.processedSeq };
        if (this.platform.readonly) {
            this.publish();
            return;
        }
        const entries = await this.platform.read(this.state.processedSeq);
        if (!entries.length) {
            this.publish();
            return;
        }
        let next = structuredClone(this.state);
        const newResults: ResultRow[] = [];
        for (const entry of entries.sort((a, b) => a.seq - b.seq)) {
            if (entry.seq <= next.processedSeq)
                continue;
            if (entry.seq !== next.processedSeq + 1)
                throw new Error('Journal gap; recovery required');
            this.project(next, entry);
            next.processedSeq = entry.seq;
        }
        for (const row of next.results)
            if (!this.state.results.some(old => old.resultId === row.resultId))
                newResults.push(row);
        try {
            const previous = this.state;
            const checkpoint = await this.platform.commit(this.state.stateVersion, next, newResults);
            this.state = { ...checkpoint.state, stateVersion: checkpoint.stateVersion, processedSeq: checkpoint.processedSeq };
            this.publish();
            await this.deliverEffects(previous).catch(() => { });
            if (this.state.processedSeq < snapshot.latestSeq)
                await this.consume();
        }
        catch (error) {
            const current = await this.platform.snapshot();
            if (current.checkpoint && current.checkpoint.stateVersion !== this.state.stateVersion) {
                this.state = { ...current.checkpoint.state, stateVersion: current.checkpoint.stateVersion, processedSeq: current.checkpoint.processedSeq };
                await this.consume();
                return;
            }
            throw error;
        }
    }
    private async deliverEffects(previous: AppState) {
        const current = this.state;
        if (current.settings.alwaysOnTop !== previous.settings.alwaysOnTop)
            await this.platform.alwaysOnTop?.(current.settings.alwaysOnTop);
        const race = current.activeRaceId ? current.races[current.activeRaceId] : undefined;
        if (race && race.state === 'offered' && current.settings.autoRace && previous.activeRaceId !== race.raceId && this.platform.showWindow) {
            if (await this.platform.claimEffect?.(`show:${race.raceId}`))
                await this.platform.showWindow(false);
        }
        if (this.platform.notify)
            for (const [key, status] of Object.entries(current.agentStatuses)) {
                if (status.status === 'attention' && status.lastSeq !== (previous.agentStatuses ?? {})[key]?.lastSeq) {
                    if (await this.platform.claimEffect?.(`attention:${key}:${status.lastSeq}`))
                        await this.platform.notify('Claude needs attention', 'Check your coding agent to respond.');
                }
            }
    }
    private async interruptStale(epoch: string) {
        const stale = Object.values(this.state.races).some(r => r.state !== 'terminal' && r.runtimeEpoch !== epoch) || Object.values(this.state.speedruns).some(r => r.status === 'running' && r.runtimeEpoch !== epoch);
        if (stale)
            await this.dispatch({ type: 'tick' });
    }
    private entropy(e: JournalEntry) {
        const provided = (e.payload as {
            randomUnit?: number;
        }).randomUnit;
        if (provided !== undefined)
            return provided;
        const tail = e.eventId.replaceAll('-', '').slice(-8);
        if (/^[a-f0-9]{8}$/i.test(tail))
            return Number.parseInt(tail, 16) / 4294967296;
        let hash = 2166136261;
        for (const char of e.eventId)
            hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
        return (hash >>> 0) / 4294967296;
    }
    private newPuzzle(s: AppState, e: JournalEntry, mode: 'daily' | 'endless' | 'race' | 'speedrun', suffix = '', speedrunId?: string) {
        const key = mode === 'daily' ? dailyKey(Date.parse(e.receivedAtUtc)) : null;
        const wordId = mode === 'daily' ? selectDailyWord(Date.parse(e.receivedAtUtc)) : selectEndlessWord(this.entropy(e), s.recentWordIds);
        const gameId = mode === 'daily' ? `daily-v1:${key}` : `${mode}:${e.eventId}${suffix}`;
        if (!s.games[gameId]) {
            s.games[gameId] = createPuzzle({ gameId, mode, wordId, startedAtUtc: e.receivedAtUtc, ...(key ? { dailyKey: key } : {}), ...(speedrunId ? { speedrunId } : {}) });
            s.gameAnchors[gameId] = { runtimeEpoch: e.runtimeEpoch, monoMs: e.receivedMonoMs };
            s.recentWordIds = [...s.recentWordIds, wordId].slice(-50);
        }
        return gameId;
    }
    private result(s: AppState, e: JournalEntry, identity: string, mode: string, outcome: string, won: boolean, ranked: boolean, guessCount: number, elapsedMs: number | null, daily: string | null = null) {
        if (s.results.some(r => r.identity === identity))
            return;
        s.results.push({ resultId: `result:${identity}:${e.seq}`, identity, mode, payload: { outcome, won, ranked, guessCount, elapsedMs, dailyKey: daily, finishedAtUtc: e.receivedAtUtc } });
    }
    private syncRace(s: AppState, e: JournalEntry, raceId: string) {
        const r = s.races[raceId]!;
        if (r.state === 'terminal' && r.outcome) {
            this.result(s, e, r.raceId, 'race', r.outcome, r.outcome === 'player_win', r.ranked && ['player_win', 'agent_first', 'guesses_exhausted'].includes(r.outcome), r.guessCountAtEnd, r.ranked ? r.elapsedMs : null);
        }
    }
    private project(s: AppState, e: JournalEntry) {
        s.feedback = null;
        const timingInterrupted = e.kind === 'runtime' || (e.kind === 'command' && (e.payload as Command).type === 'interruptTiming');
        if (timingInterrupted)
            for (const g of Object.values(s.games))
                if (g.status === 'playing')
                    g.timingValid = false;
        for (const run of Object.values(s.speedruns)) {
            if (run.status === 'running' && (run.runtimeEpoch !== e.runtimeEpoch || e.receivedMonoMs < run.startedMonoMs || timingInterrupted)) {
                run.status = 'interrupted';
                run.finishedAtUtc = e.receivedAtUtc;
                this.result(s, e, run.speedrunId, 'speedrun', 'interrupted', false, false, run.solved, null);
            }
            else if (run.status === 'running' && e.receivedMonoMs >= run.deadlineMonoMs) {
                run.status = 'finished';
                run.finishedAtUtc = e.receivedAtUtc;
                this.result(s, e, run.speedrunId, 'speedrun', 'finished', true, true, run.solved, run.durationMs);
            }
        }
        for (const r of Object.values(s.races)) {
            if (r.state !== 'terminal' && (r.runtimeEpoch !== e.runtimeEpoch || timingInterrupted)) {
                s.races[r.raceId] = reduceRace(r, { type: 'interrupt', seq: e.seq, utc: e.receivedAtUtc, monoMs: e.receivedMonoMs, runtimeEpoch: e.runtimeEpoch });
                this.syncRace(s, e, r.raceId);
            }
        }
        if (e.kind === 'agent') {
            this.agent(s, e);
            return;
        }
        if (e.kind !== 'command')
            return;
        const c = e.payload as Command;
        const game = s.activeGameId ? s.games[s.activeGameId] : undefined;
        const race = s.activeRaceId ? s.races[s.activeRaceId] : game ? Object.values(s.races).find(r => r.gameId === game.gameId) : undefined;
        const run = s.activeSpeedrunId ? s.speedruns[s.activeSpeedrunId] : undefined;
        const abandon = () => {
            if (run?.status === 'running') {
                run.status = 'interrupted';
                run.finishedAtUtc = e.receivedAtUtc;
                this.result(s, e, run.speedrunId, 'speedrun', 'interrupted', false, false, run.solved, null);
            }
            if (race && race.state !== 'terminal') {
                s.races[race.raceId] = reduceRace(race, { type: 'leave', seq: e.seq, utc: e.receivedAtUtc, monoMs: e.receivedMonoMs, runtimeEpoch: e.runtimeEpoch });
                this.syncRace(s, e, race.raceId);
            }
            s.activeRaceId = null;
            s.activeSpeedrunId = null;
        };
        switch (c.type) {
            case 'startDaily':
                if (s.quarantinedGames[`daily-v1:${dailyKey(Date.parse(e.receivedAtUtc))}`]) {
                    s.feedback = 'This saved daily puzzle needs recovery';
                    break;
                }
                abandon();
                s.activeGameId = this.newPuzzle(s, e, 'daily');
                break;
            case 'startEndless':
                abandon();
                s.activeGameId = Object.values(s.games).find(g => g.mode === 'endless' && g.status === 'playing')?.gameId ?? this.newPuzzle(s, e, 'endless');
                break;
            case 'submitGuess': {
                if (!game)
                    return;
                if (race?.state === 'offered') {
                    s.feedback = 'Present this race before playing';
                    return;
                }
                if (run && run.status !== 'running') {
                    s.feedback = 'Run has ended';
                    return;
                }
                const anchor = s.gameAnchors[game.gameId];
                const elapsed = anchor?.runtimeEpoch === e.runtimeEpoch && e.receivedMonoMs >= anchor.monoMs ? e.receivedMonoMs - anchor.monoMs : null;
                const applied = submitGuess(game, c.word, { seq: e.seq, utc: e.receivedAtUtc, elapsedMs: elapsed });
                if (!applied.accepted) {
                    s.feedback = applied.error ?? 'Invalid guess';
                    return;
                }
                s.games[game.gameId] = { ...applied.puzzle, timingValid: game.timingValid && elapsed !== null };
                const p = s.games[game.gameId]!;
                if (race) {
                    if ((p.status === 'solved' || p.status === 'exhausted') && (race.state !== 'terminal' || p.status === 'solved'))
                        s.races[race.raceId] = reduceRace(race, { type: race.state === 'terminal' ? 'continued_solved' : p.status === 'solved' ? 'solved' : 'exhausted', seq: e.seq, utc: e.receivedAtUtc, monoMs: e.receivedMonoMs, runtimeEpoch: e.runtimeEpoch, guessCount: p.guesses.length });
                    this.syncRace(s, e, race.raceId);
                }
                else if (run) {
                    if (p.status === 'solved' || p.status === 'exhausted')
                        Object.assign(run, reduceSpeedrun(run, { type: p.status, seq: e.seq, monoMs: e.receivedMonoMs, runtimeEpoch: e.runtimeEpoch }));
                    if (p.status !== 'playing')
                        s.activeGameId = this.newPuzzle(s, e, 'speedrun', `:next:${e.seq}`, run.speedrunId);
                }
                else if (p.status !== 'playing')
                    this.result(s, e, p.gameId, p.mode, p.status, p.status === 'solved', true, p.guesses.length, p.timingValid ? p.elapsedMs : null, p.dailyKey);
                break;
            }
            case 'giveUp':
                if (game) {
                    s.games[game.gameId] = giveUp(game, e.receivedAtUtc);
                    if (race) {
                        abandon();
                    }
                    else if (run) {
                        Object.assign(run, reduceSpeedrun(run, { type: 'skip', seq: e.seq, monoMs: e.receivedMonoMs, runtimeEpoch: e.runtimeEpoch }));
                        s.activeGameId = this.newPuzzle(s, e, 'speedrun', ':skip', run.speedrunId);
                    }
                    else
                        this.result(s, e, game.gameId, game.mode, 'given_up', false, true, game.guesses.length, null, game.dailyKey);
                }
                break;
            case 'presentRace': {
                const target = s.races[c.raceId];
                if (!target || !s.games[target.gameId])
                    return;
                if (s.activeRaceId === target.raceId && target.state === 'running')
                    return;
                abandon();
                s.activeRaceId = target.raceId;
                s.activeGameId = target.gameId;
                s.races[target.raceId] = reduceRace(target, { type: 'presented', seq: e.seq, utc: e.receivedAtUtc, lateJoin: c.lateJoin ?? !s.settings.autoRace, monoMs: e.receivedMonoMs, runtimeEpoch: e.runtimeEpoch });
                break;
            }
            case 'leaveRace':
                abandon();
                break;
            case 'startSpeedrun':
                if (!s.settings.speedrunEnabled) {
                    s.feedback = 'Enable Speedrun in settings';
                    break;
                }
                abandon();
                {
                    const id = `speedrun:${e.eventId}`;
                    s.speedruns[id] = { ...createSpeedrun(id, e.runtimeEpoch, e.receivedMonoMs, e.seq), speedrunId: id, durationMs: 60000, deadlineMonoMs: e.receivedMonoMs + 60000, runtimeEpoch: e.runtimeEpoch, solved: 0, status: 'running', startedAtUtc: e.receivedAtUtc, finishedAtUtc: null };
                    s.activeSpeedrunId = id;
                    s.activeGameId = this.newPuzzle(s, e, 'speedrun', '', id);
                }
                break;
            case 'skipWord':
                if (run?.status === 'running' && game) {
                    s.games[game.gameId] = giveUp(game, e.receivedAtUtc);
                    Object.assign(run, reduceSpeedrun(run, { type: 'skip', seq: e.seq, monoMs: e.receivedMonoMs, runtimeEpoch: e.runtimeEpoch }));
                    s.activeGameId = this.newPuzzle(s, e, 'speedrun', ':skip', run.speedrunId);
                }
                break;
            case 'changeSettings':
                s.settings = { ...s.settings, ...c.settings };
                break;
            case 'resetStatistics':
                if (c.confirmed)
                    s.statsResetSeq = e.seq;
                break;
            case 'resetAll':
                if (c.confirmed) {
                    const cleared = emptyState();
                    Object.assign(s, cleared, { stateVersion: s.stateVersion, processedSeq: s.processedSeq, dataResetSeq: e.seq });
                }
                break;
            case 'tick':
            case 'interruptTiming': break;
        }
    }
    private agent(s: AppState, e: JournalEntry) {
        const a = e.payload as {
            type: string;
            provider: string;
            sessionId: string;
            turnId?: string;
            scope: string;
            endReason?: string;
        };
        if (a.scope !== 'root')
            return;
        s.agentStatuses ??= {};
        s.agentStatuses[`${a.provider}:${a.sessionId}`] = { provider: a.provider, sessionId: a.sessionId, turnId: a.turnId ?? null, status: a.type === 'agent.needs_attention' ? 'attention' : a.type === 'agent.turn_completed' ? 'completed' : a.type === 'agent.session_ended' ? 'disconnected' : 'working', lastSeq: e.seq };
        const binding = `${a.provider}:${a.sessionId}:${a.turnId}`;
        if (a.type === 'agent.turn_completed' && a.turnId && !s.tombstones.includes(binding))
            s.tombstones.push(binding);
        if (a.type === 'agent.started' && a.turnId && !s.tombstones.includes(binding) && !Object.values(s.races).some(r => `${r.provider}:${r.sessionId}:${r.turnId}` === binding)) {
            const id = `race:${e.eventId}`;
            const gameId = this.newPuzzle(s, e, 'race');
            s.races[id] = createRace({ raceId: id, gameId, provider: a.provider, sessionId: a.sessionId, turnId: a.turnId, startedSeq: e.seq, startedAtUtc: e.receivedAtUtc, runtimeEpoch: e.runtimeEpoch, startedMonoMs: e.receivedMonoMs });
            if (s.settings.autoRace && (!s.activeGameId || s.games[s.activeGameId]?.status !== 'playing')) {
                s.activeRaceId = id;
                s.activeGameId = gameId;
            }
        }
        for (const r of Object.values(s.races)) {
            if (r.provider !== a.provider || r.sessionId !== a.sessionId)
                continue;
            const type = a.type === 'agent.turn_completed' ? 'completed' : a.type === 'agent.session_ended' ? 'session_ended' : a.type === 'agent.needs_attention' ? 'attention' : 'activity';
            if (type !== 'session_ended' && a.turnId !== r.turnId)
                continue;
            s.races[r.raceId] = reduceRace(r, { type, seq: e.seq, utc: e.receivedAtUtc, monoMs: e.receivedMonoMs, runtimeEpoch: e.runtimeEpoch, provider: a.provider, sessionId: a.sessionId, ...(a.turnId ? { turnId: a.turnId } : {}), scope: 'root', ...(a.endReason ? { endReason: a.endReason } : {}) });
            this.syncRace(s, e, r.raceId);
        }
    }
    clock() { return { runtimeEpoch: this.clockAnchor.runtimeEpoch, monoMs: this.clockAnchor.monoMs + Math.max(0, performance.now() - this.clockAnchor.localMonoMs) }; }
    stats(mode = 'daily', nowMs = Date.now()) { return deriveStatistics(this.state, mode, nowMs); }
    share(gameId = this.state.activeGameId) {
        const g = gameId ? this.state.games[gameId] : undefined;
        if (!g || g.status === 'playing')
            return '';
        const race = Object.values(this.state.races).find(r => r.gameId === g.gameId);
        const suffix = race?.outcome ? `\n${race.outcome === 'player_win' ? 'Player won' : race.outcome === 'agent_first' ? 'Agent finished first' : race.outcome.replaceAll('_', ' ')}${race.ranked && race.elapsedMs !== null ? ` \u00b7 ${(race.elapsedMs / 1000).toFixed(1)}s` : ''}` : '';
        const label = g.mode === 'daily' ? `Clawdle ${dailyPuzzleNumber(Date.parse(g.startedAtUtc))} (${g.dailyKey})` : `Clawdle ${g.mode}`;
        return `${label} ${g.status === 'solved' ? g.guesses.length : 'X'}/6\n\n${g.guesses.map(row => row.tiles.map(t => t === 'correct' ? '\u{1F7E9}' : t === 'present' ? '\u{1F7E8}' : '\u2B1B').join('')).join('\n')}${suffix}`;
    }
    answer(gameId = this.state.activeGameId) { const g = gameId ? this.state.games[gameId] : undefined; return g && g.status !== 'playing' ? wordFromId(g.wordId) : null; }
    exportData() { return exportProfile(this.state); }
    dispose() { this.unsubscribe(); this.platform.dispose?.(); this.listeners.clear(); }
}
export async function createController(platform: Platform) { return new AppController(platform).initialize(); }
