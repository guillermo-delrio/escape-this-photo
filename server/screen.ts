// Content check: every uploaded photo, and every picture Muse Image paints, is shown to Spark before it is stored,
// used or served. A refused photo builds nothing and is deleted; a refused painting is dropped from the room.
import { SpendCapError, sparkJSON } from "./meta";

export interface Verdict {
  allowed: boolean;
  reason: string; // shown to the uploader when refused, so it stays short and plain
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["allowed", "reason"],
  properties: { allowed: { type: "boolean" }, reason: { type: "string" } },
};

const PROMPT = (what: "upload" | "painting", extraWall: boolean) => `You check pictures for a public puzzle game that turns a photo of a room into an escape room anyone with the link can play.
Refuse (allowed: false) if the picture shows any of:
- nudity or sexual content, even partial or suggestive;
- graphic violence, blood, gore, injury, or weapons aimed at someone;
- hate symbols, extremist imagery, or slurs and insults in visible text;
- drugs or drug use;
- ${what === "upload" ? "a real person, or a recognisable part of one (a face, a body, a hand in frame), in a photograph. People in a painting, poster or artwork on the wall are fine." : "any person at all."}
- private information: an ID card, a passport, a bank card, a screen or document with readable personal details, a house number with a street name.
${what !== "upload" ? "" : extraWall ? "This is one more wall of a room already uploaded: it may also be a close view of part of a room or of one object in it, or an artwork of one (a painting of a chair, a still life). Refuse a screenshot, a meme, a selfie or a document." : "Also refuse anything that is not a picture of an indoor space or an artwork of one (a screenshot, a meme, a selfie, a document)."}
Otherwise allow it. "reason": one short plain sentence for the person who uploaded it, without repeating anything offensive, e.g. "The photo shows a person; use a photo of an empty room." When allowed, "reason" is "ok".`;

// Low effort still reasons before it answers, so the token cap leaves room for that (600 once came back empty).
export async function screen(dataUrl: string, what: "upload" | "painting", extraWall = false, tries = 2): Promise<Verdict & { usd: number }> {
  let r;
  try {
    r = await sparkJSON<Verdict>(
      [{ role: "user", content: [{ type: "text", text: PROMPT(what, extraWall) }, { type: "image_url", image_url: { url: dataUrl } }] }],
      "verdict",
      SCHEMA,
      2000,
      "low",
    );
  } catch (e) {
    if (e instanceof SpendCapError) throw e;
    console.error(`content check: ${(e as Error).message}`);
    if (tries > 1) return screen(dataUrl, what, extraWall, tries - 1);
    return { allowed: false, reason: "This picture couldn't be checked just now. Try again in a minute.", usd: 0 };
  }
  // Anything but a clear yes is a no: a malformed answer must not let a picture through.
  const allowed = r.data?.allowed === true;
  return { allowed, reason: allowed ? "ok" : String(r.data?.reason || "This picture can't be used."), usd: r.usd };
}
