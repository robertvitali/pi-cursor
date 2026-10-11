# Cursor review tool discovery investigation

Date: 2026-09-30

Tracking: Asana `1219011838045537`

## Established root cause for the initial no-tool failure

The native request path did not drop Pi tools. A deterministic Pi 0.86.1
fixture and the live shadow probe both carried all 10 tools through context
normalization, `McpToolDefinition` encoding, and the decoded
`AgentRunRequest.mcpTools` field. The installed Cursor CLI schema uses the same
field numbers and provider/tool-name contract.

Cursor's server-side `GetDynamicTools` catalog omits the per-request `pi`
namespace even though those same tools remain callable with
`CallDynamicTool(namespace="pi", toolName="mcp_pi_<name>", ...)`. A model that
trusts discovery therefore reports the tools as unregistered and stops. This is
the exact upstream defect documented in:

- https://github.com/Rahularya01/pi-cursor/issues/40
- https://github.com/Rahularya01/pi-cursor/pull/41

The local repair follows PR #41: the tool policy states the discovery caveat
and the exact `CallDynamicTool` route. Argument-key hints are decoded from each
currently registered tool's protobuf schema, capped at 12 top-level keys. No
tool is named or described unless it is present in the current request. There
is no native filesystem fallback and no protocol/name normalization change.

Relevant source:

- `src/stream/local-tool-policy.ts`: discovery guidance and schema-derived hints
- `src/stream/root-prompt.ts`: shared `pi` provider identifier
- `tests/local-tool-policy.test.ts`: current-request authority and schema tests

## Recorded live probe evidence

The following results were recorded from the 2026-09-30 live probes. Their
temporary shadow directories no longer exist, so they are historical evidence,
not probes that were independently rerun during the 2026-10-02 repair.

The baseline probe completed with zero Pi tool executions. Sanitized boundary
logs recorded 10 tools at normalized context, MCP definition, and decoded
wire-request boundaries. The server produced no `mcpArgs`. Cleanup recorded
`clean=true`, no observation error, and no survivors.

The repaired probe reached one real `read` call and returned its result
successfully. This recorded result supports that the discovery guidance repairs
initial Pi-tool access. Its second tool-result continuation did not complete the
review:

1. Request 1 decoded 10 tools and received `mcpArgs`; the child executed one
   non-error `read`.
2. The parked bridge for request 2 closed with code 1, no checkpoint, no MCP
   exec, and no user-visible content.
3. The provider rebuilt request 2 on a fresh bridge. It again decoded 10 tools,
   handled `requestContextArgs`, and received normal thinking, text, checkpoint,
   and turn-end events, but no `mcpArgs`.
4. Cleanup completed with `clean=true`, no observation error, and no survivors.

The live model's explanation is not treated as causal evidence. The factual
remaining boundary is downstream of a valid full-history request: Cursor's
server/model selected no MCP call on the continuation.

## Confirmed write-failure callback handoff race

`handleNativeToolResultResume()` used to write each `mcpResult` before calling
`writeNativeStream()` to install the resumed `onData`, `onStreamDone`, and
`onClose` handlers. The in-process HTTP/2 bridge can synchronously close if a
write throws or exceeds its backpressure bound. That close therefore reached
the already tool-use-closed first writer.

The HTTP/2 bridge also queues a close callback attached after it has exited.
This provides a source-level explanation consistent with the recorded immediate
code-1 close on the resumed writer with `mcpExecReceived=false` and no checkpoint.
It does not establish the cause of that historical live failure. Release
v1.4.38 commit `b8c11bc` is already an ancestor of this branch and resets
listeners only when `openStream()` creates a new stream. Tool-result
continuation stays on the existing stream, so that fix does not cover this
handoff.

The repair installs resumed handlers before writing results. The synchronous
close regression verifies that continuation recovery reports through the
resumed writer and stops sibling writes after transport loss. The
already-aborted regression verifies that no result is sent.

## Review finding: synchronous successful response is a synthetic trigger

The 2026-10-02 publication review proposed that the first sibling result could
synchronously trigger `done("toolUse")`, causing the `writer.closed` guard to
skip the second sibling. A two-result reproduction with a mock that directly
invokes `onData` from `write` reproduced that failure: only `exec-21` was sent
instead of `exec-21` and `exec-22`. This reproduces the mock behavior, not a
reachable production HTTP/2 response sequence.

Tracing `src/client/h2-session.ts` shows `write` delegates to `safeWrite`, which
calls `ClientHttp2Stream.write`. Successful inbound data is dispatched by the
stream's later `data` event. The proxy bridge buffers or delegates writes and
does not synchronously deliver successful response frames either. The resume
result loop contains no asynchronous yield. Although initial `onData`
registration can drain queued data synchronously, a parked bridge retains its
existing callback; same-stream resume does not call `openStream` to clear it.
The production writer does close on `done("toolUse")`, but that cannot occur
between these sibling writes through the production response path.

The follow-on regression now schedules inbound data in a microtask after the
first result write, exercising a response as early as the current stack allows.
It verifies both sibling results are sent, follow-on text and the third tool
reach the resumed writer, and the next pending set contains only that third
call. The abort and transport-close guards remain unchanged. No production
behavior change was justified by the synthetic success-reentry finding.

Earlier descriptions claiming that Cursor synchronously returns text or
`mcpArgs` from a result write were incorrect and are superseded by this trace.
This source-trace and offline-test step did not run a fresh live model probe.
A separate 2026-10-02 native Pi acceptance did complete four sequential reads
and the requested comparison, as recorded below. That success does not validate
the refuted synchronous-response mechanism or every recovery path.

