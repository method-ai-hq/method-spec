# Hackathon contribution record

Repository created on 10 September 2026. Record actual implementation and measurement dates as work completes.

| Component | Origin | Current status |
| --- | --- | --- |
| Method 2 grammar and SDK execution pattern | Prior Method work | Existing MIT-licensed SDK 0.3.0 baseline, now separately published here. |
| Typed data, state, dependencies, each, conditions, exact checks | Prior Method work | Existing features, not new hackathon claims. |
| Public spec organization and provenance notes | New documentation | Published in this repository. |
| Method 3 execution and check design | New work | Implemented subset documented in spec/method-3.md. |
| New validator and reference runner | New work | Public source, CLI, schemas, script/model/agent execution, state, checks, loops, limits, traces, and migration. |
| Runtime validation | New work | Real local processes; fixture-based model/tool loop and mocked Responses HTTP tests. No live model result claimed. |
| Mixed execution speed improvement | Proposed experiment | Not measured. |
| Astra-driven policy search result | Proposed experiment | Not measured. |
| Factorio adapter and control-test evidence | Separate hackathon repository | See method-factorio and its contribution record. Not a Method 3 result. |
| Factorio and FLE | Existing third-party work | Dependencies; not included here. |

## Accurate introduction

"Before the hackathon, Method represented reusable procedures with agent instructions, typed inputs and outputs, state, and checks. Actions and language-based checks used separate agent runs. For harder game tasks, we built a public Method 3 executor with direct model calls, script execution, and bounded tool-using agents, so the procedure can choose where to spend reasoning time."

At the original 0.1.0 release, the shipped agent backend used the OpenAI Responses API, not a Codex subscription. Runtime 0.1.0 does not implement OS isolation, a computer-use driver, training infrastructure, or automatic recovery. No game speed or policy-search gain is established by this implementation.

See [runtime validation](VALIDATION.md) for the 40-test suite and clean package-install result. The `v0.1.0` release identifies the implementation commit and installable artifact.

Use "we added" or "we built" only for implemented changes. The design is motivated by execution overhead; the amount of overhead and any improvement require measurements.

The shorthand "Methods were simply prompts" leaves out existing capabilities. Use "agent-based execution" when describing the old limit. Publishing or copying existing work into a new repository does not make it new work.

## Evidence required for a result

Identify the implementation commit, policy bundle hash, dependency versions, fixed task settings, trial count, evaluator, and measured results. Preserve unsuccessful trials. Mark human-authored policies, replays, partial tasks, and human assistance.

This record follows the rules supplied by the project owner. It is not an organizer eligibility decision. The demo must highlight work actually built during the event and distinguish all dependencies.

## 13 September 2026 update

Runtime 0.2.0 adds explicit checkpoint resume, accepted iteration reuse, cumulative budgets, human answers, runtime/bundle identity checks, and a process lock. The CLI is now named Method, with method3 retained as an alias. Pure semantic validation is shared with the product without copying private product source here. The runtime suite now has 47 passing tests, including seven new resume tests. No new paid model or game result is claimed.

Runtime 0.2.1 also freezes each-loop collections in the checkpoint when an operation changes its source state list. A real script regression test passes; the suite now has 48 tests.

## Current runtime and documentation — 17 September 2026

Runtime 0.3.0 accepts method/3.1 scalar prompt variables and retains method/3 literal prompts. Its public code now supplies the product's current grammar, validator, defaults, progress protocol, and executor. The local Codex backend is the default; direct Responses API profiles remain supported. Purpose, descriptions, and limit overrides are optional.

This documentation audit corrects the older installation, model-backend, permission, request-accounting, and ask/resume descriptions. It makes no new model-quality or game-performance claim. See VALIDATION.md for the current check results. The original release notes above remain historical records.

Runtime 0.3.1 fixes an installation defect: the runtime no longer registers `method`, which could replace the full SDK CLI in a fresh project. The standalone command remains `method3`. This changes package command ownership, not the Method format or executor behavior. A regression check protects that boundary.

## Portable execution — 17 September 2026

Runtime 0.4.0 adds one agent resolver, a Claude CLI executor with the declared MCP tool bridge, saved agent selection on resume, and a bundle-preparation hook for the SDK. Existing tests and provider-selection fixtures run without paid model calls. Live Claude subscription execution has not yet been measured.

2026-09-17: Added managed-setup validation, stopped-process lock recovery, and Claude tool progress. A clean Linux SDK photo trial found that realpath on the Python executable bypassed its virtual environment. Executable lookup now preserves the invoked path; file hashing still follows the executable. Runtime fixtures pass; no paid provider trial was run.
