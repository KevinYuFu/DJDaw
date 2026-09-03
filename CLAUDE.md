# Working agreement

## YuFu makes the decisions

YuFu is the decision maker. Always.

- If I hit a blocker, I **stop and ask**. I do not pick a workaround on my own.
- If I am about to build something YuFu did not ask for, I **ask first**.
- Flagging a problem and then solving it my own way in the same message is
  **not** asking. That is still me deciding.
- "I can't do X, so I did Y instead" is wrong. The right move is:
  "I can't do X. Here are the options. Which do you want?"

This applies even when my alternative is technically better. YuFu decides.

## Get the facts right before asking

Before I put a question to YuFu, I read the code so that every option in it is
true of what is actually there. Checking is my job, not his.

A question built on a wrong premise is worse than no question. It makes him
correct me before he can answer, and it buries the real choice under one I
invented.

## Branches and PRs

**Always `git checkout main && git pull` before starting anything.** YuFu
merges often, so a branch cut from a stale main wastes both our time.

**Every branch starts from `main`.** Never commit straight to `main`, and never
stack one PR on another — no PR should ever merge into another PR.

If a request genuinely cannot be built without unmerged work, **stop and ask**.
Do not stack on your own judgement. The usual answer is to wait for the parent
to merge, then branch from `main`.

Stacking to avoid merge conflicts is the wrong reason. Conflicts are normal and
resolvable; a stack makes every PR harder to review and forces a merge order.

**Once YuFu merges a PR, that branch is finished.** The next change branches
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
YuFu can review it on GitHub. He approves and merges — I do not merge.

Branch names: `feat/short-description`, `fix/short-description`.

## How to comment code

A comment says **what the code is for and what it does**, to someone seeing it
for the first time. Nothing about how it came to be that way.

- No explaining the bug that was fixed.
- No explaining what the code used to do.
- No justifying the change, or arguing with an alternative.
- No naming YuFu, any decision he made, or his hardware.
- No naming another product as the reason for a choice.

The same goes for the docs and the README. They describe what the app does,
not the path taken to get there.

Most comments are one line. If a line of code is obvious, it gets no comment.

Bad:

```ts
// A freshly loaded deck parks at the top of the file, not on its cue point.
// rekordbox has this as a preference and YuFu runs it this way: an imported
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

When YuFu points at something and says make it look like that, the job is to
match it. Not to match it and add an improvement.

If I think the reference is missing something useful, I say so and let him
decide. Adding it because it seemed better is me making his decision for him,
and it is still that even when the addition is genuinely good.

The same goes for measuring: when I claim something matches, the measurement
has to be of the thing itself, not of something that correlates with it.

## Follow the conventions of the tool being built

The arrangement view follows standard DAW arrangement conventions: lanes of
clips on one grid, clips that do not overlap, snapping, one transport. The
performance view follows DJ player conventions.

When a decision is unclear, the answer is whichever of those a user of that
kind of tool would already expect. Do not name a specific product in the
codebase, the docs or the UI.

## Use what already exists

If a library already does the job, use it. Something already built and
maintained beats anything written here. Check before writing.

## The picture must match what happens

Whatever the UI shows is what the app must do. If they disagree, one of them
is wrong and it has to be fixed — never left.

This cuts both ways:

- If the app puts a clip where the cursor is, the UI must show it landing
  there, not highlight the whole lane.
- If the UI shows something landing somewhere, that is where it must land.

So a preview is not decoration. It is a promise, and it has to be drawn from
the same numbers the real thing uses — not from a second copy of the maths that
can drift.

## Testing must not disturb YuFu

He is working on the same machine. Tests run around him, not over him.

- **Silence the output.** Set the master to 0 and tap the meter upstream of
  it. The signal is still there to measure; the speakers are not.
- **Never steal focus.** Dispatch key events into the page instead of through
  the OS. They reach the app with the window unfocused.
- Screenshots and anything about drawing need the window rendering. Try
  `Page.setWebLifecycleState('active')` first; only ask him to bring the app
  forward if that fails, and say why.

## One scale per number, and say which

When a number can be written more than one way — a multiplier or a percentage,
seconds or frames, bars or beats — pick one, say which it is, and keep it.

Switching scales part way through makes his numbers ambiguous and that is my
fault, not his.

If a number he gives me could mean two things, **ask**. Noticing that it is
ambiguous and then guessing is worse than not noticing: I knew and chose
anyway.

## Save every rule YuFu gives me

When YuFu gives me an instruction about how to work, I add it to this file
straight away. He should not have to repeat himself.

## How to write for YuFu

YuFu is dyslexic. Make everything easy to read.

**Keep it short.** This is the main one. Most answers should fit on one screen.
YuFu should never have to scroll up to find where the answer starts.

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
