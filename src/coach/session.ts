import { Chess } from 'chess.js';
import { useSettings } from '../settings';
import type { AiProfile } from '../ai/types';
import type { Actor, Side } from '../game/types';
import type { CoachConfig } from './types';
import {
  buildCoachReviewPrompt,
  buildCoachSummaryPrompt,
  buildCoachSystemPrompt,
  buildHintPrompt,
  buildHintSystemPrompt,
  buildSummarySystemPrompt,
  parseCoachReview,
  parseHint,
  parseSummary,
} from './prompt';
import { requestCoach } from './request';
import type { CoachReply } from './request';

/**
 * One coach card about one position: the verdict on the move that was just
 * played (or the explanation the engine itself gave for it), the read of the
 * position, or the suggestion the user asked for.
 */
export interface CoachEntry {
  id: number;
  kind: 'review' | 'hint';
  /** Full move-log index, including edit markers; used to drop stale entries on undo. */
  ply: number;
  number: number;
  side: Side;
  /** The move under review, or the suggested move for a hint (null when unusable). */
  san: string | null;
  /** Verdict on the move (review), or the reason for the suggestion (hint). */
  verdict: string | null;
  /** Read of the position; review entries only. */
  read: string | null;
  error: string | null;
  notice?: string | null;
  elapsedMs: number;
  /** The request behind this card is still queued or in flight. */
  pending: boolean;
  /** A queued review was deliberately skipped, rather than failing at the API. */
  skipReason?: string | null;
  /** Which paragraphs this card will end up having, so placeholders are honest. */
  expects: { verdict: boolean; read: boolean };
}

export interface CoachSummary {
  state: 'running' | 'done' | 'failed';
  text: string | null;
  error: string | null;
  notice?: string | null;
}

type CoachJob =
  | {
      kind: 'review';
      /** The card this job fills in; created when the request was queued. */
      entryId: number;
      afterFen: string;
      before: { fen: string; moves: string[] } | null;
      move: { number: number; side: Side; san: string };
      fields: { review: boolean; position: boolean };
    }
  | { kind: 'hint'; entryId: number; fen: string; side: Side; history: string }
  | { kind: 'summary'; sanLine: string; startFen: string; result: string };

/** The side the coach speaks to: the single human, or `null` when both sides are. */
function studentSideOf(players: { w: Actor; b: Actor }): Side | null {
  if (players.w === 'human' && players.b !== 'human') return 'w';
  if (players.b === 'human' && players.w !== 'human') return 'b';
  return null;
}

interface CoachState {
  coach: CoachConfig;
  players: { w: Actor; b: Actor };
  gameProfiles: { w: AiProfile; b: AiProfile; coach: AiProfile };
  coachLog: CoachEntry[];
  hintBusy: boolean;
  coachSummary: CoachSummary | null;
}

type SetCoach = (patch: Partial<CoachState> | ((state: CoachState) => Partial<CoachState>)) => void;

