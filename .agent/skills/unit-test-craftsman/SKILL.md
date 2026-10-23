---
name: unit-test-craftsman
description: Activate this skill when writing or refactoring the vitest unit tests (each workspace's src/**/*.test.ts and the root's scripts/**/*.test.ts) or when the user asks you to fix test failures.
---

# Unit Test Craftsman

## Goal

To enhance the readability and maintainability of unit tests while ensuring 100% technical reliability and code coverage within a high-performance workflow.

## Scope

These rules are for the vitest suites, each workspace's `src/**/*.test.ts` and the root's `scripts/**/*.test.ts`. Vitest runs them under Node, which must be on the `PATH`: without it, `bun run` runs vitest on Bun, where part of the suite fails and coverage is not supported.

The end-to-end tests in `apps/gekko/test/e2e` run on Bun's own test runner (`bun:test`), where these rules change:

- `it.each` takes array tables only: a tagged template does not type-check there, and run anyway it iterates the template's text fragments, each row a string whose fields are undefined: none tests what the table meant, and each passes or fails as its assertion holds for undefined. Its rows are inferred as deep-readonly constants: a row holding an array that the test passes to a mutable parameter or to `toEqual` needs the table's row type, `it.each<Row>([...])`.
- A scenario runs a whole pipeline, so it asserts its figures in one `toEqual` on a composed object rather than in one `it()` per `expect()`.
- `bun run test` runs vitest only: run an e2e file with `bun test --isolate test/e2e/<path>` from `apps/gekko`, all of them with `bun run test:e2e` from the root.
- `await expect(promise).rejects` (and `.resolves`) blocks until the promise settles, past every timeout: assert the caught form (`await promise.then(() => undefined, error => error)`) when the run under test may never settle.
- A realtime flow waits on its run through `runRealtimeUntil`, `runRealtimeFor` or `runRealtimeUntilEnd` (`apps/gekko/test/e2e/helpers/realtimeRun.helper.ts`), never on the pipeline's promise, which does not settle while the run goes on: the test then fails with its 30 s timeout, having asserted nothing.

## Instructions

- **Refactor for Readability**:
  - Convert repetitive test cases into `it.each` tables using **tagged templates**.
  - Aim for **one `expect()` function per `it()`** block to isolate failures and improve clarity.
- **Ensure 100% Coverage**:
  - Analyze the source code to identify missing branches, functions, or statements.
  - Generate additional test cases to reach **100% coverage** of the file under test (statements, functions, branches, and lines). `bun run test:coverage`, which the pre-push hook and CI run, fails when the suite's coverage falls below 95%.
- **Technical Validation**:
  - Run `bun run type:check` to ensure no TypeScript errors remain in the test suite.
  - Execute the specific test file with `bun run --filter <package> test <path_to_file>` from the root (`bun run --filter @gekko/shared test src/helpers/collection/ringBuffer.test.ts`), or `bun run test <path_to_file>` in the workspace's directory: at the root, `bun run test <path_to_file>` fails, turbo reading the path as a task.
  - Lint the file with `bun x eslint <path_to_file>`: the pre-commit hook refuses an unused parameter without a `_` prefix and an unread `catch (_err)` (write `catch {`).
- **Performance**:
  - Keep logic execution extremely lean to ensure the turnaround is faster than 100ms.

## DOs

- Use `it.each` with tagged templates for repetitive test cases.
- Isolate failures by using exactly one `expect()` per `it()` block.
- Reach 100% coverage for all statements, functions, branches, and lines.
- Validate types using `bun run type:check` for every change.
- Target tests using `bun run --filter <package> test <path_to_file>` (or `bun run test <path_to_file>` in the workspace's directory) for speed.
- Set mock return values and create spies in `beforeEach` or in the test itself: every vitest configuration sets `mockReset` and `restoreMocks` (each workspace's through `workspaceVitestConfig` of `vitest.shared.ts`, the root's in its own `vitest.config.ts`), which reset every mock and restore every spy before each test, ahead of the `beforeEach` hooks.
- Ensure performance by keeping execution turnaround under 100ms.

## DONTs

- Call `vi.clearAllMocks()`: the configuration already resets every mock before each test.
- Chain `.mockReturnValue()` or `.mockImplementation()` onto a mock, or call `vi.spyOn()`, at module scope, inside a `vi.mock` factory, in a `describe` body or in `beforeAll`: the reset wipes the value and detaches the spy before the test runs (an implementation passed as `vi.fn(impl)` survives).
- Leave TypeScript errors: `bun run type:check` must pass.
- Settle for several assertions in one `it()` when they can be split.
- Ignore edge cases, or finish before every branch of the file under test is covered.
