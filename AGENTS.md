# NanoClaw

Personal Claude assistant: a single Node.js process connects to WhatsApp, routes messages to the Claude
Agent SDK running in containers, and gives each chat group an isolated filesystem and memory. Philosophy and
setup: `README.md`; architecture decisions: `docs/REQUIREMENTS.md`; more in `docs/` (SPEC, SECURITY,
DEBUG_CHECKLIST).

`origin` is the fork `ostheimer/nanoclaw` of `nanocoai/nanoclaw` (remote `upstream`). The `/update` skill
merges upstream changes into an installation.

## Layout

```
src/index.ts              Orchestrator: state, message loop, agent invocation
src/channels/whatsapp.ts  WhatsApp connection, auth, send/receive (src/email-channel.ts: email channel)
src/ipc.ts                IPC watcher and task processing
src/router.ts             Message formatting and outbound routing
src/config.ts             Trigger pattern, paths, intervals
src/container-runner.ts   Spawns agent containers with mounts; src/container-runtime.ts is the runtime abstraction
src/task-scheduler.ts     Scheduled tasks
src/db.ts                 SQLite (better-sqlite3)
container/                Agent image: Dockerfile, build.sh, agent-runner/, skills/ (e.g. agent-browser.md, available to all agents via Bash)
groups/{name}/CLAUDE.md   Per-group memory, see "Prompts" below
skills-engine/, scripts/  Skills system (apply, uninstall, rebase, update, CI matrix)
setup/                    Implementation behind the /setup skill
.claude/skills/           Claude Code skills: /setup, /customize, /debug, /update, add-* feature skills, /qodo-pr-resolver, /get-qodo-rules
launchd/com.nanoclaw.plist  macOS service definition
```

## Commands

```bash
npm run dev            # tsx src/index.ts (no watch mode)
npm run build          # tsc
npm test               # vitest run
npm run typecheck      # tsc --noEmit
npm run format:check   # prettier, src/**/*.ts only (singleQuote)
./container/build.sh   # build the nanoclaw-agent image (CONTAINER_RUNTIME, default docker)
```

Service: macOS launchd label `com.nanoclaw` (`launchctl kickstart -k gui/$(id -u)/com.nanoclaw` restarts it);
Linux systemd unit `nanoclaw.service` (`systemctl --user restart nanoclaw`). Both are written by `setup/service.ts`.

## Prompts: groups/global and groups/main

`groups/global/CLAUDE.md` and `groups/main/CLAUDE.md` are not rules for working on this repo. They are the
prompts the running bot reads: the global file is injected as system context for non-main groups
(`container/agent-runner/src/index.ts`), the main file is the main group's working-directory memory.
`setup/register.ts` rewrites `# Andy` and `You are Andy` in both when the assistant is renamed. Edit them
only to change the bot's behavior, and keep those two patterns intact.

## Contribution policy and CI

- Source changes accepted: bug fixes, security fixes, simplifications, code reduction. Features and
  integrations are skills in `.claude/skills/` containing instructions for Claude, not pre-built code
  (`CONTRIBUTING.md`).
- CI is enforced on PRs to `main`: `test.yml` (`tsc --noEmit`, `vitest run`, Node 20); `skills-only.yml` fails a
  PR that adds files under `.claude/skills/` and also touches `src/`, `container/`, `package.json` or
  `package-lock.json`; `skill-tests.yml` applies overlapping skill combinations when `skills-engine/`,
  `.claude/skills/` or `src/` change.
- Pushes to `main` trigger bot commits: `bump-version.yml` (on `src/**` or `container/**`) raises the patch
  version in `package.json` and pushes `chore: bump version to X`; `update-tokens.yml` (on `src/**`,
  `container/**`, `launchd/**`, `CLAUDE.md`, `AGENTS.md`) rewrites the token badge in `README.md` and
  `repo-tokens/badge.svg`. Neither publishes a package or tags a release. Both need the secrets `APP_ID` and
  `APP_PRIVATE_KEY`.
- Commit messages use conventional prefixes (`feat:`, `fix:`, `docs:`, `chore:`).

## Pitfalls

- Agents run in containers; `src/container-runtime.ts` hardcodes `docker` as the runtime. The
  `convert-to-apple-container` skill switches it.
- The main group gets the project root mounted read-only at `/workspace/project`, so the agent cannot modify
  host code; other groups only see their own folder and the global memory directory (read-only).
- The container build cache keeps stale files: `--no-cache` alone does not invalidate COPY steps. For a
  clean rebuild, prune the builder first, then rerun `./container/build.sh`.
- `groups/*` is gitignored except the two CLAUDE.md files above; everything else under `groups/`, plus
  `store/`, `data/`, `logs/` and `.env`, is local state and is never committed.
