# Hackathon experiment design

Status: proposed comparison. No Method 3 trials have run.

## Question

Can Astra improve a reusable Method's task performance or execution cost by choosing which operations use agents, individual model calls, or code?

Factorio supplies the task and observable effects. The first experiment should use a modest fixed production target and multiple fresh maps. The existing public Factorio project has small control-test evidence; that does not establish a Method 3 result.

## Two separate tests

First test the runtime change: compare the original agent execution pattern with a mixed implementation. If the mixed procedure is designed by a human, label it that way. This measures the value of the execution choices, not autonomous policy improvement.

Then test search: compare an initial Astra-authored policy with a policy revised from development trials. Give both access to the same execution choices. Freeze each version, preserve failed trials, and evaluate on maps not used to select it. A combined comparison alone cannot isolate prompt changes from code changes or model selection.

## Fixed conditions

Use the same game build, adapter revision, allowed observations and actions, starting conditions, objective, model availability, and execution budget. Record whether the game runs while models think. Keep the evaluator and evaluation seeds outside the candidate's editable bundle.

Use a fixed task success condition, then compare elapsed time and model usage for successful runs. Include failure rates and stopped runs. Do not optimize a time score that rewards doing no work. Report the tradeoff if faster candidates fail more often.

Record exact trial count, game time, elapsed time, model requests, token use where available, actual or estimated cost with its source, human help, and all stop reasons. Unknown usage stays unknown. Report authoring and search costs separately. Operator-set limits are required before paid runs.

## Demo claim

Before implementation: "We designed an extension that lets Methods choose agents, model calls, or code."

After implementation and successful checks: "We built and ran those execution types."

Only after the comparison: "On this task, over this many trials, the revised Method changed success, time, and cost by these measured amounts."

Only call the process hill climbing if it retains a better candidate through a defined local improvement rule. Otherwise, use the broader term policy search. Changing model weights is outside this first experiment.
