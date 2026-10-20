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

### Run Tests

```bash
bun run test                                          # the unit tests
bun run test src/utils/collection/ringBuffer.test.ts  # one file
bun run test:watch                                    # the unit tests, run again as you edit
bun run test:coverage                                 # the unit tests with coverage, as the pre-push hook and CI run them
bun run test:e2e                                      # the end-to-end tests
```

The unit tests are the `*.test.ts` files next to the code they test in `src/` and `scripts/`, and vitest runs them. `test:coverage` fails when the lines, functions, branches or statements covered fall below 95%.

The end-to-end tests in `test/e2e` run the whole pipeline of each mode on Bun's own test runner: `bun test --isolate test/e2e/<path_to_file>` runs one file. CI runs them, on the Bun version that `.github/workflows/ci.yml` pins, but the hooks do not, so run them before you open a pull request. The realtime flows run on real minutes under Bun's fake timers: a run of minutes lasts milliseconds and meets the same minutes every time.

### Check Formatting, Linting, Types and the Build

Before opening a pull request, ensure the codebase is clean:

```bash
bun run format:check
bun run lint:check
bun run type:check
bun run build:exec  # compiles the executable to dist/gekko
```

`format:check` and `lint:check` read the whole repository, the tests, the scripts and the configuration files included, not only `src/`; `bun run format` and `bun run lint` fix what they can. Prettier leaves `documentation/`, whose tables are aligned by hand, and `CHANGELOG.md` alone. A few rules you may meet:

- ESLint has no formatting rule: Prettier formats, and the pre-commit hook applies it to the files you stage.
- An unused parameter must start with `_`, even one followed by a parameter in use. An error you do not read is caught with `catch {`, since `catch (_err)` is refused too.
- Only the test files (`*.test.ts` and everything under `test/e2e`) may use an explicit `any`: the source and the benchmarks may not.
- `type:check` also covers `vitest.config.ts` and `scripts/release/version.cjs`: a misspelt vitest option fails it.

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

Releases are automated using [semantic-release](https://github.com/semantic-release/semantic-release). Every push to `main` runs it, in a job of its own once the checks have passed, with the git hooks turned off (`HUSKY=0`): it picks the next version from the commits since the last release, writes that version into `package.json` and the release notes into `CHANGELOG.md`, commits both to `main` and publishes the GitHub release with the executable. So never bump the version or edit `CHANGELOG.md` by hand.
