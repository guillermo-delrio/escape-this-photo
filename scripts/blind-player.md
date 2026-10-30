# Blind player brief (fix 1b)

Given to a fresh Claude agent per room, with `{PORT}`, `{APP}` and `{OUT}` filled in. The agent has never seen the
room's data; it plays through `scripts/blind.mjs` and sees only what a phone shows.

---

You are play-testing an escape-room game on a phone, as a first-time player. The room is built from a photo. Your job
is to escape it **using only what the screen shows you**, and then report honestly how it went.

**How to play.** Run commands with Bash, from `{APP}`:

    node scripts/blind.mjs {PORT} <command>

Commands: `look`, `start`, `tap <x> <y>`, `swipe left|right`, `turn left|right`, `item <n>`, `dial <digits>`, `back`.

- Every command prints the path of a screenshot of the phone (390×844 points) and the words on screen. **Open every
  screenshot with the Read tool and look at it** before deciding what to do next: the room is a picture, and the
  things you can tap are things in it. `tap x y` is a finger tap at that point of the screenshot.
- `start` presses "Start". A room can be wider than the screen (`swipe left` shows more to the right; the
  `view` line says which part of the wall you see), and can have several walls (`turn left|right`). Tapping an object either says something or opens a close-up; `back`
  closes a close-up or a lock.
- Pocket: things you pick up appear numbered in `pocket`. `item <n>` taps one: a note opens to read; anything else is
  selected, and your next `tap` uses it on that point of the room. Tapping two items in turn combines them.
- A code lock opens when you tap its object at the right moment; `dial <digits>` sets the digits and turns the handle.
  **You get 3 wrong codes per lock, then the harness refuses.** So don't guess: work the code out from what the room
  tells you, and count carefully in the close-ups.

**Rules.** Read nothing but the screenshots under `{OUT}` and the command output. Do not open the room's files, the
game's source, the server or its API, and do not use `curl` or a browser of your own. Play at most 120 commands.

**Report**, as your final message, in this shape:

    ESCAPED: yes|no
    COMMANDS: <how many you used>
    WRONG CODES: <lock: tries, …>
    STUCK AT: <if not escaped: what you were trying and why it failed>
    COUNTS: <for every count you made: what the clue asked, what you counted in the close-up, and whether it opened the lock>
    UNFAIR: <anything that misled you: a clue that didn't match the picture, a thing you couldn't tap, words that described something wrong, a dead end>
    ROUGH EDGES: <smaller confusions a first-time player would hit>
