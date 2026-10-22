# Contributing to Gekko

Thank you for considering contributing to Gekko! This guide explains how to get the project running locally and how to submit your contributions.

## Getting Started

### Fork and Clone the Repository

Work lands on the `development` branch; `main` only moves for releases. Fork the repository on GitHub, clone your fork and switch to the upstream `development` branch:

```bash
git clone https://github.com/<your-username>/gekko.git
cd gekko
git remote add upstream https://github.com/youtix/gekko.git
git fetch upstream
git switch -c development upstream/development
```

### Install Bun and Node.js

Gekko runs on [Bun](https://bun.sh/) 1.3 or later. Follow the [installation instructions](https://bun.sh/docs/install) if you don't already have it.

The unit tests also need [Node.js](https://nodejs.org/) 22.13 or later (not 23), with `node` on your `PATH`: vitest runs them under Node. Without one, `bun run` runs vitest on Bun, where part of the suite fails and coverage is not supported, so the pre-push hook cannot pass.

### Install Dependencies

Use Bun to install the project dependencies:

```bash
bun install
```

This also installs three git hooks:

- pre-commit type-checks the code as you are committing it, not as it is in your working tree: it keeps a copy of the staged tree in `node_modules/.cache/index-check`, so an untracked file is not checked and an error names a file of that copy. It then runs ESLint and Prettier on the files you stage, the `.cjs`, `.mjs`, `.cts` and `.mts` ones included;
- commit-msg checks the commit message;
- pre-push runs the unit tests with coverage when you push a branch, not when you push a tag or delete a branch.

## Development Workflow

### Where the Code Lives

The repository is a monorepo of Bun workspaces, whose tasks [Turborepo](https://turborepo.com/) runs: six packages under `packages/` and two apps under `apps/`, in layers, each importing only some of the layers below it (ESLint refuses any other import, in a test too):

- `packages/shared` (`@gekko/shared`): the constants, the errors, the types, the generic utilities and the domain helpers. It imports no other package.
- `packages/schemas` (`@gekko/schemas`) and `packages/indicators` (`@gekko/indicators`): every zod schema, and the indicators.
- `packages/strategies` (`@gekko/strategies`) and `packages/core` (`@gekko/core`): the strategies, and the configuration, the pipeline, the orders, the exchanges and the storage.
- `packages/plugins` (`@gekko/plugins`): the plugins.
- `apps/gekko`, the bot, with the end-to-end tests, and `apps/fox`, Fox (see [the Fox guide](./documentation/fox.md)), each compiled to an executable in `dist/`.

A module of another package is imported by its package's name and its path under that package's `src/`, without `.ts` (`import { round } from '@gekko/shared/utils/math/round.utils'`); a module of the same package by a relative path. [CLAUDE.md](./CLAUDE.md) says what each package holds and the conventions the code follows.

### Run Tests

```bash
bun run test                                                                   # the unit tests of every package, and of scripts/
bun run --filter @gekko/shared test src/helpers/collection/ringBuffer.test.ts  # one file, run in its package
bun run test:coverage                                                          # the unit tests with coverage, as the pre-push hook and CI run them
bun run test:e2e                                                               # the end-to-end tests
```

The unit tests are the `*.test.ts` files next to the code they test, in each package's `src/` and in `scripts/`, and vitest runs them: `bun run test` runs every package's, one package at a time, through Turborepo, which replays a package's last results while nothing it reads has changed, the packages it imports included (`--force` runs them anyway). A run stops at the first package that fails: `bun run test --continue` runs the others. At the root, `bun run test <file>` does not work (Turborepo reads the file as a task name): use `bun run --filter <package> test <file>`. In a package's directory, `bun run test` runs its tests alone, `bun run test <file>` one file and `bun run test:watch` them again as you edit. `test:coverage` fails when the lines, functions, branches or statements a package's tests cover fall below 95%.

The end-to-end tests in `apps/gekko/test/e2e` run the whole pipeline of each mode on Bun's own test runner: from `apps/gekko`, `bun test --isolate test/e2e/<path_to_file>` runs one file. CI runs them, on the Bun version that `.github/workflows/ci.yml` pins, but the hooks do not, so run them before you open a pull request. The realtime flows run on real minutes under Bun's fake timers: a run of minutes lasts milliseconds and meets the same minutes every time.

### Check Formatting, Linting, Types and the Build

Before opening a pull request, ensure the codebase is clean:

```bash
bun run format:check
bun run lint:check
bun run type:check
bun run build:exec  # compiles the executables to dist/gekko and dist/fox
```

`format:check` and `lint:check` read the whole repository, the tests, the scripts and the configuration files included, not only the packages' sources; `bun run format` and `bun run lint` fix what they can. Prettier leaves the root's `documentation/`, whose tables are aligned by hand, and `CHANGELOG.md` alone. A few rules you may meet:

- ESLint has no formatting rule: Prettier formats, and the pre-commit hook applies it to the files you stage.
- An unused parameter must start with `_`, even one followed by a parameter in use. An error you do not read is caught with `catch {`, since `catch (_err)` is refused too.
- Only the test files (`*.test.ts` and everything under `apps/gekko/test/e2e`) may use an explicit `any`: the source and the benchmarks may not.
- A package may import only the packages below it: `@gekko/strategies` may not import `@gekko/core`, nor `@gekko/shared` any other package. ESLint names both packages of an import that goes up the graph.
- `type:check` checks each package with its own `tsconfig.json`, and `scripts/`, and also covers every `vitest.config.ts` and `scripts/release/version.cjs`: a misspelt vitest option fails it.

CI runs these four commands, `bun run test:coverage` and `bun run test:e2e` on every push and pull request to `development` and `main`, in a job whose token can only read the repository.

## Commit Message Guidelines

We use [Conventional Commits](https://www.conventionalcommits.org/) to keep our history readable, and the release reads them to pick the next version. A header reads `type(scope): subject`:

- the type is one of `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style` and `revert`; the scope is optional;
- the subject does not start with a capital letter and does not end with a full stop;
- the header is at most 125 characters long. The lines of the body and of the footers may be as long as you need.

`feat` releases a minor version and `fix` or `perf` a patch, while `docs`, `test`, `chore` and the like release nothing on their own. A breaking change releases a major version, whatever its type. Mark it either way:

- a `!` after the type or the scope (`feat!:`, `fix(trader)!:`), whose subject the release notes quote;
- a `BREAKING CHANGE:` footer (or `BREAKING-CHANGE:`) after a blank line, whose text the release notes quote.

`BREAKING CHANGE` is not a type: a header that starts with it is refused.

Example messages:

```
feat: add new configuration parser
fix: handle invalid YAML gracefully
chore: update dependencies
feat!: migrate to new API
```

A breaking change described in a footer:

```
feat(config): read the watched pairs from watch.assets

BREAKING CHANGE: watch.asset is replaced by watch.assets, a list of pairs.
```

The commit-msg hook checks each message as you commit, and CI checks the commits of every pull request and the commits pushed to `development` and `main`. To check messages by hand, run `bun run commit:check --last` (your last commit), `bun run commit:check --from upstream/development` (the commits of your branch) or `echo "feat: …" | bun run commit:check`.

## Creating Pull Requests

1. Create a branch from an up-to-date `development` (`git fetch upstream`, then `git switch -c feat/awesome-feature upstream/development`), with a descriptive name, e.g. `feat/awesome-feature` or `fix/edge-case`.
2. Make sure tests pass and the repository is lint-free by running the commands in the development workflow section.
3. Push the branch to your fork (`git push -u origin feat/awesome-feature`) and open a pull request against `development`, describing **what** you changed and **why**.

Do not open a pull request against `main`: merging into `main` runs the release.

## Release Process (Optional)

Releases are automated using [semantic-release](https://github.com/semantic-release/semantic-release). Every push to `main` runs it, in a job of its own once the checks have passed, with the git hooks turned off (`HUSKY=0`): it picks the next version from the commits since the last release, writes that version into the root `package.json` (the packages have none) and the release notes into `CHANGELOG.md`, commits both to `main` and publishes the GitHub release with the two executables, `gekko` and `fox`. So never bump the version or edit `CHANGELOG.md` by hand.
