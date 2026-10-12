import {dictionaryVersion,scheduleVersion} from '@clawdle/game';
import type { AppState, ResultRow } from './types';
export interface Statistics {
    played: number;
    wins: number;
    losses: number;
    winPercentage: number;
    distribution: number[];
    fastestMs: number | null;
    averageMs: number | null;
    currentStreak: number;
    longestStreak: number;
    neutral: number;
}
const day = (key: string) => Math.floor(Date.parse(key + 'T00:00:00Z') / 86400000);
export function deriveStatistics(state: AppState, mode = 'daily', nowMs = Date.now()): Statistics {
    const rows = state.results.filter(r => r.mode === mode && Number(r.resultId.split(':').at(-1)) > state.statsResetSeq);
    const eligible = rows.filter(r => r.payload.ranked);
    const wins = eligible.filter(r => r.payload.won);
    const distribution = [0, 0, 0, 0, 0, 0];
    for (const r of wins)
        if (r.payload.guessCount > 0 && r.payload.guessCount <= 6)
            distribution[r.payload.guessCount - 1]!++;
    const times = wins.flatMap(r => r.payload.elapsedMs === null ? [] : [r.payload.elapsedMs]);
    const wonDays = [...new Set(wins.flatMap(r => r.payload.dailyKey ? [day(r.payload.dailyKey)] : []))].sort((a, b) => a - b);
    let longestStreak = 0, run = 0, previous = -Infinity;
    for (const d of wonDays) {
        run = d === previous + 1 ? run + 1 : 1;
        longestStreak = Math.max(longestStreak, run);
        previous = d;
    }
    const today = Math.floor(nowMs / 86400000);
    const todayResult = eligible.some(r => r.payload.dailyKey && day(r.payload.dailyKey) === today);
    let cursor = wonDays.includes(today) ? today : todayResult ? today : today - 1;
    let currentStreak = 0;
    while (wonDays.includes(cursor)) {
        currentStreak++;
        cursor--;
    }
    return { played: eligible.length, wins: wins.length, losses: eligible.length - wins.length, winPercentage: eligible.length ? Math.round(wins.length / eligible.length * 100) : 0, distribution, fastestMs: times.length ? Math.min(...times) : null, averageMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null, currentStreak: mode === 'daily' ? currentStreak : 0, longestStreak: mode === 'daily' ? longestStreak : 0, neutral: rows.length - eligible.length };
}
export function equivalentResult(a: ResultRow, b: ResultRow): boolean { return JSON.stringify(a) === JSON.stringify(b); }
export function exportProfile(state: AppState): string {
    // Export historical play only: no live bindings, native metadata, clocks, or credentials.
    return JSON.stringify({ format: 'clawdle-export', version: 1,dictionaryVersion,scheduleVersion, exportedAtUtc: new Date().toISOString(), games: Object.values(state.games).map(({ gameId, mode, rulesVersion, dictionaryVersion, wordId, guesses, status, startedAtUtc, finishedAtUtc, elapsedMs, timingValid, dailyKey, speedrunId }) => ({ gameId, mode, rulesVersion, dictionaryVersion, wordId, guesses, status, startedAtUtc, finishedAtUtc, elapsedMs, timingValid, dailyKey, speedrunId })), results: state.results,races:Object.values(state.races).map(({raceId,gameId,provider,startedAtUtc,endedAtUtc,outcome,guessCountAtEnd,playerSolvedBeforeBoundary,continuedPuzzleSolved,ranked,unrankedReason,elapsedMs})=>({raceId,gameId,provider,startedAtUtc,endedAtUtc,outcome,guessCountAtEnd,playerSolvedBeforeBoundary,continuedPuzzleSolved,ranked,unrankedReason,elapsedMs})),speedruns:Object.values(state.speedruns).map(({speedrunId,durationMs,solved,status,startedAtUtc,finishedAtUtc})=>({speedrunId,durationMs,solved,status:status==='running'?'interrupted':status,startedAtUtc,finishedAtUtc})), settings: state.settings, statsResetSeq: state.statsResetSeq }, null, 2);
}
