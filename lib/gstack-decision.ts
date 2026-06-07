/**
 * gstack-decision — event-sourced institutional decision memory.
 *
 * decisions.jsonl is an APPEND-ONLY EVENT LOG (not mutable rows): `decide`,
 * `supersede`, and `redact` events. "Active" is COMPUTED — a `decide` whose id is
 * not later referenced by a `supersede`/`redact`. This is the eng-review event-
 * sourcing decision (a mutable `status` field would contradict append-only).
 *
 * Built on lib/jsonl-store.ts (shared injection-reject + atomic append + tolerant
 * read). Free-text fields are injection-checked AND redact-scanned on write
 * (HIGH-tier secret → reject), so a secret never silently persists and resurfaced
 * text can't carry instructions. gbrain is never required — this is the reliable
 * file-only core; semantic recall is a later, optional enhancement.
 */

import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { appendJsonl, readJsonl, hasInjection } from "./jsonl-store";
import { scan } from "./redact-engine";

export type DecisionKind = "decide" | "supersede" | "redact";
export type DecisionScope = "repo" | "branch" | "issue";
export type DecisionSource = "user" | "skill" | "agent";

export const DECISION_SCOPES: readonly DecisionScope[] = ["repo", "branch", "issue"];
export const DECISION_SOURCES: readonly DecisionSource[] = ["user", "skill", "agent"];

export interface DecisionEvent {
  id: string;
  kind: DecisionKind;
  decision?: string;
  rationale?: string;
  alternatives_considered?: string;
  /** For supersede/redact: the id of the `decide` event being acted on. */
  supersedes?: string;
  scope: DecisionScope;
  branch?: string;
  issue?: string;
  date: string;
  session?: string;
  source: DecisionSource;
  confidence?: number;
}

export interface ActiveDecision extends DecisionEvent {
  kind: "decide";
}

export interface DecisionPaths {
  log: string;
  snapshot: string;
  archive: string;
}

/** Resolve the per-project decision store paths. Bins pass slug + GSTACK_HOME. */
export function decisionPaths(slug: string, gstackHome?: string): DecisionPaths {
  const home = gstackHome || process.env.GSTACK_HOME || join(homedir(), ".gstack");
  const dir = join(home, "projects", slug || "unknown");
  return {
    log: join(dir, "decisions.jsonl"),
    snapshot: join(dir, "decisions.active.json"),
    archive: join(dir, "decisions.archive.jsonl"),
  };
}

export type ValidateResult =
  | { ok: true; event: DecisionEvent }
  | { ok: false; error: string };

/**
 * Validate + stamp a `decide` event. Rejects (no silent persist) on:
 *  - missing/empty decision text or invalid scope/source,
 *  - injection-like content in any free-text field (datamark-on-write),
 *  - a HIGH-tier secret (redact engine) in any free-text field.
 */
export function validateDecide(input: Partial<DecisionEvent>): ValidateResult {
  if (!input.decision || typeof input.decision !== "string" || !input.decision.trim()) {
    return { ok: false, error: "decision text is required" };
  }
  const scope = input.scope ?? "repo";
  if (!DECISION_SCOPES.includes(scope)) {
    return { ok: false, error: `invalid scope "${scope}"; must be ${DECISION_SCOPES.join("|")}` };
  }
  const source = input.source ?? "agent";
  if (!DECISION_SOURCES.includes(source)) {
    return { ok: false, error: `invalid source "${source}"; must be ${DECISION_SOURCES.join("|")}` };
  }
  if (input.confidence !== undefined) {
    const c = Number(input.confidence);
    if (!Number.isInteger(c) || c < 1 || c > 10) {
      return { ok: false, error: "confidence must be integer 1-10" };
    }
  }

  const freeText = [input.decision, input.rationale, input.alternatives_considered]
    .filter((s): s is string => typeof s === "string")
    .join("\n");

  if (hasInjection(freeText)) {
    return { ok: false, error: "decision contains instruction-like content (injection), rejected" };
  }
  const redacted = scan(freeText);
  if (redacted.counts.HIGH > 0) {
    return {
      ok: false,
      error: `decision contains a HIGH-tier secret (${redacted.counts.HIGH} finding(s)); rotate + remove it, do not log secrets`,
    };
  }

  const event: DecisionEvent = {
    id: input.id || randomUUID(),
    kind: "decide",
    decision: input.decision.trim(),
    rationale: input.rationale,
    alternatives_considered: input.alternatives_considered,
    scope,
    branch: scope === "branch" ? input.branch : input.branch || undefined,
    issue: scope === "issue" ? input.issue : input.issue || undefined,
    date: input.date || new Date().toISOString(),
    session: input.session,
    source,
    confidence: input.confidence === undefined ? undefined : Number(input.confidence),
  };
  return { ok: true, event };
}

/** Build a supersede/redact event referencing an existing decide-event id. */
export function makeRefEvent(kind: "supersede" | "redact", targetId: string, opts: { session?: string; source?: DecisionSource } = {}): DecisionEvent {
  return {
    id: randomUUID(),
    kind,
    supersedes: targetId,
    scope: "repo",
    date: new Date().toISOString(),
    session: opts.session,
    source: opts.source ?? "agent",
  };
}

/**
 * Compute the ACTIVE decisions: `decide` events whose id is NOT referenced by any
 * later `supersede`/`redact`. Dangling refs (supersede/redact pointing at an id
 * that has no `decide`) are tolerated — ignored, never thrown. Returned in date
 * order (oldest first).
 */
export function computeActive(events: DecisionEvent[]): ActiveDecision[] {
  const retired = new Set<string>();
  for (const e of events) {
    if ((e.kind === "supersede" || e.kind === "redact") && e.supersedes) {
      retired.add(e.supersedes); // dangling target id is harmless — just a no-op
    }
  }
  return events
    .filter((e): e is ActiveDecision => e.kind === "decide" && !retired.has(e.id))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Scope filter for resurfacing: repo-scoped decisions always apply; branch-scoped
 * only when the branch matches the current context; issue-scoped only when the
 * issue matches. (Recency != relevance — callers filter by scope, not just date.)
 */
export function filterByScope(active: ActiveDecision[], ctx: { branch?: string; issue?: string }): ActiveDecision[] {
  return active.filter((d) => {
    if (d.scope === "repo") return true;
    if (d.scope === "branch") return !!ctx.branch && d.branch === ctx.branch;
    if (d.scope === "issue") return !!ctx.issue && d.issue === ctx.issue;
    return true;
  });
}

/** Append a validated event atomically (single-line, concurrency-safe). */
export function appendEvent(paths: DecisionPaths, event: DecisionEvent): void {
  appendJsonl(paths.log, event);
}

/** Read all events tolerantly (skips malformed/partial-tail lines). */
export function readEvents(paths: DecisionPaths): DecisionEvent[] {
  return readJsonl<DecisionEvent>(paths.log);
}
