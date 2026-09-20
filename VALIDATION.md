# Runtime validation

For this checkout, run `npm ci --ignore-scripts` and `npm run check`. The check verifies generated schemas, the runtime tests, declaration generation, and TypeScript API examples. CI also compares generated declarations with the committed files and runs the checked counter example on Node 22 for macOS and Linux.

Tests use local scripts and mocked model responses. They do not establish live model quality or billed-provider compatibility. No account is required for the script example. The runtime has no hosted deployment target; its source and installable package are distributed through GitHub.

Use `node src/cli.js --version` and the CI result for the exact commit.

Classification tests cover response validation, uncertainty, request and byte limits, deadline expiry, late responses, each-loop ordering, empty collections, explicit retry, and saved-model resume. Script tests cover stable operation IDs across retries and distinct check identities. These use injected providers; they do not claim live TypeSafe quality or service availability.
