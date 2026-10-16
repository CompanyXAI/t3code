// @effect-diagnostics globalDate:off globalTimers:off -- plain Promise queue shared with Node hook callbacks.
/**
 * Approval queue for Cursor agents T3 does not run itself: agents launched
 * from the Cursor agents page onto a Self-Hosted Machines worker. Their
 * project hooks reach the bridge with a `conversation_id` that no T3 thread
 * owns; the bridge's fallback parks them here until the user answers on the
 * agents page.
 *
 * @module provider-cursor/server/CursorWorkerApprovals
 */
import type { CursorApprovalDecision, CursorApprovalQuestion } from "./CursorHookBridge.ts";

export interface CursorWorkerApproval {
  readonly id: string;
  readonly agentId: string | null;
  readonly question: CursorApprovalQuestion;
  readonly createdAt: string;
}

export interface CursorWorkerApprovals {
  /** Bridge fallback: waits for the user's answer, or `null` for neutral. */
  readonly ask: (question: CursorApprovalQuestion) => Promise<CursorApprovalDecision | null>;
  readonly pending: () => ReadonlyArray<CursorWorkerApproval>;
  /** `false` when the request is gone (answered, or the hook timed out). */
  readonly respond: (id: string, decision: CursorApprovalDecision) => boolean;
  /** Called whenever the pending list changes. */
  readonly subscribe: (listener: () => void) => () => void;
}

export function makeCursorWorkerApprovals(options?: {
  readonly now?: () => Date;
  /** Seconds before an unanswered request is denied; matches the hook timeout. */
  readonly timeoutMs?: number;
}): CursorWorkerApprovals {
  const now = options?.now ?? (() => new Date());
  const timeoutMs = options?.timeoutMs ?? 3_590_000;
  const waiting = new Map<
    string,
    CursorWorkerApproval & { readonly resolve: (decision: CursorApprovalDecision) => void }
  >();
  const listeners = new Set<() => void>();
  let counter = 0;
  const changed = () => {
    for (const listener of listeners) listener();
  };

  const respond = (id: string, decision: CursorApprovalDecision) => {
    const entry = waiting.get(id);
    if (entry === undefined) return false;
    waiting.delete(id);
    entry.resolve(decision);
    changed();
    return true;
  };

  return {
    ask: (question) => {
      // Only hooks with an agent id come from a Cursor agent run; anything
      // else is not ours to answer.
      if (question.conversationId === undefined) return Promise.resolve(null);
      const id = `worker-approval-${++counter}`;
      return new Promise<CursorApprovalDecision>((resolve) => {
        const timer = setTimeout(() => respond(id, "deny"), timeoutMs);
        waiting.set(id, {
          id,
          agentId: question.conversationId ?? null,
          question,
          createdAt: now().toISOString(),
          resolve: (decision) => {
            clearTimeout(timer);
            resolve(decision);
          },
        });
        changed();
      });
    },
    pending: () => [...waiting.values()].map(({ resolve: _resolve, ...approval }) => approval),
    respond,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
