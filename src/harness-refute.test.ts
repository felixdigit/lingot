import { describe, it, expect } from "vitest";
import { refuteOutput, type RefuteRunner } from "./harness-refute";

function fakeRunner(replies: string[]): RefuteRunner {
  let i = 0;
  return async () => {
    const text = replies[i] ?? replies[replies.length - 1] ?? "";
    i += 1;
    return { text, exit: 0 };
  };
}

describe("refuteOutput", () => {
  it("kills on majority refute", async () => {
    const runner = fakeRunner(["REFUTED: gap 1", "REFUTED: gap 2", "SOUND: fine"]);
    const r = await refuteOutput("spec", "output", { n: 3, runner });
    expect(r.refuted).toBe(true);
    expect(r.survived).toBe(false);
    expect(r.votes).toHaveLength(3);
  });

  it("survives on majority sound", async () => {
    const runner = fakeRunner(["SOUND: fine", "SOUND: also fine", "REFUTED: gap"]);
    const r = await refuteOutput("spec", "output", { n: 3, runner });
    expect(r.refuted).toBe(false);
    expect(r.survived).toBe(true);
  });

  it("counts an unparseable vote as refuted (fail-safe)", async () => {
    const runner = fakeRunner(["garbage reply with no verdict", "SOUND: fine", "SOUND: also fine"]);
    const r = await refuteOutput("spec", "output", { n: 3, runner });
    expect(r.votes[0].refuted).toBe(true);
    expect(r.votes[0].reason).toMatch(/unparseable/);
    // 1 refuted out of 3 is not a majority -- still survives.
    expect(r.refuted).toBe(false);
  });

  it("counts an errored runner call as refuted (fail-safe)", async () => {
    let calls = 0;
    const runner: RefuteRunner = async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return { text: "SOUND: fine", exit: 0 };
    };
    const r = await refuteOutput("spec", "output", { n: 3, runner });
    expect(r.votes[0].refuted).toBe(true);
    expect(r.votes[0].reason).toMatch(/errored/);
  });

  it("rounds n up to odd", async () => {
    let calls = 0;
    const runner: RefuteRunner = async () => {
      calls += 1;
      return { text: "SOUND: fine", exit: 0 };
    };
    await refuteOutput("spec", "output", { n: 2, runner });
    expect(calls).toBe(3);

    calls = 0;
    await refuteOutput("spec", "output", { n: 4, runner });
    expect(calls).toBe(5);
  });

  it("defaults to n=3 (rounded, already odd) when opts are omitted", async () => {
    let calls = 0;
    const runner: RefuteRunner = async () => {
      calls += 1;
      return { text: "SOUND: fine", exit: 0 };
    };
    await refuteOutput("spec", "output", { runner });
    expect(calls).toBe(3);
  });

  it("parses verdicts with leading whitespace and mixed case", async () => {
    const runner = fakeRunner(["  sound: ok", "REFUTED: because", "  SOUND: also ok"]);
    const r = await refuteOutput("spec", "output", { n: 3, runner });
    expect(r.votes[0]).toEqual({ refuted: false, reason: "ok" });
    expect(r.votes[1]).toEqual({ refuted: true, reason: "because" });
    expect(r.votes[2]).toEqual({ refuted: false, reason: "also ok" });
    expect(r.refuted).toBe(false);
  });

  it("only takes the first line into account for parsing", async () => {
    const runner = fakeRunner([
      "SOUND: fine\nsome extra reasoning that mentions REFUTED nowhere relevant",
      "SOUND: fine",
      "SOUND: fine",
    ]);
    const r = await refuteOutput("spec", "output", { n: 3, runner });
    expect(r.votes[0].refuted).toBe(false);
    expect(r.votes[0].reason).toBe("fine");
  });
});
