import { describe, expect, it } from "vitest";
import { toolActivityGroupTitle } from "../src/renderer/src/screens/Chat/HistoryRow";
import type {
  ToolCallMessage,
  ToolResultMessage,
} from "../src/renderer/src/screens/Chat/types";

const call = (id: string, name: string): ToolCallMessage => ({
  id: `tool-call-${id}`,
  kind: "tool_call",
  role: "agent",
  callId: id,
  name,
  args: "",
  status: "completed",
});

const result = (id: string, name: string): ToolResultMessage => ({
  id: `tool-result-${id}`,
  kind: "tool_result",
  role: "agent",
  callId: id,
  name,
  content: "ok",
});

describe("toolActivityGroupTitle", () => {
  it("keeps the tool name for a single call/result pair", () => {
    expect(toolActivityGroupTitle([call("a", "terminal"), result("a", "terminal")])).toBe(
      "terminal",
    );
  });

  it("summarizes groups with more than one tool call", () => {
    expect(
      toolActivityGroupTitle([
        call("a", "skill_view"),
        result("a", "skill_view"),
        call("b", "terminal"),
        result("b", "terminal"),
      ]),
    ).toBe("2 tools called");
  });

  it("excludes tool results from the count", () => {
    expect(
      toolActivityGroupTitle([
        call("a", "terminal"),
        result("a", "terminal"),
        result("b", "terminal"),
      ]),
    ).toBe("terminal");
  });
});
