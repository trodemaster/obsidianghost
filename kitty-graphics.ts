// Kitty's ordered row/column diacritics (graphics protocol Unicode placeholders).
const DIACRITICS = [
  0x0305,0x030d,0x030e,0x0310,0x0312,0x033d,0x033e,0x033f,0x0346,0x034a,0x034b,0x034c,
  0x0350,0x0351,0x0352,0x0357,0x035b,0x0363,0x0364,0x0365,0x0366,0x0367,0x0368,0x0369,
  0x036a,0x036b,0x036c,0x036d,0x036e,0x036f,0x0483,0x0484,0x0485,0x0486,0x0487,0x0592,
  0x0593,0x0594,0x0595,0x0597,0x0598,0x0599,0x059c,0x059d,0x059e,0x059f,0x05a0,0x05a1,
  0x05a8,0x05a9,0x05ab,0x05ac,0x05af,0x05c4,0x0610,0x0611,0x0612,0x0613,0x0614,0x0615,
  0x0616,0x0617,0x0657,0x0658,0x0659,0x065a,0x065b,0x065d,0x065e,0x06d6,0x06d7,0x06d8,
  0x06d9,0x06da,0x06db,0x06dc,0x06df,0x06e0,0x06e1,0x06e2,0x06e4,0x06e7,0x06e8,0x06eb,
  0x06ec,0x0730,0x0732,0x0733,0x0735,0x0736,0x073a,0x073d,0x073f,0x0740,0x0741,0x0743,
  0x0745,0x0747,0x0749,0x074a,0x07eb,0x07ec,0x07ed,0x07ee,0x07ef,0x07f0,0x07f1,0x07f3,
  0x0816,0x0817,0x0818,0x0819,0x081b,0x081c,0x081d,0x081e,0x081f,0x0820,0x0821,0x0822,
  0x0823,0x0825,0x0826,0x0827,0x0829,0x082a,0x082b,0x082c,0x082d,0x0951,0x0953,0x0954,
  0x0f82,0x0f83,0x0f86,0x0f87,0x135d,0x135e,0x135f,0x17dd,0x193a,0x1a17,0x1a75,0x1a76,
  0x1a77,0x1a78,0x1a79,0x1a7a,0x1a7b,0x1a7c,0x1b6b,0x1b6d,0x1b6e,0x1b6f,0x1b70,0x1b71,
  0x1b72,0x1b73,0x1cd0,0x1cd1,0x1cd2,0x1cda,0x1cdb,0x1ce0,0x1dc0,0x1dc1,0x1dc3,0x1dc4,
  0x1dc5,0x1dc6,0x1dc7,0x1dc8,0x1dc9,0x1dcb,0x1dcc,0x1dd1,0x1dd2,0x1dd3,0x1dd4,0x1dd5,
  0x1dd6,0x1dd7,0x1dd8,0x1dd9,0x1dda,0x1ddb,0x1ddc,0x1ddd,0x1dde,0x1ddf,0x1de0,0x1de1,
  0x1de2,0x1de3,0x1de4,0x1de5,0x1de6,0x1dfe,0x20d0,0x20d1,0x20d4,0x20d5,0x20d6,0x20d7,
  0x20db,0x20dc,0x20e1,0x20e7,0x20e9,0x20f0,0x2cef,0x2cf0,0x2cf1,
  ...Array.from({ length: 32 }, (_, i) => 0x2de0 + i),
  0xa66f,0xa67c,0xa67d,0xa6f0,0xa6f1,
  ...Array.from({ length: 18 }, (_, i) => 0xa8e0 + i),
  0xaab0,0xaab2,0xaab3,0xaab7,0xaab8,0xaabe,0xaabf,0xaac1,
  ...Array.from({ length: 7 }, (_, i) => 0xfe20 + i),
  0x10a0f,0x10a38,0x1d185,0x1d186,0x1d187,0x1d188,0x1d189,0x1d1aa,0x1d1ab,0x1d1ac,
  0x1d1ad,0x1d242,0x1d243,0x1d244,
];
const DIACRITIC_INDEX = new Map(DIACRITICS.map((cp, index) => [cp, index]));
export const IMAGE_PLACEHOLDER = "\u{10eeee}";
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ENCODED_BYTES = Math.ceil(MAX_BYTES / 3) * 4;

type Controls = Record<string, string>;
type Placement = { cols: number; rows: number };
type StoredImage = { image: HTMLImageElement; bytes: number };
type Transfer = { controls: Controls; parts: string[]; length: number };
export type ImageCell = { id: number; row: number; col: number };

