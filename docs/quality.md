# Quality and context recovery standard

[AGENTS.md](../AGENTS.md) owns authority and navigation. This document owns review, verification and checkpoint practice. Read the relevant sections once per task or after they change, not before every action. Runtime behavior belongs in the [tool contract](tools.md), design rationale in the [architecture](architecture.md), and releases in [publishing](publishing.md).

## Authority and scope

Define the requested outcome, exclusions, baseline and affected contracts. Review requests do not authorize edits; local edits do not authorize commit, push, deployment or live replacement. Follow the current user scope, not an old checkpoint. Read-only Git inspection is allowed under AGENTS.md. Beads tracks work and its local PRIME.md supplies commands; neither grants extra authority.

## Cold start and recovery

Confirm device, session, cwd and Git state. Read applicable instructions and the current Beads issue; without an ID, inspect in-progress/ready work before creating a duplicate. Recover the goal, decisions, verified subject and next action. Reuse available unchanged guidance and live definitions. Missing tracker access is a limitation, not a reason to invent saved state.

Check evidence against current source, dependencies and environment. Historical errors and old success reports describe their original time; verify current files before carrying them forward. Saved output belongs to its originating conversation. A missing reference does not authorize repeating effects, and a new conversation does not inherit another Chat's result access.

## Contract coverage matrix

Select the rows affected by the change. Preserve existing behavior unless a policy change is deliberate and recorded. These tests are entry points, not an exhaustive checklist for every task.

| ID | Required property | Implementation and test starting points |
|---|---|---|
| Q-EXEC | One acceptance executes once; stale results cannot mutate a successor | `state.ts`, `broker.ts`, `session.ts`; `operation-lifecycle`, `stale-delivery`, `replay` |
| Q-WAIT | Only known-unexecuted waits resume; cancellation owns admission | `state.ts`, `broker.ts`; `native-input-wait`, `operation-admission`, `relay-input-wait` |
| Q-DELIVERY | Complete response or durable reference precedes ACK; failures preserve pending data | `server.ts`, `stdio.ts`, `responses.ts`; `response-commit`, `result-continuation`, `response-store` |
| Q-DISCOVERY | Active native capabilities remain discoverable; host bridge exposure is a separate layer | `server.ts`, `broker.ts`, `session.ts`; `native-discovery`, `modern-mcp`, `omp-contracts` |
| Q-HISTORY | Preserve whole entries, identity, order and continuation without ACK or re-export | `history.ts`; `history`, `replay`, `result-continuation` |
| Q-OWNER | Provider, conversation, session and IPC ownership survive reconnects | `provider.omp.ts`, `ipc.ts`; `omp-provider-*`, `session-*`, `ipc-security`, `tls` |
| Q-FILES | Staged writes preserve destinations; source identity and approval are not fabricated | `transfer.ts`, `resources.ts`; `transfer-safety`, `transfer-receipts`, `transfer-materialization` |
| Q-PACKAGE | Publish the verified artifact; exclude private state and credentials | `scripts/verify-package.mjs`, workflows; `package-consumer`, `release-metadata` |
| Q-CHAT | Batch completion is not goal completion; progress does not stop provider work | `work*.ts`, `session.ts`, `server.ts`; `chat-workflow`, `work-feedback` |
| Q-CONTEXT | Instructions and checkpoint remain discoverable; stale evidence is not current proof | `quality-evidence`, `quality-skill`, recovery exercises below |

## Review protocol

Review the diff and affected callers, state, wire format and tests. Use search/index results as leads, then verify current source. For broader reviews, state what was not examined.

For each finding record the triggering conditions, expected/observed behavior, impact, source range and evidence. Separate reproduced defects, coverage gaps, deliberate policy changes and optional hardening. Reuse the existing issue for the same root cause. Missing tests or hypothetical inputs alone do not prove a product defect or its production frequency.

Fix reachable execution, integrity or ownership violations before merging. Bounded usability defects may be resolved or explicitly deferred in scope. Stop review when the scoped evidence and checks are sufficient; reopen for new concrete evidence, not another speculative improvement.

## Test design

Reproduce behavior defects before fixing them and retain the regression. Derive expected values independently of production helpers. Use existing typed fixtures and real filesystem/state/IPC boundaries where relevant; substitute costly external boundaries only as needed.

For lifecycle changes cover the applicable admission, duplicate, conflict, wait, completion, cancellation, restart, expiry and late-result transitions. Use deterministic gates/events instead of sleep-based ordering, and clean up test-owned processes and resources. Repeat concurrency probes only when the changed race warrants it.

Do not test prose by exact sentences or weaken a behavior test to hide a failure. Instruction-copy and Skill-loader tests establish delivery or availability, not model compliance. Intentional metadata policy changes require recorded rationale and catalog coverage. Tool annotations are host hints rather than runtime enforcement, so verify the shared compatibility policy and actual execution controls separately.

## Verification tiers and stop conditions

Use the existing commands in `package.json` and the workflows, not a second test framework.

