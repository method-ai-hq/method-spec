# Current validation — 17 September 2026

Runtime 0.3.1 keeps the 0.3.0 execution behavior and fixes CLI command ownership:

- `npm run check`: generated schemas match and all 50 runtime tests pass.
- `npm run example`: the real checked counter completes with state count 3 and zero model requests.
- The current grammar accepts method/3 and method/3.1. The full SDK uses the same public schema and semantic validator.
- Model tests use fixtures and mocked transport. This audit did not make paid model calls or measure model quality.

The repository has no deployment target. GitHub CI runs the contract checks and script example on Node.js 22 for macOS and Linux. Read the check status for the exact commit before treating remote CI as passed.

The following records describe earlier releases; their versions, counts, and limitations apply to those releases.

# Runtime 0.1.0 validation

Date: 10 September 2026. Scope: the public Method 3 reference executor, not gameplay performance.

## Local results

- `npm run check`: 40 tests passed. Generated schemas match the source grammar.
- `npm run example`: the checked counter completed three real script iterations and committed count 3 with zero model requests.
- All three supplied Method 3 examples pass semantic validation with their configuration files.
- `npm pack`: created `withmethod-runtime-0.1.0.tgz` with public source, examples, schemas, and license.
- A fresh installation of that tarball in a temporary directory reports version 0.1.0 and successfully runs the bundled counter example.
- `npm install` audit after updating the two direct dependencies reported zero known vulnerabilities.
- Local Markdown links and Git whitespace checks passed.

The suite covers dependency order, typed inputs and outputs, exact/script/agent checks, state commit boundaries, each/repeat, limits, subprocess termination, tool restrictions, uncertain external actions, file hashes, bundle changes, and explicit Method 2 migration.

Model and agent tests use deterministic response fixtures. The real Responses HTTP adapter is exercised with a mocked HTTP transport. These tests check request format, tool dispatch, structured output validation, cancellation, error handling, and usage accounting; they do not establish compatibility with a live account or measure model quality.

## CI and release

The public `Check runtime` workflow runs the same suite, example, and package check on Node.js 22 for macOS and Linux. Its run status on the release commit is the source of truth for CI results.

No live billed API call, Factorio comparison, policy-search improvement, or hosted-product deployment is claimed. The repository has no deployment target. Source and an installable package are published through GitHub.

## Runtime 0.2.0

47 local tests pass. Added checks cover repeat state resume, each output order, explicit retry without repeating accepted steps, changed method/config/input/bundle rejection, real human answers, cumulative model request caps, and active-run locks. All model responses remain fixtures; no live model result is claimed.

Runtime 0.2.1: 48 tests pass. The added test stops a loop after it changes its source state list, then verifies that resume keeps the original item order and commits the final state.
