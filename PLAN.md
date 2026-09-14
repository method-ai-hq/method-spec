# Implementation plan

Status: stages 1 and 2 have a first implementation. The public runtime supports all three execution types, script and exact checks, typed state, each/repeat, limits, traces, and explicit migration. Local execution, checkpoint resume, and deterministic provider fixtures are tested. Live API and Factorio comparisons remain to be run; stages 3–5 are not completed by runtime tests.

## 1. Publish and review the boundary

Publish the existing Method 2 grammar with its public SDK provenance. Review the Method 3 proposal, especially execution syntax, check behavior, and state semantics. Keep examples explicitly marked as draft.

Complete when the current public baseline and proposed changes can be inspected separately. This stage does not require production deployment.

## 2. Build the smallest public reference implementation

Implement in this repository so new general-purpose work is publicly inspectable. Add a validator and local runner supporting `agent`, `call`, and `run`, common inputs and outputs, exact checks, deadlines, and saved records. Support one concrete backend for each type. A capability that cannot be enforced must fail clearly or be excluded from the claimed execution profile.

Reuse existing public SDK behavior with attribution when useful. Do not copy private product code. Keep game controls and candidate policies in method-factorio. Integrate with the hosted product later through the public implementation or generated schema.

Start with `run` and exact checks to establish the shared interface without paid model calls. Then add `call` and adapt `agent`. Add script checks. Preserve existing loop behavior; implement the proposed bounded repeat only when a concrete trial requires it.

Necessary checks include invalid outputs, missing references, unsupported profile settings, timeout and budget stops, an external action with uncertain completion, check failure before local state commit, and successful trace reconstruction. Check an existing Method 2 example before claiming compatibility. Do not treat a passing JSON Schema validator as an execution test.

## 3. Establish one measured execution comparison

Use the same public Factorio adapter and a fixed modest production target. Freeze settings, budgets, and candidate files before the comparison. Compare the original agent-based procedure with a mixed procedure using the same available controls. Measure complete elapsed time and actual model use, including checks and setup.

This first comparison measures execution overhead and task behavior. It does not establish that Astra found the design or that policy search helped.

## 4. Let Astra propose and test one policy change

Save an initial policy before showing development feedback. Let Astra change its prompts, code, parameters, or choice among approved execution types. Preserve the proposed reason, candidate bundle, failed trials, and comparison outcome.

Select on development trials. Freeze the selected bundle for separate evaluation trials. Report search cost separately from execution cost. The external evaluator and allowed game tools remain fixed.

## 5. Prepare the demo

Show the original policy, one actual failure or measured cost, the changed policy, and the resulting game evidence. Report the number of trials and full measured outcomes. If the improved policy does not improve the result, say so.

Identify the old Method format, public SDK, Factorio, and FLE as dependencies. Identify the new execution support and measured policy changes by commit. A working small-production test is not a rocket launch.

No deployment target exists in this repository. A public Git push publishes the design; it is not a runtime release.