## Continuation discriminator

`tests/root-prompt.test.ts` reproduces the exact composite tool-call ID shape
observed live (`call-...\nfc_..._0`). The rebuilt request retains all 10 tools,
replays matching assistant-call and tool-result IDs under `mcp_pi_read`, and
retains the discovery/call policy. This rules out local call-ID mismatch,
tool-count loss, policy omission, and root-prompt replay loss in the
checkpoint-free rebuild. No recovery behavior was changed.

Focused validation:

```sh
node_modules/.bin/vitest run \
  tests/root-prompt.test.ts \
  tests/local-tool-policy.test.ts \
  tests/transcript-wire-tools.test.ts \
  tests/transcript-context.test.ts \
  tests/tool-schema.test.ts \
  tests/request-context.test.ts
```

The original run recorded 6 test files and 62 tests passing against a
disposable Pi 0.86.1 tree. On 2026-10-02, exact locked Pi 0.84.2 dependencies
were installed. The continuation, HTTP/2, recovery, and prompt suites passed 77
tests. The wire fixture passed its Pi 0.84 context path and explicitly skipped
the unavailable `normalizeContext` capability. An isolated exact Pi 0.86.1
shadow ran both wire-fixture paths: 2 tests passed.

## Canonical validation status

The repository's exact Pi 0.84.2 lockfile dependency tree is installed in this
worktree. The task-owned files pass focused ESLint and Prettier checks.
`parseToolCallArguments()` now returns an accurate local recursive JSON-object
type: it accepts a parsed non-array object directly, wraps primitives and
arrays in `{ value }`, and wraps invalid text in `{ __raw }`. No broad cast was
added at the Pi event boundary.

TypeScript passes against both the locked Pi 0.84.2 tree and an isolated exact
Pi 0.86.1 tree. The Pi 0.86.1 run previously exposed the stricter `JsonObject`
contract at `src/stream/stream-writer.ts:113`; the recursive return type resolves
that compatibility error without changing runtime output.

The final bounded `yarn check` on 2026-10-02 passed typecheck, lint, formatting,
security, protobuf drift, all 44 Vitest files (363 passed, 1 capability-gated
skip), and all five legacy test scripts. Live Cursor/model smoke tests were not
part of this validation step.

## Recorded sequential-read acceptance

A separate isolated native Pi acceptance on 2026-10-02 used
`cursor-subscription/grok-4.7` at high effort with the approved TypeScript review
and delegate-task skills. Four separate sequential `read` calls succeeded, and
the reviewer identified the seeded two-file defect: seconds passed unchanged
into a millisecond timer. The acceptance passed and cleanup verified zero
survivors. Preserved evidence lives in the publication scoping workspace:
`scoping-drafts/evidence/2026-10-02-cursor-recovery/cursor-live-validation.md`,
`cursor-live-acceptance.json`, and `cursor-live-acceptance.log` in that directory.

The 2026-10-07 R6 publication Code Reviewer also completed 48 tool calls,
including 32 successful `read` calls. Its preserved evidence is
`scoping-drafts/evidence/publication-native-oauth-r6/validation/cursor-code-reviewer/cursor-code-reviewer.publication-r6-01.result.json`
in the same scoping workspace. These are observed native tool-execution
successes, not an assertion that the transport used a particular continuation
path or that publication is approved.

Neither of those earlier diagnostic streams records the sanitized `mcpArgs`
and parked-bridge-versus-history-rebuild categories. The separate instrumented
fixture below supplies evidence for that narrower criterion.

## Transport-category acceptance — instrumented parked-bridge fixture

The write-failure callback handoff repair is covered for asynchronous follow-on
content after sibling results, a write-time bridge close with multiple pending
results, and an already-aborted resume. The result loop stops as soon as the resumed writer
closes or the old bridge loses liveness, so later results are not written or
logged against a dead transport.

A bounded 2026-10-07 native Pi 1.0.4 fixture used
`cursor-subscription/grok-4.7` at high effort with a category-only observation
tap in an isolated Cursor source copy. Two separate reads arrived as distinct
`mcpArgs`; each result matched its call and execution identity. The first
result preceded the second request. Both continued on the parked bridge,
with no captured rebuild, recovery, retry, or unexpected fallback. The complete
trace ended without a capture error, the reviewer identified the seeded
seconds-versus-milliseconds defect, and owned-process cleanup verified.

The original live TAP failed and its result remains `incomplete`: the original
verifier mistook cumulative completed-result history in the second resume for
batched outstanding reads. The parser collects all completed results in the
current turn, while the wire loop sends only pending executions. An independent
review approved an offline verifier correction that accepts already-sent
history while still requiring sequential requests and matching result
identities. Reassessment of the unchanged trace passed without another model
call; the failed live result and log remain preserved separately.

Evidence in the publication scoping workspace:
`scoping-drafts/evidence/publication-review-repairs/cursor-continuation/reassessment-v2/SUMMARY.md`,
with `reassessment-result.json`, `original-live-result.json`,
`original-live-log.txt`, `original-transport-categories.jsonl`, and artifact
hashes alongside it. This satisfies the two-read transport criterion for this
instrumented parked-bridge fixture only. It does not prove every recovery path,
provide uninstrumented production telemetry, or constitute publication approval.
