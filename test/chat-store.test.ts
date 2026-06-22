import { describe, it, expect, beforeEach } from "vitest";
import { ChatStore } from "../src/stores/chat.js";
import { WORKLOADS } from "../src/lib/workloads.js";
import type { StreamChunk } from "../src/lib/router.js";

/** A fake RouterClient that yields a fixed stream of chunks for send() tests. */
function fakeRouter(chunks: StreamChunk[], opts: { capture?: (o: unknown) => void } = {}) {
  return {
    async health() {
      return { ok: true, workers: 2, version: "test" };
    },
    async models() {
      return [{ id: "clinical-chat", object: "model", ownedBy: "ce-infer", workers: 2 }];
    },
    async *streamCompletion(o: unknown) {
      opts.capture?.(o);
      for (const c of chunks) yield c;
    },
  };
}

function chunk(delta: string, extra: Partial<StreamChunk> = {}): StreamChunk {
  return { delta, worker: null, model: null, finishReason: null, ...extra };
}

describe("ChatStore chat-mode switch", () => {
  let store: ChatStore;
  beforeEach(() => {
    localStorage.clear();
    store = new ChatStore();
  });

  it("defaults to the 'chat' workload", () => {
    expect(store.state.op).toBe("chat");
  });

  it("setOp switches mode and is a no-op when unchanged", () => {
    let hits = 0;
    store.subscribe(() => hits++);
    store.setOp("code");
    expect(store.state.op).toBe("code");
    expect(hits).toBe(1);
    store.setOp("code"); // unchanged → no emit
    expect(hits).toBe(1);
    store.setOp("summarize");
    expect(store.state.op).toBe("summarize");
    expect(hits).toBe(2);
  });

  it("each workload maps to a model alias and the code workload is monospace", () => {
    expect(WORKLOADS.chat.model).toBe("clinical-chat");
    expect(WORKLOADS.summarize.model).toBe("clinical-chat");
    expect(WORKLOADS.code.model).toBe("code-7b");
    expect(WORKLOADS.code.mono).toBe(true);
    expect(WORKLOADS.summarize.systemPrompt).toBeTruthy();
  });
});

describe("ChatStore streaming token render", () => {
  let store: ChatStore;
  beforeEach(() => {
    localStorage.clear();
    store = new ChatStore();
  });

  it("appends user + assistant turns and grows the assistant text token by token", async () => {
    (store as unknown as { router: unknown }).router = fakeRouter([
      chunk("Hel", { worker: "node-3", model: "clinical-chat-8b" }),
      chunk("lo"),
      chunk(" there", { finishReason: "stop" }),
    ]);

    await store.send("What is sepsis?");

    expect(store.state.turns).toHaveLength(2);
    const [user, asst] = store.state.turns;
    expect(user!.role).toBe("user");
    expect(user!.text).toBe("What is sepsis?");
    expect(asst!.role).toBe("assistant");
    expect(asst!.text).toBe("Hello there");
    expect(asst!.streaming).toBe(false);
    expect(asst!.worker).toBe("node-3");
    expect(asst!.model).toBe("clinical-chat-8b");
    expect(asst!.error).toBeNull();
    expect(store.state.busy).toBe(false);
  });

  it("carries the active workload op onto the turn and uses its model alias", async () => {
    let sentModel: string | undefined;
    (store as unknown as { router: unknown }).router = fakeRouter([chunk("def foo(): ...")], {
      capture: (o) => {
        sentModel = (o as { model: string }).model;
      },
    });
    store.setOp("code");
    await store.send("write a function");
    expect(sentModel).toBe("code-7b");
    expect(store.state.turns[1]!.op).toBe("code");
  });

  it("ignores empty input and refuses concurrent sends while busy", async () => {
    (store as unknown as { router: unknown }).router = fakeRouter([chunk("ok")]);
    await store.send("   "); // whitespace only
    expect(store.state.turns).toHaveLength(0);
  });

  it("records a streaming error onto the assistant turn", async () => {
    (store as unknown as { router: unknown }).router = {
      async *streamCompletion() {
        throw new Error("worker unreachable");
        // eslint-disable-next-line no-unreachable
        yield chunk("");
      },
    };
    await store.send("hello");
    const asst = store.state.turns[1]!;
    expect(asst.streaming).toBe(false);
    expect(asst.error).toBe("worker unreachable");
    expect(store.state.busy).toBe(false);
  });

  it("wipeTranscript clears all turns (no persistence)", async () => {
    (store as unknown as { router: unknown }).router = fakeRouter([chunk("hi")]);
    await store.send("hello");
    expect(store.state.turns.length).toBeGreaterThan(0);
    store.wipeTranscript();
    expect(store.state.turns).toHaveLength(0);
    expect(store.state.busy).toBe(false);
  });
});
