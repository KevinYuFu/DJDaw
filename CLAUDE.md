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

Every new feature goes on its own branch. Never commit straight to `main`.

After each code change, push the branch and open (or update) a pull request, so
Kevin can review it on GitHub. He approves and merges — I do not merge.

Branch names: `feat/short-description`, `fix/short-description`.

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
