# dsh-issues

**An issue tracker for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that hands issues to agents.**

Create an issue with a description for a project, like on GitHub or GitLab. The tracker starts an
agent session for it in its own private git clone, the agent works until its goal is complete,
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
  using a **private git clone and branch per issue** (`issue/iss-12-short-title`) so parallel work
  never collides and nothing touches your main checkout. Non-git projects run one issue at a time in place.
- The session gets a goal, so the agent keeps going over several rounds until it
  completes the goal or reports a blocker. Its closing message is stored as a comment.
- Restart-safe: interrupted issues are re-attached and their goals re-armed.
- Model tools for any session: `issue_create`, `issue_list`, `issue_get`, `issue_update`,
  `issue_comment`, `issue_dispatch`. A worker session may only read and comment on its own issue.
- A web page at `/dsh-issues/` with a status-filtered list, a full-size **New issue** dialog (press `N`), Markdown in descriptions and comments (with Write/Preview), accept/reopen/cancel and comments, and an **Issues** entry in the harness sidebar, below *Plugins* and *Automation tasks*, that opens the tracker inside the harness window in the harness theme (light/dark follows the harness setting). The same page also works on its own at `/dsh-issues/`. Markdown is rendered safely: no raw HTML, only http(s)/mailto links, no remote images.

You review the result on the issue's branch (copied into your repository when the agent finishes) and the linked session, then set the issue to *done*
(or reopen it with a comment, which sends it round again).

## Auto-merge

Tick **Auto-merge** on an issue (or turn on the default with `autoMerge: true`) and accepting the issue
starts a small *merge agent*. You can also press **Merge now** on any accepted issue that has a branch.

1. The agent works in its own throwaway clone on `merge/iss-N`, cut from the current tip of the base branch
   (the branch your repo had checked out when the work started). It merges the issue branch, resolves only conflicts
   whose correct result is clear, runs the project's checks and commits.
2. It reports `ready` or `conflict` with the `issue_merge_report` tool.
3. On `ready` the tracker itself verifies the result (the merge contains the issue branch, the worktree is clean, the
   base branch can be fast-forwarded), moves the base branch **fast-forward only** (never forced; a checked-out base
   branch with local changes in the way makes the merge fail cleanly instead), and deletes the merge branch and the
   issue's worktree and branch. If the base branch moved meanwhile, the tracker merges it in first.
4. On `conflict` (or if the agent stops without reporting), nothing in your base branch changes. A **new high-priority issue**
   is opened that starts from the issue's branch, says what has to be resolved and is auto-merge itself. When that one merges, the
   original issue is marked merged too.

The merge agent never pushes. Only one merge per project runs at a time. Issues without a branch (non-git projects) are skipped.

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
| `isolation` | `worktree` | `worktree` = every issue gets its own private clone and branch, and an issue is blocked (with the git error) if that is impossible; `auto` = clone for git projects, in place (no branch, one issue at a time) for non-git folders; `none` = always in place |
| `worktreeRoot` | next to the repo in `.dsh-worktrees/<repo>/` | where the clones go |
| `baseRef` | `HEAD` | what new issue branches start from |
| `maxGoalRounds` | 64 | round cap of the goal |
| `maxAttempts` | 3 | start failures before an issue is blocked |
| `completeStatus` | `needs_review` | status after the goal completes (`done` skips review) |
| `autoStart` | `true` | start waiting issues automatically; `false` = only via `issue_dispatch`/the UI button |
| `resumeOnStart` | `true` | re-attach interrupted issues on startup |
| `pollSeconds` | 60 | safety-net dispatch interval (0 = off) |
| `autoMerge` | `false` | default of the Auto-merge checkbox for new issues |
| `cleanupAfterMerge` | `true` | delete the worktrees and branches after a successful merge |
| `cleanupOnClose` | `true` | remove the worktree of an issue (and of its finished merge) once the issue is done or cancelled; the branch stays until it is merged |
| `forgetWorkspaces` | `true` | remove the harness workspace entries of those worktrees; the session logs are kept |
| `maxMergeRounds` / `maxConcurrentMerges` | 24 / 2 | goal round cap of a merge agent / parallel merges (one per project) |

### Settings page

Every option above is also editable in the harness UI: open **Plugins → dsh-issues**
and use the form under the description. Changes are written to your profile and apply
immediately (all options are live): new work uses the new values, while agents already
running keep the settings they started with.

## Cleanup

Every worktree the tracker creates (one per issue, one per merge) also shows up as a workspace in the harness. A background sweep removes both once they are no longer needed:

- the worktree of an issue that is **done** or **cancelled** (issues in review keep theirs), and the merge worktree of a finished merge;
- the workspace entries of removed worktrees, so they do not pile up in the workspace list;
- never while an agent still runs in that workspace, and never a worktree with uncommitted changes (the issue gets a comment instead and the folder stays);
- branches are not touched here: a branch holds the work until it has been merged.

Reopening an issue creates its clone again from the same branch. Session logs of removed workspaces are kept by the harness. Set `cleanupOnClose` or `forgetWorkspaces` to `false` to keep things.

## Scheduling

Dispatch is event-driven plus a poll timer, so no Schedule reminder is needed. If you want
issues to start only at certain times, set `autoStart: false` and let a Schedule reminder
in a session call `issue_dispatch`.

## Safety notes

- Issue text is passed to the agent as quoted data with working rules, but it is still
  model input: only let people you trust create issues.
- Agents work with the permission preset above. The tracker never pushes. It only merges when an issue has Auto-merge on (or you press Merge now), and never forces anything.
- **Why clones and not `git worktree`:** a linked worktree keeps its index, refs and objects in the main repository's `.git`, outside the folder a sandboxed agent may write to, so every commit asks the user for approval (`Unable to create '.git/worktrees/…/index.lock': Operation not permitted`). A clone has its own `.git` inside its folder, so the agent can commit with the default `workspace-write` sandbox and no prompts. Objects are hard-linked where the file system allows it, so a clone is quick and small. The tracker copies the branch into your repository (fast-forward only) when the agent finishes and before merging; the clone cannot push (`origin` is read-only for the agent). Worktrees created by earlier versions keep working.
- A clone has no submodules checked out and none of your repository's local hooks; install dependencies in the clone as usage requires.

## Verification

- `npm test` runs 86 tests: store and state machine, dispatcher, real git clones, the HTTP handler,
  and an integration test that loads the plugin into a real cordis context with the real storage stack
  (agent services faked). The integration test needs the harness; set `DSH_ISSUES_HARNESS_DIR` to run it.
- Not yet exercised: a full harness boot with a real model. The first real run is the real test; try it
  with a small issue in a scratch repository first.

## License

MIT, see [LICENSE](LICENSE).
