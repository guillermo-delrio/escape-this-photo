import type { Point, Room } from "../engine/types";

// Outlines traced by SAM 3.1 (server/segment.ts, 27 Oct); a box is only the close-up frame of a group.
const box = (x1: number, y1: number, x2: number, y2: number): Point[] => [
  [x1, y1],
  [x2, y1],
  [x2, y2],
  [x1, y2],
];

const pictures: Point[][] = [
  [[808, 116], [811, 269], [1034, 267], [1036, 239], [1026, 117], [897, 111]],
  [[1175, 28], [1179, 43], [1216, 111], [1236, 156], [1250, 175], [1259, 174], [1315, 150], [1332, 139], [1330, 115], [1272, 0], [1219, 0], [1188, 17]],
  [[1357, 235], [1300, 257], [1287, 266], [1287, 274], [1329, 392], [1341, 405], [1407, 382], [1365, 241]],
  [[1359, 0], [1395, 71], [1431, 129], [1451, 127], [1556, 95], [1553, 83], [1521, 33], [1507, 0]],
  [[1629, 267], [1601, 267], [1551, 287], [1483, 304], [1482, 311], [1493, 336], [1496, 357], [1517, 410], [1537, 413], [1638, 406], [1663, 402], [1667, 398], [1656, 364], [1651, 331]],
];
const pillows: Point[][] = [
  [[1118, 441], [1122, 459], [1151, 486], [1176, 488], [1187, 496], [1190, 517], [1196, 522], [1243, 522], [1288, 501], [1310, 486], [1306, 475], [1286, 457], [1277, 444], [1263, 432], [1256, 430], [1233, 436], [1179, 436], [1168, 433], [1149, 421], [1141, 420], [1128, 426]],
  [[1142, 491], [1125, 475], [1102, 462], [1098, 457], [1094, 438], [1090, 433], [1081, 430], [1062, 431], [1024, 443], [978, 441], [965, 447], [961, 459], [964, 476], [985, 523], [988, 538], [994, 545], [1006, 551], [1016, 550], [1036, 540], [1085, 543], [1116, 539], [1120, 532], [1124, 506]],
];
const outline: Record<string, Point[]> = {
  "chair-left": [[76, 582], [0, 629], [35, 1024], [17, 1194], [31, 1212], [49, 1209], [76, 1115], [105, 1119], [114, 1149], [138, 1125], [222, 1134], [234, 1255], [257, 1271], [271, 1250], [271, 1152], [283, 1141], [304, 1154], [312, 1141], [302, 855], [269, 829], [135, 812], [128, 595], [114, 578]],
  "chair-table": [[729, 449], [682, 468], [677, 477], [707, 688], [706, 794], [714, 800], [726, 794], [734, 746], [770, 759], [776, 785], [802, 769], [809, 848], [824, 862], [834, 852], [837, 789], [870, 743], [882, 774], [896, 763], [900, 614], [890, 604], [796, 579], [781, 459], [763, 449]],
  "table": [[283, 518], [285, 544], [313, 573], [314, 819], [336, 813], [347, 655], [378, 692], [392, 906], [410, 911], [422, 692], [454, 679], [526, 674], [529, 790], [541, 798], [551, 673], [580, 668], [590, 835], [609, 868], [625, 867], [622, 603], [675, 587], [672, 572], [632, 551], [540, 580], [489, 545], [434, 573], [375, 580], [310, 519]],
  "drawer": [[577, 612], [571, 602], [528, 602], [517, 605], [470, 604], [444, 608], [438, 612], [437, 619], [443, 649], [474, 650], [570, 642], [577, 636]],
  "bed": [[921, 403], [926, 736], [968, 778], [1115, 1079], [1119, 1178], [1157, 1268], [1204, 1261], [1207, 1137], [1691, 1082], [1698, 1130], [1733, 1168], [1791, 1159], [1742, 465], [1700, 463], [1688, 505], [1662, 509], [1496, 449], [1390, 455], [1322, 483], [1298, 386], [1251, 409], [1123, 379], [977, 418]],
  "window": [[439, 0], [462, 413], [617, 430], [728, 398], [722, 0]],
  "mirror": [[293, 150], [288, 158], [299, 334], [303, 337], [408, 330], [412, 308], [403, 223], [400, 153], [397, 150]],
  "door": [[1745, 0], [1734, 377], [1768, 543], [1790, 1043], [1804, 1098], [1912, 1190], [1919, 0]],
};

