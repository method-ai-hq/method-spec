# Baseline provenance

Captured on 10 September 2026.

The Method application repository is private. The SDK was already distributed publicly with source and an MIT license before this repository was created. Moving that baseline here does not make it new hackathon work.

## Source artifact

- Package: `@withmethod/sdk`, version `0.3.0`.
- Public URL: https://app.withmethod.ai/downloads/withmethod-sdk-0.3.0.tgz
- Download SHA-256: `2b57fa935a2f257baf8e2ac6c386fc6793fa24f4b46684797a33f11997618f1d`.
- License: MIT; copyright 2026 Method. The package license is retained as this repository's LICENSE.

## Included baseline files

- `vendor/method-sdk-0.3.0/schema.ts` is an unchanged copy of `package/source/packages/workflow-language/src/schema.ts` from that public archive. It is a source reference, not a standalone build.
- `spec/method-2.schema.json` is the output of `method schema method` from installed SDK 0.3.0. The installed compiled schema, Method CLI, and authoring-guide modules were checked byte for byte against the downloaded public archive.
- `spec/method-2.md` is a new summary of the existing format. It does not add capabilities to it.

The schema describes accepted document shapes. Additional validation and runtime rules are needed to execute a Method correctly. Publishing JSON Schema alone does not establish complete implementation conformance.

New proposal documents and illustrative examples were written for this repository. No application code, private Git history, game assets, or user run data were imported.