export function terminalRowCells(text: string, cols: number): string[] {
  const cells: string[] = [];
  for (const cp of text.replace(/\r?\n$/, "")) {
    if (/\p{Mark}/u.test(cp) && cells.length) cells[cells.length - 1] += cp;
    else cells.push(cp);
  }
  while (cells.length < cols) cells.push(" ");
  return cells.slice(0, cols);
}

export function decodeImageCell(cell: string, fg: number, previous?: ImageCell): ImageCell | null {
  if (!cell.startsWith(IMAGE_PLACEHOLDER)) return null;
  const marks = Array.from(cell).slice(1).map((cp) => DIACRITIC_INDEX.get(cp.codePointAt(0)!));
  const high = marks[2] ?? (previous && (previous.id & 0xffffff) === fg ? previous.id >>> 24 : 0);
  const id = (fg + high * 0x1000000) >>> 0;
  const continuing = previous?.id === id;
  return {
    id,
    row: marks[0] ?? (continuing ? previous!.row : 0),
    col: marks[1] ?? (continuing ? previous!.col + 1 : 0),
  };
}

export class KittyGraphics {
  private state: "text" | "escape" | "apc" | "apc-escape" | "string" | "string-escape" = "text";
  private command = "";
  private transfer: Transfer | null = null;
  private images = new Map<number, StoredImage>();
  private placements = new Map<number, Placement>();
  private versions = new Map<number, object>();
  private bytes = 0;
  private disposed = false;

  constructor(
    private readonly changed: () => void,
    private readonly reply: (data: string) => void,
  ) {}

  // Observe APCs alongside libghostty-vt; do not remove or rewrite terminal bytes.
  feed(data: string): void {
    for (const cp of data) {
      switch (this.state) {
        case "text":
          if (cp === "\x1b") this.state = "escape";
          break;
        case "escape":
          this.state = cp === "_" ? "apc" : "]PX^".includes(cp) ? "string" : cp === "\x1b" ? "escape" : "text";
          this.command = "";
          break;
        case "apc":
          if (cp === "\x1b") this.state = "apc-escape";
          else if (cp === "\x18" || cp === "\x1a") {
            this.command = "";
            this.state = "text";
          } else if (this.command.length < MAX_ENCODED_BYTES) this.command += cp;
          else {
            console.error("[ghostty] Kitty graphics command exceeds memory limit");
            this.command = "";
            this.transfer = null;
            this.state = "string";
          }
          break;
        case "apc-escape":
          if (cp === "\\") {
            if (this.command.startsWith("G")) this.execute(this.command.slice(1));
            this.command = "";
            this.state = "text";
          } else {
            this.command = "";
            this.state = cp === "_" ? "apc" : "text";
          }
          break;
        case "string":
          if (cp === "\x1b") this.state = "string-escape";
          else if (cp === "\x07" || cp === "\x18" || cp === "\x1a") this.state = "text";
          break;
        case "string-escape":
          this.state = cp === "\\" ? "text" : "string";
          break;
      }
    }
  }

  private respond(c: Controls, message: string): void {
    if (c.q !== "2" && (message !== "OK" || c.q !== "1")) {
      this.reply(`\x1b_Gi=${Number(c.i) || 0};${message}\x1b\\`);
    }
  }

  private execute(command: string): void {
    const separator = command.indexOf(";");
    const header = separator < 0 ? command : command.slice(0, separator);
    const payload = separator < 0 ? "" : command.slice(separator + 1);
    let c: Controls = {};
    for (const pair of header.split(",")) {
      const [key, value] = pair.split("=");
      if (key && value !== undefined) c[key] = value;
    }
    try {
      if (c.a === "d") {
        if (c.d === "i" || c.d === "I") {
          const id = Number(c.i);
          this.placements.delete(id);
          if (c.d === "I") {
            this.bytes -= this.images.get(id)?.bytes ?? 0;
            this.images.delete(id);
            this.versions.delete(id);
          }
        } else if (!c.d || c.d === "a" || c.d === "A") {
          this.placements.clear();
          if (c.d === "A") {
            this.images.clear();
            this.versions.clear();
            this.bytes = 0;
          }
        } else throw new Error("ENOTSUP:unsupported deletion");
        this.changed();
        return;
      }
      if (c.a === "p") {
        if (!this.images.has(Number(c.i))) throw new Error("ENOENT:image not found");
        this.setPlacement(c);
        this.respond(c, "OK");
        this.changed();
        return;
      }
      if (c.a && !["t", "T", "q"].includes(c.a)) throw new Error("ENOTSUP:unsupported action");
      const transfer = this.transfer ?? { controls: c, parts: [], length: 0 };
      transfer.parts.push(payload);
      transfer.length += payload.length;
      if (transfer.length > MAX_ENCODED_BYTES) throw new Error("ENOMEM:image transfer too large");
      if (c.m === "1") {
        this.transfer = transfer;
        return;
      }
      this.transfer = null;
      c = transfer.controls;
      this.loadImage(transfer);
    } catch (error) {
      this.transfer = null;
      const message = error instanceof Error ? error.message : String(error);
      console.error("[ghostty] Kitty graphics:", message);
      this.respond(c, message);
    }
  }

