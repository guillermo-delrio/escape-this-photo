// A room is a photo plus the objects segmented in it, the facts those segments prove, and the actions a player can
// take. Everything the solver and the grounding checks need is in this one JSON-serialisable shape.

export type Point = [number, number]; // image pixels

export interface RoomObject {
  id: string;
  label: string;
  polygon: Point[]; // outline of the whole object (or of all its instances' hull)
  instances?: Point[][]; // one outline per instance when the segmenter found several ("7 books")
  text?: string; // real text read from the photo (a sign, a clock face as "10:10")
  colors?: string[]; // colour names left to right, when the object is a row of coloured things
  description?: string; // what a plain tap says
  uncertain?: boolean; // the segmenter was unsure of at least one instance, so its count can't be a puzzle fact
  wall?: number; // which of the room's walls it is on (index into roomWalls); 0 when absent
  detail?: string; // painted close-up shown on a plain tap; never used for counts or codes (no text, no numbers)
  segmented?: number; // how many instances SAM found, when Spark's check then rejected some (server/verify.ts)
}

// How the room was made and checked, for the "how this room was made" panel. Written by the pipeline.
export interface Made {
  drafts: number; // puzzle drafts Spark wrote; the last one passed
  failed: string[][]; // the checks each earlier draft failed, in order
  counted: { fact: string; counting: string; count: number }[]; // the blind count of each close-up
  blindPlay?: { escaped: boolean; commands: number; wrongCodes: number; date: string }; // scripts/blind.mjs
}

export interface Item {
  id: string;
  name: string;
  description: string;
  icon?: string; // emoji fallback until crops or painted interiors exist
  objectId?: string; // when the item is a real object in the photo, its close-up is a crop of that object
  hiddenIn?: string; // object whose mask must be larger than this item's (checked by grounding)
  text?: string; // the words written on it (a note): one tap reads it, typeset over `paper`
  paper?: string; // painted blank page the text is set on; plain paper when absent
}

export type FactKind = "count" | "text" | "colorOrder" | "fits";

export interface Fact {
  id: string;
  kind: FactKind;
  objectIds: string[]; // count/text/colorOrder: [object]; fits: [item object, container object]
  value: string; // what the player learns, e.g. "3" or "red,yellow,blue"
}

export interface Cond {
  items?: string[];
  flags?: string[];
  notFlags?: string[];
}

export interface Effect {
  message: string;
  gives?: string[];
  takes?: string[];
  sets?: string[];
  reveals?: string[]; // fact ids the player now knows
  closeup?: string; // object id to show as a crop of the photo
  image?: string; // painted interior, for things the photo can't show
  after?: string; // what tapping the target says from then on ("The drawer hangs open, empty.")
}

interface ActionBase {
  id: string;
  when?: Cond;
  effect: Effect;
}

export type Action =
  | (ActionBase & { kind: "inspect"; target: string })
  | (ActionBase & { kind: "use"; item: string; target: string })
  | (ActionBase & { kind: "combine"; items: [string, string] })
  | (ActionBase & { kind: "code"; target: string; code: string; derivedFrom: string[] });

export interface Picture {
  src: string;
  width: number;
  height: number;
  credit?: string;
  painted?: boolean; // invented by Muse Image rather than photographed
}

export interface Room {
  id: string;
  title: string;
  intro: string;
  image: Picture; // the first wall
  walls?: Picture[]; // the other walls, in order as the player turns right; objects say which wall they are on
  objects: RoomObject[];
  items: Item[];
  facts: Fact[];
  actions: Action[];
  goal: string; // flag that means the player escaped
  made?: Made;
}

export interface State {
  items: string[]; // sorted
  flags: string[]; // sorted; includes "knows:<fact>" and "done:<action>"
}
