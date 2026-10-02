# dsh-issues

**An issue tracker for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that hands issues to agents.**

Create an issue with a description for a project, like on GitHub or GitLab. The tracker starts an
agent session for it in its own git worktree, the agent works until its goal is complete,
and the issue lands in **needs review**.

```
open ──► in_progress ──► needs_review ──► done
            │  ▲               │
            ▼  │               └──► open (reopen with a comment)
         blocked
```

> Status: first version, built against dsh 0.2.0-rc.2 (developer preview); the harness APIs it
> uses are still moving. See "Verification" for what has and has not been exercised.

## What you get

- Issues per project (`ISS-1`, `ISS-2`, …) with title, description, priority, labels, comments.
- Status flow: `open → in_progress → needs_review → done`, plus `blocked` and `cancelled`.
- A dispatcher that starts a session per open issue (limits: `maxConcurrent`, `maxPerProject`),
  using a **git worktree and branch per issue** (`issue/iss-12-short-title`) so parallel work
  never collides and nothing touches your main checkout. Non-git projects run one issue at a time in place.
- The session gets a goal, so the agent keeps going over several rounds until it
  completes the goal or reports a blocker. Its closing message is stored as a comment.
- Restart-safe: interrupted issues are re-attached and their goals re-armed.
- Model tools for any session: `issue_create`, `issue_list`, `issue_get`, `issue_update`,
  `issue_comment`, `issue_dispatch`. A worker session may only read and comment on its own issue.
- A web page at `/dsh-issues/` (list, filters, create, accept/reopen/cancel, comment).

You review the result in the issue's worktree/branch and the linked session, then set the issue to *done*
(or reopen it with a comment, which sends it round again).

## Install

```
dsh plugin --profile web add /path/to/dsh-issues
dsh web
```

`dsh plugin … add` registers the package in the profile and mounts its bundle (the
tracker plus the web page). Then open the Harness UI once (so your browser holds the
session cookie) and visit `<your harness url>/dsh-issues/`. The page is protected by the
harness's own connection check.

The plugin finds the harness packages it builds on (cordis, tools, storage, …) from the
running `dsh`. If it ever reports "cannot find @deepseek-ai/…", set
`DSH_ISSUES_HARNESS_DIR` to any directory inside the harness installation (for example
the folder of the `@deepseek-ai/dsh` package).

To change settings, override the row in your profile's `cordis.patch.yml` (see below).

## Configuration (`cordis.patch.yml`)

| key | default | meaning |
| --- | --- | --- |
| `agentPreset` | `standard` | agent preset for worker sessions |
| `permissionPreset` | `workspace-write` | permission preset; **asks** before actions outside the sandbox, so unattended runs stall until you answer. `danger-full-access` never asks – use only in a throwaway environment |
| `maxConcurrent` / `maxPerProject` | 2 / 1 | parallel sessions overall / per project |
| `isolation` | `auto` | `auto` = worktree for git projects, in place otherwise; `worktree`; `none` |
| `worktreeRoot` | next to the repo in `.dsh-worktrees/<repo>/` | where worktrees go |
| `baseRef` | `HEAD` | what new issue branches start from |
| `maxGoalRounds` | 64 | round cap of the goal |
| `maxAttempts` | 3 | start failures before an issue is blocked |
| `completeStatus` | `needs_review` | status after the goal completes (`done` skips review) |
| `autoStart` | `true` | start waiting issues automatically; `false` = only via `issue_dispatch`/the UI button |
| `resumeOnStart` | `true` | re-attach interrupted issues on startup |
| `pollSeconds` | 60 | safety-net dispatch interval (0 = off) |

## Scheduling

Dispatch is event-driven plus a poll timer, so no Schedule reminder is needed. If you want
issues to start only at certain times, set `autoStart: false` and let a Schedule reminder
in a session call `issue_dispatch`.

## Safety notes

- Issue text is passed to the agent as quoted data with working rules, but it is still
  model input: only let people you trust create issues.
- Agents work with the permission preset above; review branches before merging. The tracker never merges or pushes.

## Verification

- `npm test` runs 44 tests: store and state machine, dispatcher, real git worktrees, the HTTP handler,
  and an integration test that loads the plugin into a real cordis context with the real storage stack
  (agent services faked). The integration test needs the harness; set `DSH_ISSUES_HARNESS_DIR` to run it.
- Not yet exercised: a full harness boot with a real model. The first real run is the real test; try it
  with a small issue in a scratch repository first.

## License

MIT, see [LICENSE](LICENSE).
