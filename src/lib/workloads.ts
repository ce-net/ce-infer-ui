/**
 * The three clinical workloads the staff chat exposes. Each maps to:
 *  - an `op` sent as the `X-CE-Op` header (chat|summarize|code), which the router
 *    audits and uses for capability ability selection (infer:chat|summarize|code),
 *  - a logical model alias the router resolves to a live worker via the atlas,
 *  - an optional system prompt template (summarize injects a redaction-safe template).
 *
 * Model aliases follow PLAN §09: clinical-chat (chat/summarize role, 8b everywhere) and
 * code-7b (code role). Summarize reuses clinical-chat with a summarization system prompt.
 */

export type Op = "chat" | "summarize" | "code";

export interface Workload {
  op: Op;
  label: string;
  /** Logical model alias the router resolves against live atlas workers. */
  model: string;
  /** Short helper line shown under the selector. */
  hint: string;
  /** Optional system prompt prepended to the thread for this workload. */
  systemPrompt?: string;
  /** Render the composer/output in monospace (code mode). */
  mono: boolean;
}

const SUMMARIZE_SYSTEM =
  "You are a clinical documentation assistant. Produce a concise, faithful summary of " +
  "the clinical note or document the user provides. Do not invent findings, diagnoses, " +
  "medications, or values that are not present in the source. Preserve clinically " +
  "significant negatives. If the source is ambiguous, say so rather than guessing. " +
  "Output only the summary.";

const CODE_SYSTEM =
  "You are an internal coding assistant for hospital IT and informatics staff. Give " +
  "correct, minimal, well-commented code and explain trade-offs briefly. Do not include " +
  "patient data in examples.";

export const WORKLOADS: Record<Op, Workload> = {
  chat: {
    op: "chat",
    label: "Clinical Q&A",
    model: "clinical-chat",
    hint: "Ask a clinical question. Streamed from an on-prem worker.",
    mono: false,
  },
  summarize: {
    op: "summarize",
    label: "Summarize a document",
    model: "clinical-chat",
    hint: "Paste a clinical note or document. Output is AI-generated — verify against source.",
    systemPrompt: SUMMARIZE_SYSTEM,
    mono: false,
  },
  code: {
    op: "code",
    label: "Coding",
    model: "code-7b",
    hint: "Internal coding assistant. Routes to code-7b workers.",
    systemPrompt: CODE_SYSTEM,
    mono: true,
  },
};

export const OP_ORDER: Op[] = ["chat", "summarize", "code"];