/** Release the queue immediately on cancellation, even if transport cleanup is slow. */
function waitForCoachReply(pending: Promise<CoachReply>, signal: AbortSignal): Promise<CoachReply | null> {
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(null);
    if (signal.aborted) resolve(null);
    else signal.addEventListener('abort', onAbort, { once: true });
    // Attach both handlers even after cancellation: a late rejection must be
    // observed, but it must never write back into a newer game or summary.
    pending.then((reply) => {
      signal.removeEventListener('abort', onAbort);
      resolve(reply);
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

/** A cancellable queue whose lifetime belongs to one game store. */
export function createCoachSession(get: () => CoachState, set: SetCoach) {
  let coachQueue: CoachJob[] = [];
  let coachAbort: AbortController | null = null;
  let coachToken = 0;
  let coachEntrySeq = 0;
  let coachDraining = false;
  let coachRunning: CoachJob | null = null;
  function pushCoachEntry(entry: Omit<CoachEntry, 'id'>): number {
    coachEntrySeq += 1;
    const id = coachEntrySeq;
    set((state) => {
      const entries = [...state.coachLog, { ...entry, id }];
      // Keep every pending card, including a full backlog the user chose to
      // retain. Only completed cards outside the recent history may be pruned.
      return { coachLog: entries.filter((item, index) => item.pending || index >= entries.length - 60) };
    });
    const visible = new Set(get().coachLog.map((entry) => entry.id));
    coachQueue = coachQueue.filter((job) => job.kind === 'summary' || visible.has(job.entryId));
    return id;
  }

  function patchCoachEntry(id: number, patch: Partial<CoachEntry>): void {
    set((state) => ({
      coachLog: state.coachLog.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
    }));
  }

  /** Drop cards whose request was cancelled, so nothing spins forever. */
  function dropPendingEntries(): void {
    set((state) => ({ coachLog: state.coachLog.filter((entry) => !entry.pending) }));
  }

  function syncHintBusy(): void {
    const busy = coachRunning?.kind === 'hint' || coachQueue.some((job) => job.kind === 'hint');
    if (get().hintBusy !== busy) set({ hintBusy: busy });
  }

  function interruptCoachRequest(): void {
    if (coachAbort) {
      coachAbort.abort();
      coachAbort = null;
    }
    coachToken += 1;
    coachRunning = null;
  }

  /** Drop every queued or running coach request (new game, setup, pause, undo). */
  function cancelPendingCoach(skipReason?: string): void {
    coachQueue = [];
    interruptCoachRequest();
    syncHintBusy();
    if (skipReason) {
      set((state) => ({ coachLog: state.coachLog.map((entry) => entry.pending
        ? { ...entry, pending: false, error: null, skipReason }
        : entry) }));
    } else dropPendingEntries();
    if (get().coachSummary?.state === 'running') set({ coachSummary: null });
  }

  /** A move landed, so any pending suggestion is about a position that is gone. */
  function dropPendingHints(): void {
    coachQueue = coachQueue.filter((job) => job.kind !== 'hint');
    if (coachRunning?.kind === 'hint') interruptCoachRequest();
    syncHintBusy();
    set((state) => ({
      coachLog: state.coachLog.filter((entry) => !(entry.pending && entry.kind === 'hint')),
    }));
  }

  function queueCoach(job: CoachJob, front = false): void {
    if (!get().coach.enabled) return;
    if (job.kind === 'summary') {
      if (get().coach.skipBacklog) {
        cancelPendingCoach('对局已结束，跳过未完成点评，优先生成整局简评');
      } else {
        // Summarize immediately, then resume all retained move reviews. The
        // interrupted review restarts with the exact position it was about.
        if (coachRunning?.kind === 'review') coachQueue.unshift(coachRunning);
        coachQueue = coachQueue.filter((item) => item.kind === 'review');
        interruptCoachRequest();
        dropPendingHints();
      }
      // Make the summary visible while cancelled transport work unwinds.
      set({ coachSummary: { state: 'running', text: null, error: null } });
      front = true;
    }
    if (front) coachQueue.unshift(job);
    else coachQueue.push(job);
    while (get().coach.skipBacklog && coachQueue.length > 8) {
      const index = coachQueue.findIndex((item) => item.kind === 'review');
      if (index < 0) break;
      const removed = coachQueue.splice(index, 1)[0];
      if (removed && removed.kind !== 'summary') {
        patchCoachEntry(removed.entryId, { pending: false, error: null, skipReason: '后续局面已更新，跳过积压点评' });
      }
    }
    syncHintBusy();
    void pumpCoach();
  }

  async function pumpCoach(): Promise<void> {
    if (coachDraining) return;
    coachDraining = true;
    try {
      for (;;) {
        const job = coachQueue.shift();
        if (!job) break;
        if (!get().coach.enabled) continue;
        if (job.kind !== 'summary' && !get().coachLog.some((entry) => entry.id === job.entryId && entry.pending)) continue;
        try {
          await runCoachJob(job);
        } catch (error) {
          // A coach failure must never escape as an unhandled rejection: the
          // game has no reason to care about it.
          console.warn('coach request failed', error);
        }
      }
    } finally {
      coachDraining = false;
      coachRunning = null;
      syncHintBusy();
    }
  }

  async function runCoachJob(job: CoachJob): Promise<void> {
    const settings = useSettings.getState().settings;
    const profile = get().gameProfiles.coach;
    const lang = settings.ui.commentaryLang;
    const studentSide = studentSideOf(get().players);
    const controller = new AbortController();
    coachAbort = controller;
    coachRunning = job;
    const token = (coachToken += 1);
    const isCurrent = () => token === coachToken && !controller.signal.aborted;
    syncHintBusy();
    if (job.kind === 'summary') {
      set({ coachSummary: { state: 'running', text: null, error: null } });
    }

    try {
      let system = '';
      let user = '';
      if (job.kind === 'review') {
        system = buildCoachSystemPrompt({ studentSide, lang, fields: job.fields });
        user = buildCoachReviewPrompt({
          // The legal-move list of the previous position is only needed when the
          // coach has to name a better move.
          before: job.fields.review ? job.before : null,
          move: job.move,
          after: new Chess(job.afterFen, { skipValidation: true }),
        });
      } else if (job.kind === 'hint') {
        const chess = new Chess(job.fen, { skipValidation: true });
        system = buildHintSystemPrompt({ side: job.side, lang });
        user = buildHintPrompt({ chess, side: job.side, history: job.history });
      } else {
        system = buildSummarySystemPrompt({ studentSide, lang });
        user = buildCoachSummaryPrompt({
          startFen: job.startFen,
          sanLine: job.sanLine,
          result: job.result,
          lang,
        });
      }

      const reply = await waitForCoachReply(requestCoach({
        cfg: profile.config,
        system,
        user,
        signal: controller.signal,
      }), controller.signal);
      if (!reply || !isCurrent()) return;
      const notice = reply.notices?.join('；') || null;

      if (job.kind === 'summary') {
        set({
          coachSummary: reply.ok
            ? { state: 'done', text: parseSummary(reply.text), error: null, notice }
            : { state: 'failed', text: null, error: reply.error ?? '教练请求失败', notice },
        });
        return;
      }

      if (job.kind === 'hint') {
        const hint = reply.ok
          ? parseHint(reply.text, new Chess(job.fen, { skipValidation: true }))
          : { san: null, why: '' };
        patchCoachEntry(job.entryId, {
          san: reply.ok ? hint.san : null,
          verdict: reply.ok ? hint.why || null : null,
          error: reply.ok ? null : (reply.error ?? '教练请求失败'),
          notice,
          elapsedMs: reply.elapsedMs,
          pending: false,
        });
        return;
      }

      const parsed = reply.ok
        ? parseCoachReview(reply.text, job.fields)
        : { moveReview: null, positionRead: null };
      const patch: Partial<CoachEntry> = {
        error: reply.ok ? null : (reply.error ?? '教练请求失败'),
        notice,
        elapsedMs: reply.elapsedMs,
        pending: false,
      };
      // Only overwrite what this request actually asked for: the engine's own
      // explanation of its move is already on the card and must survive.
      if (job.fields.review) patch.verdict = parsed.moveReview;
      if (job.fields.position) patch.read = parsed.positionRead;
      patchCoachEntry(job.entryId, patch);
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : String(error);
      if (job.kind === 'summary') {
        set({ coachSummary: { state: 'failed', text: null, error: message } });
      } else {
        patchCoachEntry(job.entryId, { error: message, pending: false });
      }
    } finally {
      if (coachAbort === controller) coachAbort = null;
      coachRunning = null;
      syncHintBusy();
    }
  }

  return { pushCoachEntry, cancelPendingCoach, dropPendingHints, queueCoach };
}
