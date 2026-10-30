import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { apply, codeLock, combine, initialState, objectText, roomWalls, tap, won } from "./engine/engine";
import type { Action, Picture, Point, Room, RoomObject, State } from "./engine/types";
import { closeupBox } from "./engine/shapes";
import { vanGogh } from "./rooms/vanGogh";
import { Made } from "./Made";

const STEP_MARK: Record<Action["kind"], string> = { inspect: "🔍", use: "🗝️", combine: "🧩", code: "🔢" };
const HINT_AFTER_MS = 25_000;

const fmtTime = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// A word from the room, pinned where the player tapped; it lingers long enough to read, then fades.
interface Bubble { text: string; x: number; y: number; tone: "plain" | "found" | "miss"; key: number }
// A close-up lifted off the wall: it grows out of the tapped point and goes back on a tap anywhere.
interface Zoom { text: string; x: number; y: number; image?: string; closeup?: { picture: Picture; polygon: Point[] }; note?: Note }
// A note held up to read: its words typeset on its painted page, with a way to use it when the room has a use for it.
interface Note { id: string; name: string; paper?: string; usable: boolean; guides: boolean }
type At = { x: number; y: number };

const lingerMs = (text: string) => Math.min(7000, Math.max(2200, 1200 + text.length * 55));
const bubbleReach = () => Math.min(innerWidth - 32, 300) / 2 + 16;
const atEvent = (e: { clientX: number; clientY: number; currentTarget: Element }): At =>
  e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : centre(e.currentTarget);
const centre = (el: Element): At => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

// /r/<id> plays a generated room, /r/<id>/made shows how it was made, /rooms lists the gallery; anything else opens on
// Van Gogh's Bedroom.
export default function App() {
  if (location.pathname === "/rooms") return <Gallery />;
  const made = location.pathname.match(/^\/r\/([0-9a-f]{10})\/made$/)?.[1];
  if (made) return <Made id={made} />;
  return <Play />;
}

