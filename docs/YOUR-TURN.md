# Your turn

Things only you can decide or do.

Nothing here is urgent except the first one.

---

## Right now

### 1. Quit the app and open it again

Not reload. **Quit.**

Part of the app only picks up new code on a fresh start.

If you skip this, splitting says
*"Restart DJDaw to finish setting up splitting"*.

### 2. Look at pull request 53

The censor. It is ready.

https://github.com/KevinYuFu/DJDaw/pull/53

---

## Before you sell it

### 3. Pick one for the stem model

The model that splits stems has **no licence written on it**.

The weights it came from are MIT. The code that converted them is MIT.

The converted file itself says nothing.

**Option A — leave it**

Low risk. Weak paper trail.

Already written down in `THIRD-PARTY.md` so nothing is hidden.

**Option B — rebuild it myself**

I make the file from the MIT release instead.

Then the chain is written down at every step.

Costs: Python on the build machine. Half a day.

*Say the word and I do it.*

### 4. Have a lawyer glance at it

I can tell you where every piece came from.

I cannot tell you if that is enough where you live.

Everything they need is in `THIRD-PARTY.md`.

---

## Only if you start fresh

### 5. Run this after cloning

```
npm install
npm run fetch:model
```

The two AI models are **not** in git. They are too big.

That command pulls them. About 465 MB. Once.

---

## Not your problem

Written down so you know I know:

- Export does not warp yet
- Dropping a clip copies the whole file on the main thread
- ONNX ships twice, 46 MB, because two parts need different versions

These are mine to fix. Ask when you want them.
