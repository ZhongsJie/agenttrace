---
name: verify-tool-result-boundary
description: Exhaustively check AgentTrace's tool-result visibility within the replay fixture bounds. Use when changing rollout tool pairing, the replay timeline, seek behavior, tool projection flags, or investigating results that appear early, stay visible after rewinding, or cross threads.
---

# Verify the tool-result boundary

A replay projection must mark a tool result visible only at or after that call's own result event, regardless of seek history. Reusing a call ID in another thread must not move a result to the wrong call. A violation makes the replay show information before it was available or attribute it to the wrong action.

## Run the check

From the AgentTrace root, run `node verification/verify-tool-result-boundary.cjs`. The script uses only Node built-ins and the repository's JavaScript. It was last run with Node 26.13.0. Do not substitute the ordinary replay tests for this run: they cover examples, not the enumerated histories.

## Know what it covers

- `src/core/parser.js`: `parseRollout`, including the `callKey` identity and the `function_call` / `function_call_output` branches.
- `src/core/replay.js`: `buildReplay` for recorded and presentation timestamps; `projectReplay` and `projectViews` for result visibility; `createPlayer` and `reducePlayback` for `seek` notifications.
- Exactly 2,481 ordered JSONL histories: two explicit threads in one turn share one call ID. Each thread has no records, a start only, an orphan result only, or a start followed in file order by a result. Start and result timestamps independently take values 0, 2, 4 milliseconds after a metadata anchor or are omitted. All order-preserving interleavings of the two threads are included. The oracle takes expected output and thread identity from the generated rows, not from the parsed steps.
- The checker probes at each event time and half a millisecond on either side, plus the playback endpoints and one millisecond outside them. These are concrete cursor samples, not an assertion about every possible number. On every history it also seeks to the end, to zero, and back to the end, checking emitted playback snapshots. It compares the raw projection, the tools view, and both conversation sources.

This is bounded exhaustive verification of the real JavaScript, not a theorem over all inputs. It does not cover multiple calls per thread, multiple turns, duplicate protocol notifications, other event formats, non-seek player commands, browser rendering, or the page's full-session raw-record inspector. `outputVisible` controls presentation; the check does not assert that the raw result is absent from memory.

## Interpret the result

- `PASS` means all enumerated comparisons passed. Report the fixture count and the bounds rather than claiming universal correctness.
- `Counterexample:` gives the generated records in file order, the projection or snapshot, the cursor, and expected versus actual entries. Each entry is `[thread, outputVisible, displayedResult]`. Explain the first mismatch in those terms. Compare the raw row times and the documented presentation fallback before deciding whether the oracle or the product is wrong. Do not change the oracle to make an unexplained product failure disappear.
- Treat a setup exception or an unsupported mutation anchor as unverified, not a counterexample. Recheck the changed code and checker before reporting a verdict.

## Keep the check synchronized

Last matched against production source at `41dd62505991a180faa78d7139bf41b88dad90ad`. Compare that revision to the working tree with `git diff 41dd62505991a180faa78d7139bf41b88dad90ad -- src/core/parser.js src/core/replay.js`. If the covered code changed, confirm that the input generator and expectation rules still describe it. After any intentional change to the verification, run:

```sh
node verification/verify-tool-result-boundary.cjs --mutation-check
node verification/verify-tool-result-boundary.cjs
```

The first command copies production sources into three scratch variants. One removes the result timing guard, one drops thread identity from the call key, and one emits end-of-session results after a rewind. Each variant must fail with a behavioral counterexample, not an exception. The command leaves the working tree's production files untouched. Advance the recorded revision only after checking these seams and verifying the unmodified implementation at the new commit. Use `/maintain-formal-verification-skill` if a later change skipped this review.
