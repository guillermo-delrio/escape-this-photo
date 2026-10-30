// "How this room was made" (/r/<id>/made): the steps that built and checked one room, shown as a short exhibit on the
// gallery's wall. Everything shown is read from the room itself (room.made, objects' SAM counts) or recomputed here
// (the solver's way out), so the page can't claim a check that didn't run.
import { useEffect, useMemo, useState } from "react";
import { roomWalls } from "./engine/engine";
import { closeupBox } from "./engine/shapes";
import { solve } from "./engine/solver";
import type { Action, Picture, Point, Room, RoomObject } from "./engine/types";

export function Made({ id }: { id: string }) {
  const [room, setRoom] = useState<Room>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    fetch(`/api/rooms/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("This room doesn't exist."))))
      .then(setRoom, (e: Error) => setError(e.message));
  }, [id]);
  return (
    <main className="wall made-page">
      <header className="masthead">
        <a className="brand" href="/rooms">Escape This Photo</a>
        <a className="back-link" href={`/r/${id}`}>Play this room</a>
      </header>
      {error && <p className="label text">{error}</p>}
      {!room && !error && <p className="masthead">Opening the room…</p>}
      {room && <Steps room={room} id={id} />}
    </main>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function stepText(room: Room, a: Action): string {
  const label = (oid: string) => room.objects.find((o) => o.id === oid)?.label ?? oid;
  const item = (iid: string) => room.items.find((i) => i.id === iid)?.name ?? iid;
  if (a.kind === "inspect") return `Look at the ${label(a.target)}`;
  if (a.kind === "use") return `Use the ${item(a.item)} on the ${label(a.target)}`;
  if (a.kind === "combine") return `Put the ${item(a.items[0])} and the ${item(a.items[1])} together`;
  return `Dial ${a.code} on the ${label(a.target)}`;
}

function Steps({ room, id }: { room: Room; id: string }) {
  const walls = useMemo(() => roomWalls(room), [room]);
  const proof = useMemo(() => solve(room), [room]);
  const made = room.made;
  const counts = room.facts.filter((f) => f.kind === "count");
  const counted = (oid: string) => room.objects.find((o) => o.id === oid)!;
  const painted = walls.filter((w) => w.painted).length;
  const segmented = room.objects.reduce((n, o) => n + (o.segmented ?? o.instances?.length ?? 1), 0);
  const rejected = room.objects.filter((o) => o.segmented && o.segmented > (o.instances?.length ?? 1));
  const actions = new Map(room.actions.map((a) => [a.id, a]));

  return (
    <>
      <section className="label made-intro">
        <h1 className="title"><i>How “{room.title}” was made</i></h1>
        <p className="text">Every step below ran when this room was built, before anyone played it.</p>
        <p className="maker">This page gives away the way out.</p>
      </section>

      <ol className="made-steps">
        <li>
          <Frames pictures={walls.filter((w) => !w.painted)} />
          <div className="label">
            <h2 className="step-title">The photo</h2>
            <p className="text">Muse Spark checked it first: no people, nothing unsafe. Then it listed the things in it a player could tap.</p>
            {walls[0].credit && <p className="credit">{walls[0].credit}</p>}
          </div>
        </li>

        {painted > 0 && (
          <li>
            <Frames pictures={walls.filter((w) => w.painted)} />
            <div className="label">
              <h2 className="step-title">{plural(painted, "wall")} painted by Muse Image</h2>
              <p className="text">
                Muse Image painted the rest of the room from the photo, so you can turn round in it. Each painting passed the
                same content check as the photo, and SAM measures it the same way.
              </p>
            </div>
          </li>
        )}

        <li>
          <Outlines pictures={walls} objects={room.objects} />
          <div className="label">
            <h2 className="step-title">What SAM 3.1 found</h2>
            <p className="text">
              SAM 3.1 outlined {plural(room.objects.length, "thing")} Spark named, {plural(segmented, "shape")} in all. The
              outlines are what you tap, and SAM's counts are the only numbers a puzzle may ask you to count.
            </p>
            {rejected.length > 0 && (
              <p className="text">
                Spark then looked at each counted shape and threw out the ones that weren't the thing named:{" "}
                {rejected.map((o, i) => (
                  <span key={o.id}>
                    {i > 0 && "; "}
                    {o.label}, {o.segmented} found and {o.instances?.length ?? 1} kept
                  </span>
                ))}
                .
              </p>
            )}
          </div>
        </li>

        <li>
          <div className="label made-wide">
            <h2 className="step-title">The puzzles, and the checks they passed</h2>
            {made && made.failed.length > 0 ? (
              <>
                <p className="text">Muse Spark wrote {plural(made.drafts, "draft")}. The checks sent back:</p>
                <ul className="made-list">
                  {made.failed.map((issues, i) => (
                    <li key={i}>Draft {i + 1}: {issues.join("; ")}.</li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text">Muse Spark wrote the puzzles, and its draft passed every check.</p>
            )}
            <p className="text">
              The solver tried every move in every order ({proof.states.toLocaleString("en")} states of the room) and found{" "}
              {proof.deadEnds ? `${proof.deadEnds} dead ends` : "no way to get stuck"}. The shortest way out:
            </p>
            <ol className="made-list way-out">
              {proof.solution.map((aid) => (
                <li key={aid}>{stepText(room, actions.get(aid)!)}</li>
              ))}
            </ol>
          </div>
        </li>

        {counts.length > 0 && (
          <li>
            <div className="made-closeups">
              {counts.map((f) => {
                const o = counted(f.objectIds[0]);
                return <Crop key={f.id} picture={walls[o.wall ?? 0]} polygon={o.polygon} />;
              })}
            </div>
            <div className="label">
              <h2 className="step-title">{made?.counted.length ? "A blind count of each close-up" : "What the locks ask you to count"}</h2>
              {counts.map((f) => {
                const o = counted(f.objectIds[0]);
                const seen = made?.counted.find((c) => c.fact === f.id);
                return (
                  <p className="text" key={f.id}>
                    {seen
                      ? `Spark saw only this close-up and the clues, and counted ${seen.count}: ${seen.counting}. SAM counted ${f.value} ${o.label}.`
                      : `The lock wants ${f.value}, the ${o.label} SAM counted.`}
                  </p>
                );
              })}
            </div>
          </li>
        )}

        {made?.blindPlay && (
          <li>
            <div className="label made-wide">
              <h2 className="step-title">A blind play-through</h2>
              <p className="text">
                {made.blindPlay.escaped
                  ? `A Claude agent that had never seen the room played it on a phone-sized screen, from screenshots only, and got out in ${plural(made.blindPlay.commands, "move")} with ${plural(made.blindPlay.wrongCodes, "wrong code")}.`
                  : "A Claude agent that had never seen the room played it from screenshots and didn't get out."}
              </p>
            </div>
          </li>
        )}
      </ol>

      <section className="label made-end">
        <a className="brass" href={`/r/${id}`}>Play this room</a>
      </section>
    </>
  );
}

function Frames({ pictures }: { pictures: Picture[] }) {
  return (
    <div className="made-frames">
      {pictures.map((p) => (
        <span className="frame" key={p.src}>
          <img src={p.src} width={p.width} height={p.height} alt="" loading="lazy" />
        </span>
      ))}
    </div>
  );
}

function Outlines({ pictures, objects }: { pictures: Picture[]; objects: RoomObject[] }) {
  return (
    <div className="made-frames">
      {pictures.map((p, w) => (
        <span className="frame" key={p.src}>
          <svg className="made-svg outlines" viewBox={`0 0 ${p.width} ${p.height}`} role="img" aria-label="The photo with SAM's outlines">
            <image href={p.src} width={p.width} height={p.height} />
            {objects
              .filter((o) => (o.wall ?? 0) === w)
              .flatMap((o) => ((o.instances?.length ?? 0) > 1 ? o.instances! : [o.polygon]).map((poly, i) => (
                <polygon key={`${o.id}-${i}`} className="spot" points={poly.map((pt) => pt.join(",")).join(" ")} />
              )))}
          </svg>
        </span>
      ))}
    </div>
  );
}

function Crop({ picture, polygon }: { picture: Picture; polygon: Point[] }) {
  const box = closeupBox(polygon, picture.width, picture.height);
  return (
    <span className="frame">
      <svg className="made-svg" viewBox={box.join(" ")} aria-hidden="true">
        <image href={picture.src} width={picture.width} height={picture.height} />
      </svg>
    </span>
  );
}
