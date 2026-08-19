import { describe, it, expect } from "vitest";
import { classifyCorrected, classifyNaive } from "../../src/router/classify.js";
import type { OperationKind } from "../../src/router/types.js";

const ALL_KINDS: OperationKind[] = ["write", "read", "read-after-write", "transaction"];

describe("classifyNaive - the bug, as a pure routing table", () => {
  it("routes writes to primary", () => {
    expect(classifyNaive("write")).toBe("primary");
  });

  it("routes every kind of read - including read-after-write and transaction - to the replica", () => {
    expect(classifyNaive("read")).toBe("replica");
    expect(classifyNaive("read-after-write")).toBe("replica");
    expect(classifyNaive("transaction")).toBe("replica");
  });

  it("is exhaustive over every OperationKind", () => {
    for (const kind of ALL_KINDS) {
      expect(["primary", "replica"]).toContain(classifyNaive(kind));
    }
  });
});

describe("classifyCorrected - the fix, as a pure routing table", () => {
  it("routes writes to primary", () => {
    expect(classifyCorrected("write")).toBe("primary");
  });

  it("routes ordinary reads to the replica", () => {
    expect(classifyCorrected("read")).toBe("replica");
  });

  it("routes read-after-write to primary, unlike the naive table", () => {
    expect(classifyCorrected("read-after-write")).toBe("primary");
  });

  it("routes transactions to primary, unlike the naive table", () => {
    expect(classifyCorrected("transaction")).toBe("primary");
  });

  it("differs from classifyNaive on exactly the two kinds this lab is about", () => {
    const differing = ALL_KINDS.filter((kind) => classifyNaive(kind) !== classifyCorrected(kind));
    expect(differing.sort()).toEqual(["read-after-write", "transaction"]);
  });
});
