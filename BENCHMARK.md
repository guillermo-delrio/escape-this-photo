# Room benchmark (27–28 Oct 2026)

Fifteen photos of rooms from Wikimedia Commons (`local/bench/photos.json` lists titles and licences), each built on this
PC with `scripts/bench.sh`, which writes one line per room to `local/bench/results.jsonl`. Four of them were also
built with three painted walls. The mix: modern colour rooms like a phone photo (kitchens, living rooms, a home office),
historic interiors, a castle bedroom, an abandoned house, one portrait-shaped photo and one photo with people in it.

**All 19 runs done** (27 Oct, and the last five on 28 Oct after the daily cap reset). Total spend $4.31.

## Results

| Kind | Built | Cost per room | Time | Rewrites |
|---|---|---|---|---|
| One photo | 12 of 15 (2 refused at the door, 1 failed its checks) | $0.14–0.25, mean $0.20 | 66–82 s, mean 74 s | 1 room needed 1 |
| One photo + 3 painted walls | 4 of 4 | $0.43–0.47, mean $0.45 | 124–142 s, mean 133 s | 0 |

- A painted room costs about **2.5×** a one-photo room, not 4× as guessed.
- **Failure:** "Kitchen with island" failed its checks after two rewrites ($0.15, 95 s). In all three attempts the
  solver found no way out: there were soft-locks and the solution had 0 steps. The puzzle writer seems to struggle with a
  bare modern kitchen that has few loose objects.
- **Refusals:** the couple at home was refused because it shows people, as intended ($0.006, 2 s). Daphne du Maurier's
  study was refused because "the desk has framed photos showing people" ($0.008). Many real homes have family photos on
  a shelf, so this rule will refuse a share of the judges' rooms. Whether framed photos should pass is a privacy call
  that is still open.
- **A refused close-up:** in the Vaals room, a crop of a painting on the wall was refused because the painting shows a
  person. The room was still built without that close-up.
- Each refusal costs under a cent, so the content check is a cheap door.

## What it means for the judges' allowance

The cloud caps are $5 a day and $100 in all. At $0.45 for a painted room, $5 a day is about 11 painted rooms, or 25 rooms
from one photo. Forty painted rooms cost about $18 in all, well under $100, but the daily cap binds first. A busy judging
day could run out by mid-day if the paint box stays on by default.