  private setPlacement(c: Controls): void {
    const id = Number(c.i), cols = Number(c.c), rows = Number(c.r);
    if (c.U !== "1" || c.p && c.p !== "0") throw new Error("ENOTSUP:only default Unicode placements supported");
    if (!Number.isInteger(id) || id <= 0 || id > 0xffffffff ||
        !Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) {
      throw new Error("EINVAL:invalid image placement");
    }
    this.placements.set(id, { cols, rows });
  }

  private loadImage(transfer: Transfer): void {
    const c = transfer.controls;
    if (c.f !== "100" || c.t && c.t !== "d" || c.o) {
      throw new Error("ENOTSUP:only directly transmitted PNG images supported");
    }
    const encoded = transfer.parts.join("");
    if (encoded.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(encoded.replace(/={1,2}$/, ""))) {
      throw new Error("EINVAL:invalid base64");
    }
    const png = Buffer.from(encoded, "base64");
    if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
        png.toString("ascii", 12, 16) !== "IHDR") throw new Error("EINVAL:invalid PNG");
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    const bytes = width * height * 4;
    const id = Number(c.i);
    if (!width || !height || width > 16384 || height > 16384 || bytes > MAX_BYTES ||
        this.bytes - (this.images.get(id)?.bytes ?? 0) + bytes > MAX_BYTES ||
        !this.images.has(id) && this.images.size >= 256) {
      throw new Error("ENOMEM:image cache limit exceeded");
    }
    if (!Number.isInteger(id) || id <= 0 || id > 0xffffffff) throw new Error("EINVAL:invalid image ID");
    if (c.a === "T") this.setPlacement(c);
    const token = {};
    this.versions.set(id, token);
    // Reserve decoded memory before asynchronous browser decoding.
    this.bytes -= this.images.get(id)?.bytes ?? 0;
    const image = new Image();
    this.images.set(id, { image, bytes });
    this.bytes += bytes;
    image.onload = () => {
      if (this.disposed || this.versions.get(id) !== token) return;
      if (c.a === "q") {
        this.images.delete(id);
        this.versions.delete(id);
        this.bytes -= bytes;
      }
      this.respond(c, "OK");
      this.changed();
    };
    image.onerror = () => {
      if (this.disposed || this.versions.get(id) !== token) return;
      this.images.delete(id);
      this.versions.delete(id);
      this.bytes -= bytes;
      console.error("[ghostty] Kitty graphics: PNG decoding failed");
      this.respond(c, "EINVAL:PNG decoding failed");
      this.changed();
    };
    image.src = `data:image/png;base64,${encoded}`;
  }

  drawCell(ctx: CanvasRenderingContext2D, cell: ImageCell, x: number, y: number, width: number, height: number): void {
    const image = this.images.get(cell.id)?.image;
    const grid = this.placements.get(cell.id);
    if (!image?.complete || !image.naturalWidth || !grid || cell.col >= grid.cols || cell.row >= grid.rows) return;
    const scale = Math.min(grid.cols * width / image.naturalWidth, grid.rows * height / image.naturalHeight);
    const drawWidth = image.naturalWidth * scale, drawHeight = image.naturalHeight * scale;
    const left = x - cell.col * width + (grid.cols * width - drawWidth) / 2;
    const top = y - cell.row * height + (grid.rows * height - drawHeight) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(image, left, top, drawWidth, drawHeight);
    ctx.restore();
  }

  dispose(): void {
    this.disposed = true;
    this.images.clear();
    this.placements.clear();
    this.versions.clear();
    this.transfer = null;
    this.command = "";
    this.bytes = 0;
  }
}
