import type { Platform, Command, JournalEntry, AppState, ResultRow, Checkpoint, Snapshot } from '@clawdle/app-core';
export interface DesktopBindings {
    invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
    listen: (event: string, handler: () => void) => Promise<() => void>;
    clipboard?: (text: string) => Promise<void>;
}
export function createDesktopPlatform(bindings: DesktopBindings): Platform {
    return {
        snapshot: () => bindings.invoke<Snapshot>('runtime_snapshot'), append: (eventId: string, command: Command) => bindings.invoke<JournalEntry>('journal_append', { eventId, command }), read: (afterSeq: number) => bindings.invoke<JournalEntry[]>('journal_read', { afterSeq, limit: 10000 }), commit: (expectedVersion: number, state: AppState, results: ResultRow[]) => bindings.invoke<Checkpoint>('checkpoint_commit', { expectedVersion, processedSeq: state.processedSeq, state, results }), subscribe: listener => bindings.listen('journal-updated', listener), claimEffect: effectId => bindings.invoke<boolean>('effect_claim', { effectId }), randomUnit: () => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0]! / 4294967296; }, id: () => crypto.randomUUID(), clipboard: bindings.clipboard ?? (text => bindings.invoke<void>('native_clipboard', { text })), alwaysOnTop: enabled => bindings.invoke<void>('native_always_on_top', { enabled }), showWindow: explicit => bindings.invoke<void>('native_show', { explicit }), notify: (title, body) => bindings.invoke<void>('native_notify', { title, body })
    };
}
export interface IntegrationDoctor {
    protocolVersion: 1;
    tokenPresent: boolean;
    receiverAvailable: boolean;
    ownedUserHandlers: number;
    installed: boolean;
    claudeVersion: string | null;
    compatibility: string;
}
export function desktopIntegration(bindings: DesktopBindings) { return { doctor: () => bindings.invoke<IntegrationDoctor>('integration_doctor'), install: (scope: 'user' | 'project', project?: string) => bindings.invoke('integration_install', { scope, project }), uninstall: (scope: 'user' | 'project' = 'user', project?: string) => bindings.invoke('integration_uninstall', { scope, project }) }; }
