import { describe, it, expect } from "vitest";
import { buildRows, replicaHealth } from "../src/admin/models.js";
import type { ModelInfo } from "../src/lib/router.js";
import type { FleetNode } from "../src/lib/fleet.js";

function model(id: string, workers: number | null): ModelInfo {
  return { id, object: "model", ownedBy: "ce-infer", workers };
}

function node(model: string | null, tier: string): FleetNode {
  return {
    nodeId: `n-${Math.random().toString(36).slice(2)}`,
    hostname: "h",
    os: "linux",
    status: "live" as FleetNode["status"],
    tier,
    model,
    runningJobs: 0,
    lastSeenSecs: 0,
    uptimeSecs: 0,
    tags: [],
    capExpiresAt: null,
    site: "site-a",
  };
}

describe("admin pool model — buildRows", () => {
  it("aggregates assigned nodes and tiers per model id", () => {
    const models = [model("clinical-chat", 4), model("code-7b", 2)];
    const nodes = [
      node("clinical-chat", "GpuHeavy"),
      node("clinical-chat", "CpuLow"),
      node("code-7b", "GpuHeavy"),
    ];
    const rows = buildRows(models, nodes);
    const chat = rows.find((r) => r.id === "clinical-chat")!;
    expect(chat.assignedNodes).toBe(2);
    expect(chat.tiers).toEqual(["CpuLow", "GpuHeavy"]); // sorted
    expect(chat.liveWorkers).toBe(4); // router count preferred
    expect(chat.publishedInRouter).toBe(true);
  });

  it("includes registry-only models present in the fleet but not in the router", () => {
    const models: ModelInfo[] = [];
    const nodes = [node("orphan-model", "GpuHeavy"), node("orphan-model", "GpuHeavy")];
    const rows = buildRows(models, nodes);
    const orphan = rows.find((r) => r.id === "orphan-model")!;
    expect(orphan.publishedInRouter).toBe(false);
    // No router count → infer live workers from assigned live fleet nodes.
    expect(orphan.liveWorkers).toBe(2);
    expect(orphan.assignedNodes).toBe(2);
  });

  it("sorts rows by live worker count, descending", () => {
    const rows = buildRows(
      [model("a", 1), model("b", 9), model("c", 5)],
      [],
    );
    expect(rows.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("ignores fleet nodes with no assigned model", () => {
    const rows = buildRows([model("m", 1)], [node(null, "CpuLow")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.assignedNodes).toBe(0);
  });
});

describe("admin pool model — replicaHealth thresholds", () => {
  it("0 workers is bad", () => {
    expect(replicaHealth(0)).toEqual({ cls: "bad", label: "no replicas" });
  });
  it("1-2 workers is warn (low), with singular/plural label", () => {
    expect(replicaHealth(1)).toEqual({ cls: "warn", label: "1 replica (low)" });
    expect(replicaHealth(2)).toEqual({ cls: "warn", label: "2 replicas (low)" });
  });
  it(">= 3 workers is ok", () => {
    expect(replicaHealth(3)).toEqual({ cls: "ok", label: "3 replicas" });
    expect(replicaHealth(10).cls).toBe("ok");
  });
});
