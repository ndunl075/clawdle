import type { Puzzle, Race, Speedrun as EngineSpeedrun } from '@clawdle/game';
export interface JournalEntry {
    seq: number;
    eventId: string;
    runtimeEpoch: string;
    receivedAtUtc: string;
    receivedMonoMs: number;
    kind: 'command' | 'agent' | 'runtime';
    payload: unknown;
}
export interface ResultRow {
    resultId: string;
    identity: string;
    mode: string;
    payload: {
        outcome: string;
        won: boolean;
        guessCount: number;
        elapsedMs: number | null;
        dailyKey: string | null;
        ranked: boolean;
        finishedAtUtc: string;
    };
}
export interface Checkpoint {
    stateVersion: number;
    processedSeq: number;
    state: AppState;
}
export interface Snapshot {
    runtimeEpoch: string;
    receivedMonoMs: number;
    receivedAtUtc: string;
    latestSeq: number;
    checkpoint: Checkpoint | null;
}
export interface Platform {
    snapshot(): Promise<Snapshot>;
    append(eventId: string, command: Command): Promise<JournalEntry>;
    read(afterSeq: number): Promise<JournalEntry[]>;
    commit(expectedVersion: number, state: AppState, results: ResultRow[]): Promise<Checkpoint>;
    subscribe(listener: () => void): Promise<() => void>;
    randomUnit(): number;
    id(): string;
    claimEffect?(id: string): Promise<boolean>;
    clipboard?(text: string): Promise<void>;
    showWindow?(explicit: boolean): Promise<void>;
    alwaysOnTop?(enabled: boolean): Promise<void>;
    notify?(title: string, body: string): Promise<void>;
    readonly?: boolean;
    dispose?(): void;
}
export interface Settings {
    autoRace: boolean;
    sound: boolean;
    highContrast: boolean;
    reducedMotion: boolean;
    speedrunEnabled: boolean;
    alwaysOnTop: boolean;
}
export interface Speedrun extends EngineSpeedrun {
    speedrunId: string;
    durationMs: number;
    deadlineMonoMs: number;
    runtimeEpoch: string;
    solved: number;
    status: 'running' | 'finished' | 'interrupted';
    startedAtUtc: string;
    finishedAtUtc: string | null;
}
export interface AppState {
    schemaVersion: 1;
    stateVersion: number;
    processedSeq: number;
    activeGameId: string | null;
    activeRaceId: string | null;
    activeSpeedrunId: string | null;
    games: Record<string, Puzzle>;
    races: Record<string, Race>;
    speedruns: Record<string, Speedrun>;
    results: ResultRow[];
    recentWordIds: string[];
    settings: Settings;
    feedback: string | null;
    statsResetSeq: number;
    dataResetSeq: number;
    gameAnchors: Record<string, {
        runtimeEpoch: string;
        monoMs: number;
    }>;
    quarantinedGames: Record<string, unknown>;
    agentStatuses: Record<string, {
        provider: string;
        sessionId: string;
        turnId: string | null;
        status: string;
        lastSeq: number;
    }>;
    tombstones: string[];
}
export type Command = ({
    type: 'startDaily';
} | {
    type: 'startEndless';
} | {
    type: 'submitGuess';
    word: string;
} | {
    type: 'giveUp';
} | {
    type: 'presentRace';
    raceId: string;
    lateJoin?: boolean;
} | {
    type: 'leaveRace';
} | {
    type: 'startSpeedrun';
} | {
    type: 'skipWord';
} | {
    type: 'tick';
} | {
    type: 'interruptTiming';
} | {
    type: 'changeSettings';
    settings: Partial<Settings>;
} | {
    type: 'resetStatistics';
    confirmed: true;
} | {
    type: 'resetAll';
    confirmed: true;
}) & {
    randomUnit?: number;
};
export function emptyState(): AppState { return { schemaVersion: 1, stateVersion: 0, processedSeq: 0, activeGameId: null, activeRaceId: null, activeSpeedrunId: null, games: {}, races: {}, speedruns: {}, results: [], recentWordIds: [], settings: { autoRace: false, sound: false, highContrast: false, reducedMotion: false, speedrunEnabled: false, alwaysOnTop: false }, feedback: null, statsResetSeq: 0, dataResetSeq: 0, gameAnchors: {}, quarantinedGames: {}, agentStatuses: {}, tombstones: [] }; }
