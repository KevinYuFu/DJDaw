# Working agreement

## Kevin makes the decisions

Kevin is the decision maker. Always.

- If I hit a blocker, I **stop and ask**. I do not pick a workaround on my own.
- If I am about to build something Kevin did not ask for, I **ask first**.
- Flagging a problem and then solving it my own way in the same message is
  **not** asking. That is still me deciding.
- "I can't do X, so I did Y instead" is wrong. The right move is:
  "I can't do X. Here are the options. Which do you want?"

This applies even when my alternative is technically better. Kevin decides.

## Branches and PRs

**Always `git checkout main && git pull` before starting anything.** Kevin
merges often, so a branch cut from a stale main wastes both our time.

**Every branch starts from `main`.** Never commit straight to `main`, and never
stack one PR on another — no PR should ever merge into another PR.

If a request genuinely cannot be built without unmerged work, **stop and ask**.
Do not stack on your own judgement. The usual answer is to wait for the parent
to merge, then branch from `main`.

Stacking to avoid merge conflicts is the wrong reason. Conflicts are normal and
resolvable; a stack makes every PR harder to review and forces a merge order.

**Once Kevin merges a PR, that branch is finished.** The next change branches
from `main` again, even when it is more of the same work. Pushing to a merged
branch puts the commits nowhere: they are not on `main` and there is no open PR
to review them.

**After every push, check there is an open PR containing it.** `gh pr list`.

**Before deleting a branch, check it is merged**, not just that a PR existed
for it. `git rev-list --count main..<branch>` must be 0.

**Check `git branch --show-current` before starting any work, and again before
launching subagents.** Subagents inherit whatever branch the tree is on. I have
shipped work onto the wrong branch once by switching to test something and
forgetting to switch back — verify, do not assume.

**Check `git branch --show-current` before starting any work, and again before
launching subagents.** Subagents inherit whatever branch the tree is on. I have
already shipped work onto the wrong branch once by switching branches to test
something and forgetting to switch back — verify, do not assume.

After each code change, push the branch and open (or update) a pull request, so
Kevin can review it on GitHub. He approves and merges — I do not merge.

Branch names: `feat/short-description`, `fix/short-description`.

## How to comment code

A comment says **what the code is for**, to someone seeing it for the first
time. Nobody remembers the history of the code, so do not write it down.

- No explaining the bug that was fixed.
- No explaining what the code used to do.
- No justifying the change, or arguing with an alternative.
- No naming Kevin, or any decision he made.

Most comments are one line. If a line of code is obvious, it gets no comment.

Bad:

```ts
// A freshly loaded deck parks at the top of the file, not on its cue point.
// rekordbox has this as a preference and Kevin runs it this way: an imported
// track carries a memory cue from wherever the last edit left off, and loading
// straight onto it hides the intro.
const start = 0
```

Good:

```ts
// Load from track start.
const start = 0
```

The same goes for commit messages and PR descriptions. Say what changed and
what it does now. Keep it short.

## Matching a reference means matching it

When Kevin points at something and says make it look like that, the job is to
match it. Not to match it and add an improvement.

If I think the reference is missing something useful, I say so and let him
decide. Adding it because it seemed better is me making his decision for him,
and it is still that even when the addition is genuinely good.

The same goes for measuring: when I claim something matches, the measurement
has to be of the thing itself, not of something that correlates with it.

## Ableton is the reference for the arrangement view

The arrangement view (V3) is Ableton Live's arrangement view. When a decision
is unclear, the answer is how Ableton does it. Rekordbox is still the reference
for the performance view.

## Use what already exists

If a library already does the job, use it. Something already built and
maintained beats anything written here. Check before writing.

## Save every rule Kevin gives me

When Kevin gives me an instruction about how to work, I add it to this file
straight away. He should not have to repeat himself.

## How to write for Kevin

Kevin is dyslexic. Make everything easy to read.

**Keep it short.** This is the main one. Most answers should fit on one screen.
Kevin should never have to scroll up to find where the answer starts.

- Lead with the answer. First line, no preamble.
- Short sentences.
- Short paragraphs. One idea each.
- Headings and bullets to break things up.
- White space between blocks.
- **Bold** the key words, but not too much.
- No italics. Harder to read.
- No walls of text.

If there is a lot of detail, give the short answer and offer the detail.
Do not dump it all at once.

## Project

DJDaw. A rekordbox-style DJ app for building edits and mashups.

See `docs/ARCHITECTURE.md` for how it is put together.
