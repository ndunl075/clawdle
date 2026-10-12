// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeVisibleClock } from './visibleClock';

describe('visible game clock', () => {
  let visible: boolean;
  let stop: (() => void) | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
    visible = true;
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden');
  });
  afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });
  function setup(active: boolean, deadline?: number) {
    const started = Date.now();
    const onTime = vi.fn(); const onDay = vi.fn(); const onDeadline = vi.fn();
    stop = observeVisibleClock({ active, deadline, readMono: () => Date.now() - started, onTime, onDay, onDeadline });
    return { onTime, onDay, onDeadline };
  }
  function visibility(value: boolean) { visible = value; document.dispatchEvent(new Event('visibilitychange')); }

  it('has no second-by-second work for an idle or terminal game', () => {
    const events = setup(false);
    vi.advanceTimersByTime(60000);
    expect(events.onTime).not.toHaveBeenCalled();
    expect(events.onDay).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });
  it('stops display updates when hidden and catches up on presentation', () => {
    const events = setup(true);
    vi.advanceTimersByTime(2000);
    expect(events.onTime).toHaveBeenCalledTimes(3);
    visibility(false);
    vi.advanceTimersByTime(60000);
    expect(events.onTime).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    visibility(true);
    expect(events.onTime).toHaveBeenLastCalledWith(62000);
    stop?.(); stop = undefined;
    expect(vi.getTimerCount()).toBe(0);
    window.dispatchEvent(new Event('clawdle-window-presented'));
    expect(events.onTime).toHaveBeenCalledTimes(4);
  });
  it('commits the speedrun deadline once while hidden without periodic writes', () => {
    const events = setup(true, 60000);
    visibility(false);
    vi.advanceTimersByTime(59999);
    expect(events.onDeadline).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(events.onDeadline).toHaveBeenCalledTimes(1);
    expect(events.onTime).toHaveBeenCalledTimes(1);
    visibility(true);
    vi.advanceTimersByTime(5000);
    expect(events.onDeadline).toHaveBeenCalledTimes(1);
  });
  it('does not duplicate a visible deadline and cancels deadlines on disposal', () => {
    const events = setup(true, 2500);
    vi.advanceTimersByTime(2499);
    expect(events.onDeadline).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(events.onDeadline).toHaveBeenCalledTimes(1);
    expect(events.onTime).toHaveBeenLastCalledWith(2500);
    stop?.();
    const cancelled = setup(true, 1000);
    stop?.(); stop = undefined;
    vi.advanceTimersByTime(5000);
    expect(cancelled.onDeadline).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('refreshes the UTC day after a hidden midnight and schedules the next midnight', () => {
    vi.setSystemTime(new Date('2026-10-12T23:59:59Z'));
    const events = setup(false);
    vi.advanceTimersByTime(1000);
    expect(events.onDay).toHaveBeenLastCalledWith(Date.parse('2026-10-13T00:00:00Z'));
    visibility(false);
    vi.advanceTimersByTime(86400000);
    expect(events.onDay).toHaveBeenCalledTimes(2);
    visibility(true);
    expect(events.onDay).toHaveBeenLastCalledWith(Date.parse('2026-10-14T00:00:00Z'));
    expect(vi.getTimerCount()).toBe(1);
  });
});