type Loaded = Room & { curated?: boolean };
function Play() {
  const id = location.pathname.match(/^\/r\/([0-9a-f]{10})$/)?.[1];
  const [room, setRoom] = useState<Loaded | undefined>(id ? undefined : { ...vanGogh, curated: true });
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!id) return;
    fetch(`/api/rooms/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("This room doesn't exist."))))
      .then(setRoom, (e: Error) => setError(e.message));
  }, [id]);
  if (error || !room)
    return (
      <main className="game">
        <TopBar />
        <div className="stage">
          <div className="card">
            <p className="text">{error ?? "Opening the room…"}</p>
            {error && <a className="primary" href="/rooms">Choose another room</a>}
          </div>
        </div>
      </main>
    );
  return <Game room={room} id={id} />;
}

function TopBar({ title, clock }: { title?: string; clock?: string }) {
  return (
    <header className="bar">
      <a className="back" href="/rooms" aria-label="All rooms">
        <span aria-hidden="true">‹</span> Rooms
      </a>
      {title && <i className="bar-title">{title}</i>}
      <span className="clock" aria-label="Time">{clock}</span>
    </header>
  );
}

function Game({ room, id }: { room: Loaded; id?: string }) {
  const [phase, setPhase] = useState<"intro" | "play" | "won">("intro");
  // ?pocket=<item id> starts with that item, so the screenshot scripts can open any room's note (like ?outlines).
  const [state, setState] = useState<State>(() => {
    const give = new URLSearchParams(location.search).get("pocket");
    return give && room.items.some((i) => i.id === give) ? { items: [give], flags: [] } : initialState();
  });
  const [selected, setSelected] = useState<string>();
  const [said, setSaid] = useState(room.intro); // the last thing said, for screen readers
  const [bubble, setBubble] = useState<Bubble>();
  const [zoom, setZoom] = useState<Zoom>();
  const [lock, setLock] = useState<string>(); // target whose code lock is open
  const [steps, setSteps] = useState<string[]>([]);
  const [startedAt, setStartedAt] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [flash, setFlash] = useState<string>();
  const [hint, setHint] = useState(false);
  const [wall, setWall] = useState(0);
  const [ending, setEnding] = useState<string>();
  const lastProgress = useRef(0);
  const bubbleTimer = useRef<number>(undefined);
  const pan = useRef<HTMLDivElement>(null);

  const walls = useMemo(() => roomWalls(room), [room]);
  const picture = walls[wall];
  const onWall = room.objects.filter((o) => (o.wall ?? 0) === wall);
  const pictureOf = (o: RoomObject) => walls[o.wall ?? 0] ?? walls[0];
  const turn = (d: number) => {
    setWall((w) => (w + d + walls.length) % walls.length);
    setBubble(undefined);
  };

  // The picture fills the stage's height; a wall wider than the phone pans sideways, starting from its middle.
  useLayoutEffect(() => {
    const el = pan.current;
    if (el) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
    edges();
  }, [wall, room]);

  // Which sides of the wall are off-screen, so the edges can show there is more to see (a blind player never found
  // a fish tank at the far left of a wide photo once the opening hint had faded).
  const [more, setMore] = useState({ left: false, right: false });
  function edges() {
    const el = pan.current;
    if (!el) return;
    const left = el.scrollLeft > 8;
    const right = el.scrollLeft < el.scrollWidth - el.clientWidth - 8;
    setMore((m) => (m.left === left && m.right === right ? m : { left, right }));
  }

  const objects = useMemo(() => new Map(room.objects.map((o) => [o.id, o])), [room]);
  const items = useMemo(() => new Map(room.items.map((i) => [i.id, i])), [room]);

  useEffect(() => {
    if (phase !== "play") return;
    const t = setInterval(() => {
      setElapsed(Date.now() - startedAt);
      if (Date.now() - lastProgress.current > HINT_AFTER_MS) {
        lastProgress.current = Date.now();
        setHint(true);
        setTimeout(() => setHint(false), 1800);
      }
    }, 500);
    return () => clearInterval(t);
  }, [phase, startedAt]);

  function say(text: string, at: At, tone: Bubble["tone"] = "plain") {
    setSaid(text);
    clearTimeout(bubbleTimer.current);
    setBubble({ text, ...at, tone, key: Date.now() });
    bubbleTimer.current = window.setTimeout(() => setBubble(undefined), lingerMs(text));
  }

  // Something to look at closely zooms out of the tap; anything else is said there.
  function show(text: string, at: At, tone: Bubble["tone"], image?: string, closeupOf?: string) {
    const o = closeupOf ? objects.get(closeupOf) : undefined;
    if (image || o) {
      setSaid(text);
      setBubble(undefined);
      setZoom({ text, ...at, image, closeup: o && { picture: pictureOf(o), polygon: o.polygon } });
    } else say(text, at, tone);
  }

  function run(a: Action, at: At) {
    const next = apply(state, a);
    setState(next);
    setSteps((s) => (a.effect.gives || a.effect.sets || a.effect.reveals ? [...s, STEP_MARK[a.kind]] : s));
    lastProgress.current = Date.now();
    if (won(room, next)) {
      setElapsed(Date.now() - startedAt);
      setEnding(a.effect.message);
      setBubble(undefined);
      setPhase("won");
      return;
    }
    show(a.effect.message, at, "found", a.effect.image, a.effect.closeup);
  }

  function onObject(id: string, at: At) {
    setFlash(id);
    setTimeout(() => setFlash(undefined), 450);
    const o = objects.get(id)!;
    if (selected) {
      const a = tap(room, state, id, selected);
      setSelected(undefined);
      if (a) run(a, at);
      else say(`The ${items.get(selected)!.name} does nothing to the ${o.label}.`, at, "miss");
      return;
    }
    const a = tap(room, state, id);
    if (a) return run(a, at);
    if (codeLock(room, state, id)) {
      setLock(id);
      setSaid(o.description ?? `The ${o.label} has a lock.`);
      return;
    }
    // Once something has changed it, the painted close-up of how it was is gone too.
    const now = objectText(room, state, id);
    show(now.text, at, "plain", now.changed || now.closeup ? undefined : o.detail, now.closeup);
  }

  function onItem(id: string, at: At) {
    const it = items.get(id)!;
    // A note is read with one tap; it is picked up to use from the page, if the room has a use for it.
    if (it.text && !selected) {
      const usable = room.actions.some((a) => (a.kind === "use" && a.item === id) || (a.kind === "combine" && a.items.includes(id)));
      setSaid(it.text);
      setBubble(undefined);
      // A note that opens close-ups says so: a blind player read one, then counted from the wall and never tapped again.
      const guides = room.actions.some((a) => a.kind === "inspect" && a.effect.closeup && a.when?.items?.includes(id));
      setZoom({ text: it.text, ...at, note: { id, name: it.name, paper: it.paper, usable, guides } });
      return;
    }
    if (!selected || selected === id) {
      setSelected(selected === id ? undefined : id);
      say(selected === id ? it.description : `${it.name}: tap where to use it.`, at);
      return;
    }
    const a = combine(room, state, selected, id);
    setSelected(undefined);
    if (a) run(a, at);
    else say("Those don't go together.", at, "miss");
  }

  function start() {
    setPhase("play");
    setStartedAt(Date.now());
    lastProgress.current = Date.now();
    const el = pan.current;
    if (el && el.scrollWidth > el.clientWidth + 8) {
      const r = el.getBoundingClientRect();
      say("Swipe sideways to look around the room.", { x: r.left + r.width / 2, y: r.top + r.height / 2 });
    }
  }

  const shareText = `Escape This Photo: ${room.title}\n${steps.join("")} ${fmtTime(elapsed)}\n${location.href}`;
  const credit = picture.painted ? "Painted by Meta's Muse Image from the photo." : picture.credit;

  return (
    <main className={`game phase-${phase}`}>
      <TopBar title={room.title} clock={phase === "intro" ? undefined : fmtTime(elapsed)} />

      <div className={`stage${hint ? " hint" : ""}${selected ? " aiming" : ""}${location.search.includes("outlines") ? " outlines" : ""}`}>
        <div className="pan" ref={pan} onScroll={edges}>
        <svg key={wall} className="scene" viewBox={`0 0 ${picture.width} ${picture.height}`} style={{ aspectRatio: `${picture.width} / ${picture.height}` }} role="img" aria-label={walls.length > 1 ? `${room.title}, wall ${wall + 1} of ${walls.length}` : room.title}>
          {/* A tap on nothing answers too, so the last bubble never reads as the answer to it (blind plays, 28 Oct). */}
          <image href={picture.src} width={picture.width} height={picture.height} onClick={(e) => phase === "play" && say("Nothing there.", atEvent(e), "miss")} />
          {(phase === "play" || location.search.includes("outlines")) &&
            onWall.map((o) => (
              // A group ("5 frames") is tapped on any one of its instances, not on the hull around them all.
              <g
                key={o.id}
                className={`spot${flash === o.id ? " flash" : ""}`}
                tabIndex={0}
                role="button"
                aria-label={o.label}
                onClick={(e) => onObject(o.id, atEvent(e))}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onObject(o.id, centre(e.currentTarget))}
              >
                {((o.instances?.length ?? 0) > 1 ? o.instances! : [o.polygon]).map((poly, i) => (
                  <polygon key={i} points={poly.map((p) => p.join(",")).join(" ")} />
                ))}
              </g>
            ))}
        </svg>
        </div>
        {phase === "play" && more.left && <span className="pan-edge left" aria-hidden="true">‹</span>}
        {phase === "play" && more.right && <span className="pan-edge right" aria-hidden="true">›</span>}

        {phase === "intro" && (
          <div className="card start">
            <h1 className="title"><i>{room.title}</i></h1>
            <p className="text">{room.intro}</p>
            {/* There is no time limit: the clock only records how long you took ("Start the clock" read as a countdown). */}
            <button className="brass" onClick={start}>Start</button>
            <p className="maker">
              A clock records how long you take; there's no time limit.{" "}
              {id ? (
                <>
                  Made from a photo by Meta's AI. <a href={`/r/${id}/made`}>See how it was made</a> (it gives away the way out).
                </>
              ) : (
                "A first room, written by hand. The gallery's rooms were made from photos by Meta's AI."
              )}
            </p>
          </div>
        )}
        {phase === "won" && (
          <div className="card won">
            <h1 className="title"><i>You got out</i></h1>
            {ending && <p className="text">{ending}</p>}
            <p className="result">Out in {fmtTime(elapsed)}.</p>
            <pre className="share">{shareText}</pre>
            <div className="card-actions">
              <a className="brass" href="/rooms">{id ? "Escape another room" : "Now escape a room made from a photo"}</a>
              {id && <a className="ghost" href={`/r/${id}/made`}>See how this room was made</a>}
              <ShareButton text={shareText} />
            </div>
          </div>
        )}
      </div>

      <footer className="strip">
        {walls.length > 1 && (
          // Under the picture, not over it: buttons on the picture's edges would cover things to tap.
          <nav className="walls" aria-label="Turn round the room">
            <button className="turn" aria-label="Turn left" onClick={() => turn(-1)}>‹</button>
            {walls.map((_, i) => (
              <span key={i} className={i === wall ? "on" : ""} />
            ))}
            <button className="turn" aria-label="Turn right" onClick={() => turn(1)}>›</button>
          </nav>
        )}
        {credit && <p className="credit">{credit}</p>}
        {id && !room.curated && <Report id={id} />}
      </footer>

      {phase === "play" && (
        <nav className="pocket" aria-label="Your pocket">
          {state.items.length === 0 && <span className="empty">Your pocket is empty. Tap anything in the room.</span>}
          {state.items.map((id) => (
            <button key={id} className={`item${selected === id ? " on" : ""}`} aria-pressed={selected === id} onClick={(e) => onItem(id, centre(e.currentTarget))}>
              <span aria-hidden="true">{items.get(id)!.icon}</span> {items.get(id)!.name}
            </button>
          ))}
        </nav>
      )}

      <p className="sr-only" aria-live="polite">{said}</p>
      {bubble && (
        <p
          key={bubble.key}
          className={`bubble tone-${bubble.tone}${bubble.y < 140 ? " below" : ""}`}
          // Half the widest bubble (CSS max-width) plus a 16px gutter keeps it off the screen edge.
          style={{ left: Math.min(Math.max(bubble.x, bubbleReach()), innerWidth - bubbleReach()), top: bubble.y, animationDuration: `${lingerMs(bubble.text)}ms` }}
          aria-hidden="true"
        >
          {bubble.text}
        </p>
      )}

      {zoom && (
        <div className="zoom" role="dialog" aria-label={zoom.note ? zoom.note.name : "Close-up"} onClick={() => setZoom(undefined)}>
          <figure style={{ "--dx": `${zoom.x - innerWidth / 2}px`, "--dy": `${zoom.y - innerHeight / 2}px` } as React.CSSProperties}>
            {zoom.note ? (
              <>
                <div className={`sheet${zoom.note.paper ? " painted" : ""}`} style={zoom.note.paper ? { backgroundImage: `url(${zoom.note.paper})` } : undefined}>
                  <p className="hand">{zoom.text}</p>
                </div>
                {zoom.note.guides && <figcaption>Now tap what it names to look closer.</figcaption>}
              </>
            ) : (
              <>
                {zoom.image ? <img src={zoom.image} alt="" /> : zoom.closeup && <Closeup {...zoom.closeup} />}
                <figcaption>{zoom.text}</figcaption>
              </>
            )}
          </figure>
          {zoom.note?.usable && (
            <button className="brass" onClick={(e) => { e.stopPropagation(); setSelected(zoom.note!.id); setZoom(undefined); }}>
              Use the {zoom.note.name}
            </button>
          )}
          <span className="zoom-close">Tap anywhere to step back</span>
        </div>
      )}

      {lock && (
        <Reels
          length={codeLock(room, state, lock)?.code.length ?? 2}
          label={objects.get(lock)!.label}
          onClose={() => setLock(undefined)}
          onTry={(code) => {
            const a = codeLock(room, state, lock);
            const at = { x: innerWidth / 2, y: innerHeight / 2 };
            if (a && a.code === code) {
              setLock(undefined);
              run(a, at);
              return true;
            }
            setSaid(`The ${objects.get(lock)!.label} stays shut at ${code}.`);
            return false;
          }}
        />
      )}
    </main>
  );
}

// The gallery hangs every room we chose (server/gallery.ts) at its own shape, Van Gogh's first, each with its label.
interface Hung { id?: string; title: string; src: string; width: number; height: number; credit?: string; walls: number; painted: number }
const first: Hung = { ...vanGogh.image, src: "/rooms/van-gogh-bedroom-thumb.jpg", title: vanGogh.title, walls: 1, painted: 0 };

// The phone's share sheet where there is one (touch screens); elsewhere a copy, and the button says so. A silent copy
// read as a dead button in a playtest (28 Oct).
function ShareButton({ text }: { text: string }) {
  const [done, setDone] = useState<string>();
  async function share() {
    const touch = matchMedia("(pointer: coarse)").matches;
    if (touch && navigator.share) {
      try {
        await navigator.share({ text });
        return;
      } catch (e) {
        if ((e as Error).name === "AbortError") return; // closed the sheet
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      setDone("Copied: paste it anywhere");
    } catch {
      setDone("Couldn't copy: select the text above");
    }
  }
  return (
    <button className="ghost" onClick={share} aria-live="polite">
      {done ?? "Share your result"}
    </button>
  );
}

// Redraws a photo before upload: the phone's rotation is applied and its metadata (GPS) is left behind, since an
// uploaded room is served to anyone with its link. Also brings big phone photos under the 8 MB limit.
async function cleanPhoto(file: File): Promise<File> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/jpeg", 0.9));
    return blob ? new File([blob], "photo.jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file; // the server strips metadata too
  }
}

function wallsLine(r: Hung) {
  if (r.walls === 1) return "One wall";
  return r.painted ? `${r.walls} walls, ${r.painted} painted by Muse Image` : `${r.walls} walls`;
}

function Gallery() {
  const [rooms, setRooms] = useState<Hung[]>();
  useEffect(() => {
    fetch("/api/gallery")
      .then((r) => (r.ok ? r.json() : []))
      .then((g: Hung[]) => setRooms([first, ...g]), () => setRooms([first]));
  }, []);
  return (
    <main className="wall hang-page">
      <header className="masthead">
        <a className="brand" href="/">Escape This Photo</a>
      </header>
      <section className="label hang-intro">
        <h1 className="title"><i>Rooms to escape</i></h1>
        <p className="text">Every room here was made from a real photo or painting. Find what's hidden in it and get out.</p>
        <p className="maker">
          Meta's Muse Spark lists what is in the picture and writes the puzzles, SAM 3.1 outlines and counts each thing
          you tap, and Muse Image paints the walls behind you. A solver proves each room has a way out, and a blind
          playtest shows it can be found: a player who had never seen the room got out of each one.
        </p>
      </section>
      {!rooms ? (
        <p className="masthead">Opening the gallery…</p>
      ) : (
        <ul className="hang">
          {rooms.map((r) => (
            <li key={r.id ?? "van-gogh"}>
              <a href={r.id ? `/r/${r.id}` : "/"}>
                <span className="frame">
                  <img src={r.src} width={r.width} height={r.height} alt="" loading="lazy" />
                </span>
                <span className="plate">
                  <i className="plate-title">{r.title}</i>
                  <span className="plate-walls">{wallsLine(r)}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
      <section className="label hang-make">
        <MakeRoom example={rooms?.find((r) => r.id)?.id} />
      </section>
    </main>
  );
}

// Making a room spends Meta credits, so it needs an access code (server/lockdown.ts). The code comes in the link
// (?code=…), is kept on this device and taken out of the address bar so a screenshot or a shared link doesn't carry it.
function accessCode(): string {
  const fromLink = new URLSearchParams(location.search).get("code");
  try {
    if (fromLink) {
      localStorage.setItem("access-code", fromLink);
      history.replaceState(null, "", location.pathname);
    }
    return localStorage.getItem("access-code") ?? "";
  } catch {
    return fromLink ?? "";
  }
}

// Upload one photo per wall (up to four, in order turning right); the server builds and checks a room (a minute or
// more), then the room opens at its own link. With one photo, Muse Image can invent the other three walls.
const MAX_WALLS = 4;
function MakeRoom({ example }: { example?: string }) {
  const [code] = useState(accessCode);
  const [busy, setBusy] = useState(false);
  const [paint, setPaint] = useState(true);
  const [error, setError] = useState<string>();
  const [capped, setCapped] = useState(false);
  const [stage, setStage] = useState<{ stage: string; since: number }>();
  const [started, setStarted] = useState(0);
  const [now, setNow] = useState(0);
  const token = useMemo(() => Math.random().toString(36).slice(2, 14).padEnd(8, "0"), []);
  // While a room builds, ask the server what it is doing every second and a half.
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => {
      setNow(Date.now());
      fetch(`/api/builds/${token}`).then((r) => r.json()).then((b) => b.stage && setStage(b), () => {});
    }, 1500);
    return () => clearInterval(t);
  }, [busy, token]);
  if (!code) return <p className="credit">Making a room from your own photo is open to the hackathon's judges. Every room here is free to play.</p>;
  async function upload(files: File[]) {
    if (files.length > MAX_WALLS) return setError(`Choose up to ${MAX_WALLS} photos, one per wall.`);
    setBusy(true);
    setError(undefined);
    setCapped(false);
    setStage(undefined);
    setStarted(Date.now());
    setNow(Date.now());
    try {
      files = await Promise.all(files.map(cleanPhoto));
      const headers: Record<string, string> = { "content-type": "application/octet-stream", "x-access-code": code, "x-photo-sizes": files.map((f) => f.size).join(","), "x-build-token": token };
      if (files.length === 1 && paint) headers["x-paint-walls"] = "1";
      const res = await fetch("/api/rooms", { method: "POST", body: new Blob(files), headers });
      const body = await res.json();
      if (res.status === 503 && /budget/i.test(body.error ?? "")) setCapped(true);
      if (!res.ok) throw new Error(body.error ?? "Building the room failed.");
      location.href = `/r/${body.id}`;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div>
      <label className={`ghost upload${busy ? " busy" : ""}`}>
        {busy ? "Building your room and proving it can be solved…" : "Make a room from your own photos"}
        <input type="file" accept="image/jpeg,image/png" multiple disabled={busy} onChange={(e) => e.target.files?.length && upload([...e.target.files])} />
      </label>
      {!busy && (
        <label className="credit choice">
          <input type="checkbox" checked={paint} onChange={(e) => setPaint(e.target.checked)} /> With a single photo, let Muse Image paint the other three walls
        </label>
      )}
      <p className="credit" aria-live="polite">
        {busy
          ? `${stage?.stage ?? "Sending the photos"}… ${Math.round((now - started) / 1000)} s. A room takes one to two and a half minutes.`
          : `One to ${MAX_WALLS} photos of the same room, one per wall in order as you turn right, with no people in them. JPEG or PNG.`}
      </p>
      {error && <p className="text miss">{error}</p>}
      {capped && example && (
        <p className="credit">
          Meanwhile, <a href={`/r/${example}/made`}>see every step that built one of the rooms above</a>, from the photo to the blind play-through.
        </p>
      )}
    </div>
  );
}

// Anyone can flag a room; enough reports from different people hide it until someone running the site looks (server/index.ts).
function Report({ id }: { id: string }) {
  const [state, setState] = useState<"idle" | "asking" | "sent" | "failed">("idle");
  if (state === "sent") return <p className="credit">Thanks. The room has been reported.</p>;
  if (state === "asking")
    return (
      <p className="credit report">
        Report this room as offensive or as showing someone's private life?{" "}
        <button
          className="link"
          onClick={() =>
            fetch(`/api/rooms/${id}/report`, { method: "POST" }).then(
              (r) => setState(r.ok ? "sent" : "failed"),
              () => setState("failed"),
            )
          }
        >
          Report
        </button>{" "}
        <button className="link" onClick={() => setState("idle")}>
          Cancel
        </button>
      </p>
    );
  return (
    <p className="credit report">
      <button className="link" onClick={() => setState("asking")}>
        Report this room
      </button>
      {state === "failed" && " Reporting failed. Try again in a moment."}
    </p>
  );
}

// A crop of the real photo, sized to the crop's own shape so no blank margin shows (as large as the close-up allows).
function Closeup({ picture, polygon }: { picture: Picture; polygon: Point[] }) {
  const box = closeupBox(polygon, picture.width, picture.height);
  const ratio = box[2] / box[3];
  return (
    <svg className="closeup" viewBox={box.join(" ")} style={{ "--ratio": ratio, aspectRatio: String(ratio) } as React.CSSProperties} aria-hidden="true">
      <image href={picture.src} width={picture.width} height={picture.height} />
    </svg>
  );
}

function Reels({ length, label, onTry, onClose }: { length: number; label: string; onTry: (code: string) => boolean; onClose: () => void }) {
  const [digits, setDigits] = useState(() => Array(length).fill(0));
  const [shake, setShake] = useState(false);
  const turn = (i: number, d: number) => setDigits((ds) => ds.map((v, j) => (j === i ? (v + d + 10) % 10 : v)));
  return (
    <div className="scrim" onClick={onClose}>
      <div className={`lock${shake ? " shake" : ""}`} role="dialog" aria-label={`Lock on the ${label}`} onClick={(e) => e.stopPropagation()}>
        <p className="lock-name">Lock on the {label}</p>
        <div className="reels">
          {digits.map((v, i) => (
            <div className="reel" key={i}>
              <button aria-label={`Digit ${i + 1} up`} onClick={() => turn(i, 1)}>▲</button>
              <span className="digit" aria-live="polite">{v}</span>
              <button aria-label={`Digit ${i + 1} down`} onClick={() => turn(i, -1)}>▼</button>
            </div>
          ))}
        </div>
        <div className="lock-actions">
          <button className="ghost" onClick={onClose}>Step back</button>
          <button
            className="primary"
            onClick={() => {
              if (!onTry(digits.join(""))) {
                setShake(true);
                setTimeout(() => setShake(false), 400);
              }
            }}
          >
            Turn the handle
          </button>
        </div>
      </div>
    </div>
  );
}
