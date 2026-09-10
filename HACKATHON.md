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

The shipped agent backend uses the OpenAI Responses API, not a Codex subscription. Runtime 0.1.0 does not implement OS isolation, a computer-use driver, training infrastructure, or automatic recovery. No game speed or policy-search gain is established by this implementation.

See [runtime validation](VALIDATION.md) for the 40-test suite and clean package-install result. The `v0.1.0` release identifies the implementation commit and installable artifact.

Use "we added" or "we built" only for implemented changes. The design is motivated by execution overhead; the amount of overhead and any improvement require measurements.

The shorthand "Methods were simply prompts" leaves out existing capabilities. Use "agent-based execution" when describing the old limit. Publishing or copying existing work into a new repository does not make it new work.

## Evidence required for a result

Identify the implementation commit, policy bundle hash, dependency versions, fixed task settings, trial count, evaluator, and measured results. Preserve unsuccessful trials. Mark human-authored policies, replays, partial tasks, and human assistance.

This record follows the rules supplied by the project owner. It is not an organizer eligibility decision. The demo must highlight work actually built during the event and distinguish all dependencies.
