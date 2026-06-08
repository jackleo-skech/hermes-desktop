import { describe, expect, it } from "vitest";
import {
  gatewayCompletionSuffix,
  gatewayMessageCompleteText,
  gatewayMessageDelta,
  gatewayReasoningText,
  gatewayToolEvent,
  gatewayUsage,
} from "./tui-gateway-stream";

describe("tui gateway stream mapping", () => {
  it("maps message and reasoning deltas", () => {
    expect(
      gatewayMessageDelta({
        type: "message.delta",
        payload: { text: "hello" },
      }),
    ).toBe("hello");
    expect(
      gatewayReasoningText({
        type: "reasoning.delta",
        payload: { text: "thinking" },
      }),
    ).toBe("thinking");
    expect(
      gatewayMessageCompleteText({
        type: "message.complete",
        payload: { rendered: "final" },
      }),
    ).toBe("final");
  });

  it("uses completion text when streamed deltas were only whitespace", () => {
    expect(gatewayCompletionSuffix("\n  ", "final answer")).toBe(
      "final answer",
    );
  });

  it("only appends the missing suffix when completion repeats streamed text", () => {
    expect(gatewayCompletionSuffix("hello", "hello world")).toBe(" world");
    expect(gatewayCompletionSuffix("hello world", "hello world")).toBe("");
  });

  it("does not duplicate unrelated completion text after visible stream text", () => {
    expect(gatewayCompletionSuffix("partial answer", "different answer")).toBe(
      "",
    );
  });

  it("ignores reasoning.available previews for live reasoning", () => {
    expect(
      gatewayReasoningText({
        type: "reasoning.available",
        payload: { text: "final answer preview" },
      }),
    ).toBe("");
  });

  it("maps stable tool start and complete events with result payloads", () => {
    expect(
      gatewayToolEvent({
        type: "tool.start",
        session_id: "s1",
        payload: {
          args_text: "curl http://127.0.0.1",
          name: "terminal",
          tool_id: "call-1",
        },
      }),
    ).toMatchObject({
      callId: "call-1",
      hasStableCallId: true,
      name: "terminal",
      preview: "curl http://127.0.0.1",
      status: "running",
    });

    expect(
      gatewayToolEvent({
        type: "tool.complete",
        session_id: "s1",
        payload: {
          name: "terminal",
          result_text: "ok",
          tool_id: "call-1",
        },
      }),
    ).toMatchObject({
      callId: "call-1",
      name: "terminal",
      result: "ok",
      status: "completed",
    });
  });

  it("formats structured tool results when result_text is absent", () => {
    const mapped = gatewayToolEvent({
      type: "tool.complete",
      payload: {
        name: "skill_view",
        result: { answer: "done" },
        tool_id: "call-2",
      },
    });

    expect(mapped?.result).toContain('"answer": "done"');
  });

  it("maps message completion usage", () => {
    expect(
      gatewayUsage({
        type: "message.complete",
        payload: {
          usage: {
            cache_read: 2,
            cache_write: 3,
            input: 10,
            output: 5,
            total: 15,
          },
        },
      }),
    ).toEqual({
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
      completionTokens: 5,
      promptTokens: 10,
      totalTokens: 15,
    });
  });
});