export const vanGogh: Room = {
  id: "van-gogh-bedroom",
  title: "The Bedroom",
  intro: "Arles, 1889. Vincent has locked you in his bedroom. The door on the right has a two-digit lock.",
  image: {
    src: "/rooms/van-gogh-bedroom.jpg",
    width: 1920,
    height: 1498,
    credit: "Vincent van Gogh, The Bedroom, 1889. Art Institute of Chicago. Public domain.",
  },
  objects: [
    { id: "chair-left", label: "straw chair", polygon: outline["chair-left"], description: "A rush-seated chair." },
    { id: "chair-table", label: "chair by the table", polygon: outline["chair-table"], description: "Just a chair." },
    { id: "table", label: "table", polygon: outline.table, description: "A washstand with a jug and bottles." },
    { id: "drawer", label: "table drawer", polygon: outline.drawer, description: "A small drawer. Locked." },
    { id: "bed", label: "bed", polygon: outline.bed, description: "Heavy wood. Nothing under it." },
    { id: "pictures", label: "pictures", polygon: box(805, 0, 1670, 415), instances: pictures },
    { id: "pillows", label: "pillows", polygon: box(950, 400, 1320, 560), instances: pillows },
    { id: "window", label: "window", polygon: outline.window, description: "Painted shut." },
    { id: "mirror", label: "mirror", polygon: outline.mirror, description: "You look tired." },
    { id: "door", label: "door", polygon: outline.door, description: "Locked. A dial with two digits." },
  ],
  items: [
    { id: "key", name: "small brass key", description: "Small enough for a drawer.", icon: "🗝️" },
    {
      id: "note",
      name: "Vincent's note",
      description: "A folded note in Vincent's hand.",
      icon: "📜",
      text: "The dial on my door takes two digits. The first is how many of my pictures hang on the walls; the second, how many pillows lie on my bed.\n\nVincent",
    },
  ],
  facts: [
    { id: "pictures-count", kind: "count", objectIds: ["pictures"], value: "5" },
    { id: "pillows-count", kind: "count", objectIds: ["pillows"], value: "2" },
  ],
  actions: [
    {
      id: "find-key",
      kind: "inspect",
      target: "chair-left",
      effect: { message: "Something glints between the rushes of the seat: a small brass key.", gives: ["key"], closeup: "chair-left", after: "A rush-seated chair. Nothing more between the rushes." },
    },
    {
      id: "open-drawer",
      kind: "use",
      item: "key",
      target: "drawer",
      effect: { message: "The key turns. Inside, a folded note in Vincent's hand.", takes: ["key"], gives: ["note"], sets: ["drawer-open"], after: "The drawer hangs open, empty now." },
    },
    {
      id: "count-pictures",
      kind: "inspect",
      target: "pictures",
      when: { items: ["note"] },
      effect: { message: "You step up to Vincent's pictures, each a little crooked in its frame.", reveals: ["pictures-count"], closeup: "pictures" },
    },
    { id: "look-pictures", kind: "inspect", target: "pictures", effect: { message: "Vincent's pictures, slightly crooked." } },
    {
      id: "count-pillows",
      kind: "inspect",
      target: "pillows",
      when: { items: ["note"] },
      effect: { message: "You lean over the bed and its pale yellow pillows.", reveals: ["pillows-count"], closeup: "pillows" },
    },
    { id: "look-pillows", kind: "inspect", target: "pillows", effect: { message: "Plump and pale yellow." } },
    {
      id: "unlock-door",
      kind: "code",
      target: "door",
      code: "52",
      derivedFrom: ["pictures-count", "pillows-count"],
      effect: { message: "The dial clicks at 5-2. The door swings open onto the yellow house's landing.", sets: ["escaped"] },
    },
  ],
  goal: "escaped",
};
