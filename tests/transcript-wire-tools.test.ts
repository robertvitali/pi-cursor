import { fromBinary, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import type { Api, Context, Model, Tool as PiTool } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentClientMessageSchema } from "../src/proto/agent_pb.js";
import {
  resetToolBoundaryDiagnosticsForTests,
  setToolBoundaryDiagnosticSinkForTests,
  type ToolBoundaryDiagnostic,
} from "../src/stream/debug-log.js";
import { contextToCursorChatCompletionRequest } from "../src/stream/pi-adapter.js";
import { buildCursorRequest } from "../src/stream/request-build.js";
import { buildMcpToolDefinitions } from "../src/stream/tool-schema.js";

const model = { id: "cursor-grok-4.6", api: "cursor-native", provider: "cursor" } as Model<Api>;

type NormalizeContext = (context: {
  systemPrompt: string;
  tools: PiTool[];
  messages: Context["messages"];
}) => Context;

const piAi: Record<string, unknown> = await import("@earendil-works/pi-ai");
const normalizeContext =
  typeof piAi.normalizeContext === "function"
    ? (piAi.normalizeContext as NormalizeContext)
    : undefined;
const normalizedContextTest = normalizeContext ? it : it.skip;

function tool(name: string, parameters: Record<string, unknown>): PiTool {
  return { name, description: `${name} tool`, parameters } as unknown as PiTool;
}

describe("normalized Pi tools on the Cursor wire", () => {
  const priorDiagnostics = process.env.PI_CURSOR_TOOL_DIAGNOSTICS;
  const diagnostics: ToolBoundaryDiagnostic[] = [];

  beforeEach(() => {
    process.env.PI_CURSOR_TOOL_DIAGNOSTICS = "1";
    resetToolBoundaryDiagnosticsForTests();
    setToolBoundaryDiagnosticSinkForTests((entry) => diagnostics.push(entry));
  });

  afterEach(() => {
    diagnostics.length = 0;
    setToolBoundaryDiagnosticSinkForTests();
    if (priorDiagnostics === undefined) delete process.env.PI_CURSOR_TOOL_DIAGNOSTICS;
    else process.env.PI_CURSOR_TOOL_DIAGNOSTICS = priorDiagnostics;
    resetToolBoundaryDiagnosticsForTests();
  });

  function verifyWireTools(
    transcript: Context,
    tools: PiTool[],
    expectedMessages: { messageCount: number; systemMessageCount: number },
  ) {
    const body = contextToCursorChatCompletionRequest(model, transcript, undefined, {} as never);
    const definitions = buildMcpToolDefinitions(body.tools ?? []);
    const payload = buildCursorRequest({
      modelId: body.model,
      systemPrompt: "Review both files.",
      userText: "Inspect the fixture.",
      turns: [],
      conversationId: "wire-regression",
      checkpoint: null,
      mcpTools: definitions,
    });

    const envelope = fromBinary(AgentClientMessageSchema, payload.requestBytes);
    expect(envelope.message.case).toBe("runRequest");
    if (envelope.message.case !== "runRequest") throw new Error("expected runRequest");
    const encoded = envelope.message.value.mcpTools?.mcpTools ?? [];

    expect(encoded.map((entry) => entry.name)).toEqual(["read", "grep"]);
    expect(encoded.map((entry) => entry.toolName)).toEqual(["read", "grep"]);
    expect(encoded.map((entry) => entry.providerIdentifier)).toEqual(["pi", "pi"]);
    expect(
      encoded.map((entry) => toJson(ValueSchema, fromBinary(ValueSchema, entry.inputSchema))),
    ).toEqual(tools.map((entry) => entry.parameters));

    expect(diagnostics).toEqual([
      {
        boundary: "normalized_context",
        ...expectedMessages,
        resolvedToolCount: 2,
        bodyToolCount: 2,
        resolvedToolValueTypes: ["object", "object"],
        bodyToolValueTypes: ["object", "object"],
      },
      {
        boundary: "mcp_definitions",
        inputToolCount: 2,
        encodedMcpToolCount: 2,
        inputToolValueTypes: ["object", "object"],
        encodedMcpToolValueTypes: ["object", "object"],
      },
      {
        boundary: "wire_request",
        inputMcpToolCount: 2,
        decodedMcpToolCount: 2,
        decodedNameFieldTypes: ["string", "string"],
        decodedProviderIdentifierFieldTypes: ["string", "string"],
        decodedToolNameFieldTypes: ["string", "string"],
        decodedInputSchemaFieldTypes: ["Uint8Array", "Uint8Array"],
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("Review both files");
    expect(JSON.stringify(diagnostics)).not.toContain("Inspect the fixture");
    expect(JSON.stringify(diagnostics)).not.toContain('"read"');
    expect(JSON.stringify(diagnostics)).not.toContain('"grep"');
  }

  it("preserves locked Pi 0.84 context tools through AgentRunRequest", () => {
    const tools = [
      tool("read", {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      }),
      tool("grep", {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" } },
        required: ["pattern"],
      }),
    ];
    const transcript = {
      systemPrompt: "Review both files.",
      tools,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Inspect the fixture." }],
          timestamp: 1,
        },
      ],
    } as unknown as Context;

    verifyWireTools(transcript, tools, { messageCount: 1, systemMessageCount: 0 });
  });

  normalizedContextTest(
    "preserves Pi 0.86 normalizeContext tools through AgentRunRequest (requires capability)",
    () => {
      if (!normalizeContext) throw new Error("normalizeContext capability disappeared");
      const tools = [
        tool("read", {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        }),
        tool("grep", {
          type: "object",
          properties: { pattern: { type: "string" }, path: { type: "string" } },
          required: ["pattern"],
        }),
      ];
      const transcript = normalizeContext({
        systemPrompt: "Review both files.",
        tools,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Inspect the fixture." }],
            timestamp: 1,
          },
        ] as Context["messages"],
      });

      verifyWireTools(transcript, tools, { messageCount: 2, systemMessageCount: 1 });
    },
  );
});
