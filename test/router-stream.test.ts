import { describe, it, expect } from "vitest";
import { RouterClient } from "../src/lib/router.js";

/** Build a fetch that returns the given SSE chunks as a streaming response body. */
function sseFetch(chunks: string[], status = 200): typeof fetch {
  return (async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    });
    return new Response(status === 200 ? body : "router down", {
      status,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
}

function dataFrame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

describe("RouterClient.streamCompletion", () => {
  it("yields token deltas in order and surfaces worker + model provenance", async () => {
    const fetchImpl = sseFetch([
      dataFrame({ model: "clinical-chat-8b", worker: "node-7", choices: [{ delta: { role: "assistant" } }] }),
      dataFrame({ choices: [{ delta: { content: "Hel" } }] }),
      dataFrame({ choices: [{ delta: { content: "lo" } }] }),
      dataFrame({ choices: [{ delta: { content: " world" }, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]);
    const client = new RouterClient("http://router.lan", fetchImpl);
    const out = [];
    for await (const ch of client.streamCompletion({
      model: "clinical-chat",
      op: "chat",
      messages: [{ role: "user", content: "hi" }],
    })) {
      out.push(ch);
    }
    const text = out.map((c) => c.delta).join("");
    expect(text).toBe("Hello world");
    // Provenance latched from whichever frame carried it.
    expect(out.find((c) => c.worker)?.worker).toBe("node-7");
    expect(out.find((c) => c.model)?.model).toBe("clinical-chat-8b");
    expect(out[out.length - 1]!.finishReason).toBe("stop");
  });

  it("handles SSE frames split across read boundaries", async () => {
    const frame = dataFrame({ choices: [{ delta: { content: "chunked" } }] });
    const mid = Math.floor(frame.length / 2);
    const fetchImpl = sseFetch([frame.slice(0, mid), frame.slice(mid), "data: [DONE]\n\n"]);
    const client = new RouterClient("http://router.lan", fetchImpl);
    const out = [];
    for await (const ch of client.streamCompletion({
      model: "clinical-chat",
      op: "chat",
      messages: [],
    })) {
      out.push(ch.delta);
    }
    expect(out.join("")).toBe("chunked");
  });

  it("throws a descriptive error on a non-2xx completion", async () => {
    const client = new RouterClient("http://router.lan", sseFetch([], 503));
    await expect(async () => {
      for await (const _ of client.streamCompletion({ model: "m", op: "chat", messages: [] })) {
        void _;
      }
    }).rejects.toThrow(/completion failed \(503\)/);
  });

  it("sends the X-CE-Op header and stream:true body", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      capturedInit = init;
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const client = new RouterClient("http://router.lan", fetchImpl);
    for await (const _ of client.streamCompletion({
      model: "code-7b",
      op: "code",
      messages: [{ role: "user", content: "x" }],
      recordRef: "abc123",
    })) {
      void _;
    }
    const headers = capturedInit!.headers as Record<string, string>;
    expect(headers["X-CE-Op"]).toBe("code");
    expect(headers["X-CE-Record-Ref"]).toBe("abc123");
    const sent = JSON.parse(capturedInit!.body as string) as { stream: boolean; model: string };
    expect(sent.stream).toBe(true);
    expect(sent.model).toBe("code-7b");
  });
});