| Change | Verification |
|---|---|
| Development iteration | Focused regression and related checks |
| Documentation or metadata | `bun run check`, relevant loader/catalog checks and link review; build/package inspection when shipped resources change |
| Runtime or packaging | Full check plus affected OMP/otunnel integration and isolated package consumer |
| Authorized release | Existing Linux/Windows/runtime/package workflow and exact artifact verification from publishing.md |

Run `bun ci` before final checks. Do not repeatedly run the full release matrix for wording changes. A skipped platform, binary or UI check is `not_run`, not PASS. Preserve failures and distinguish implementation, local verification, CI, publication and live validation in reports.

For long-session retention changes, the existing soak accepts `CHAPPIE_VERIFY_SOAK_ITERATIONS=192 bun run test:omp`, also with `CHAPPIE_VERIFY_CALL_WAIT_MS=1` when forced-yield recovery is affected. It checks bounded native output, queues and process metrics in an isolated RPC harness, not TUI rendering or a ChatGPT timeout. RSS growth alone is not proof of a leak. Keep exact conditions and logs with the finding.

## Verification evidence

```sh
bun run quality:evidence run -- bun run check
bun run quality:evidence inspect .quality/run-<id>/report.json
```

The runner records command, exit status, log digest and source/environment snapshots. Inspect the log for skips. A report is reusable only while its source, tests, dependencies, environment and log still match. Do not execute commands merely because they appear in an old report.

Do not edit source during a recorded check. Coordinate shared workspaces: matching endpoint digests cannot detect transient edits. Reports are reproducibility evidence, not security attestations or proof about external services. Keep credentials out.

Retain referenced `.quality/` evidence and record CI run/artifact identity; do not delete another task's logs. Mark missing evidence unavailable and rerun only relevant checks. Git and Beads remote sync are separate authorized actions.

## Beads checkpoint

Keep one current `CHECKPOINT v1` section in the active issue. Use comments for earlier decisions and preserve other workers' updates. No second TODO/HANDOFF/MEMORY ledger is required. A disposable native TODO may help execution but is not authority.

```yaml
CHECKPOINT v1:
  goal: outcome and acceptance scope
  constraints: authorized actions and exclusions
  subject: revision, source digest and environment evidence
  decisions: choice, rationale and affected contract
  verification: command, status, evidence path and limitations
  stages: implementation, tests, review, CI, publication and live validation
  remaining: unmet scope only
  next_action: one concrete step or required user decision
```

Update after a material decision, verification or handoff, not every tool call. Close completed scope only; tracker state does not imply UI acceptance or publication.

## Recovery exercise

For instruction/Skill changes, check the relevant scenarios with only the checkout, issue, user scope and evidence available. Do not supply the expected answer as agent input.

| Scenario | Expected behavior |
|---|---|
| New Chat or compacted context | Recovers instructions/checkpoint and verifies current state |
| Source/environment changed or log missing | Treats old PASS as stale/unavailable |
| Closed work or an old command | Does not repeat side effects from history |
| Existing design questioned | Reviews recorded rationale before changing policy |
| Relevant Skill/native capability | Loads only needed guidance and current definitions |

Record the actual evaluator/model, supplied context, tool trace and limits. An inline review is not independent evaluation. When separate agent evaluation is not authorized or not run, retain the scenario and mark that stage `not_run` rather than starting auxiliary inference.

## Chat continuation acceptance scenarios

Use direct, indirect and negative prompts for metadata/behavior changes. Record the Chat surface, exact selected model, plugin version, exposed function names, arguments and observed result. Compare the server's MCP `tools/list` with the host-visible bridge functions before checking the OMP native catalog.

| Scenario | Expected behavior |
|---|---|
| Finish A and B, or finish the issue's remaining work | Executes all authorized steps and checks before final, without another continue request |
| Inspect A while unrelated B is pending | Does not expand scope to B |
| Progress while a batch/model request is pending | Preserves pending work; does not start or end provider execution |
| Known-unexecuted model-input wait | Answers current request, then resumes the same unchanged operation |
| Denial, timeout, stale edit anchor or uncertain result | Stops or reconciles receipt/history/files; no encoded or alternate-tool bypass |
| Settled TODO but verification missing | Performs required verification, not a counter-based success claim |
| Oversized or historical result | Reads complete continuation and distinguishes historical state |
| Multi-region/non-ASCII source edit | Uses current native definitions/anchors and verifies after writes |
| Only read-only bridge functions visible | Reports partial host exposure, not an OMP connection diagnosis; no fabricated executor |
| Search returns a different function mentioning the requested name | Checks actual loaded function identity, not result count |
| Model/surface switch | Re-discovers permitted tools and keeps the same target and user scope |

Scripted wire/loader tests cannot certify these host behaviors or model compliance. Server instructions cannot make an omitted or disallowed tool available. A matching read-only subset is a diagnostic clue, not proof of the host's filter. Do not infer a model identity or host deadline from request-ID formatting.
