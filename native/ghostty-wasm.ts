// libghostty-vt 1.x (stable C ABI) loaded from the official WebAssembly build.
//
// The module has no imports. Every C struct used here has a fixed wasm32 layout
// (pointers and size_t are 4 bytes; unions holding uint64_t are 8-byte aligned),
// and structs passed by value travel as pointers. Callbacks are C function
// pointers, which on wasm32 are indices into the exported function table; a
// one-function trampoline module turns a JS function into something the table
// accepts.

import type { CursorPosition, GhosttyNative, GhosttyTerminal, StyleRun } from "./ghostty";
import { StyleRunFlags } from "./ghostty";

/* eslint-disable @typescript-eslint/no-explicit-any -- the wasm exports are untyped */
type Exports = Record<string, any> & {
  memory: WebAssembly.Memory;
  __indirect_function_table: WebAssembly.Table;
};

// GhosttyResult
const OK = 0;
const OUT_OF_SPACE = -3;

// GhosttyTerminalOption
const OPT_USERDATA = 1;
const OPT_WRITE_PTY = 2;
const OPT_COLOR_FOREGROUND = 12;
const OPT_COLOR_BACKGROUND = 13;
const OPT_COLOR_PALETTE = 15;
const OPT_KITTY_IMAGE_STORAGE_LIMIT = 16;

// GhosttyTerminalData
const DATA_SCROLLBAR = 9;

// GhosttyTerminalScrollViewportTag
const SCROLL_TOP = 0;
const SCROLL_BOTTOM = 1;
const SCROLL_DELTA = 2;

// GhosttyRenderStateData / Option
const RS_DIRTY = 3;
const RS_ROW_ITERATOR = 4;
const RS_COLOR_BACKGROUND = 5;
const RS_COLOR_FOREGROUND = 6;
const RS_COLOR_PALETTE = 9;
const RS_CURSOR_VISIBLE = 11;
const RS_CURSOR_VIEWPORT_HAS_VALUE = 14;
const RS_CURSOR_VIEWPORT_X = 15;
const RS_CURSOR_VIEWPORT_Y = 16;
const RS_OPT_DIRTY = 1;
const DIRTY_FULL = 2;

// GhosttyRenderStateRowData / Option, GhosttyRenderStateRowCellsData
const ROW_DIRTY = 1;
const ROW_CELLS = 3;
const ROW_OPT_DIRTY = 1;
const CELLS_RAW = 1;
const CELLS_STYLE = 2;
const CELLS_GRAPHEMES_BUF = 4;
const CELLS_BG_COLOR = 5;
const CELLS_FG_COLOR = 6;

// GhosttyCellData / GhosttyCellWide
const CELL_WIDE = 3;
const CELL_HAS_STYLING = 5;
const WIDE_SPACER_TAIL = 2;
const WIDE_SPACER_HEAD = 3;

// GhosttyPointTag
const POINT_VIEWPORT = 1;

// GhosttyStyle flags and color tags
const STYLE_BOLD = 1 << 0;
const STYLE_ITALIC = 1 << 1;
const STYLE_FAINT = 1 << 2;
const STYLE_INVERSE = 1 << 4;
const STYLE_INVISIBLE = 1 << 5;
const STYLE_STRIKETHROUGH = 1 << 6;
const STYLE_UNDERLINE_MASK = 0x7 << 8;
const STYLE_COLOR_PALETTE = 1;

// Scratch layout (one block per module instance; the library is single threaded
// and the only re-entry is the write-pty callback, which does not touch it).
const SCRATCH_SIZE = 8192;
const S_SLOT = 0; // opaque out-parameter, 4 bytes
const S_VALUE = 16; // generic 8-byte out value
const S_STYLE = 32; // GhosttyStyle, 16 bytes
const S_FG = 48; // GhosttyColorRgb
const S_BG = 52; // GhosttyColorRgb
const S_CPBUF = 64; // GhosttyCodepointBuffer {ptr, cap, len}
const S_STRUCT = 80; // GhosttyPoint / GhosttyTerminalScrollViewport / scrollbar, 24 bytes
const S_GRIDREF = 112; // GhosttyGridRef, 8 bytes
const S_WRITTEN = 128; // size_t out_written
const S_FALSE = 136; // bool false
const S_ZERO = 140; // int32 0
const S_CODEPOINTS = 256; // uint32_t[64]
const CODEPOINT_CAP = 64;
const S_PALETTE = 512; // GhosttyColorRgb[256]
const S_URI = 1536; // URI buffer
const URI_CAP = SCRATCH_SIZE - S_URI;

type Rgb = number; // 0xRRGGBB

type RowSnapshot = {
  cells: string[];
  runs: StyleRun[];
};

function rgbAt(view: Uint8Array, offset: number): Rgb {
  return (view[offset] << 16) | (view[offset + 1] << 8) | view[offset + 2];
}

function writeRgb(view: Uint8Array, offset: number, color: Rgb): void {
  view[offset] = (color >> 16) & 0xff;
  view[offset + 1] = (color >> 8) & 0xff;
  view[offset + 2] = color & 0xff;
}

function leb128(value: number): number[] {
  const out: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    out.push(byte);
  } while (value !== 0);
  return out;
}

function wasmString(text: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(text));
  return [...leb128(bytes.length), ...bytes];
}

function section(id: number, body: number[]): number[] {
  return [id, ...leb128(body.length), ...body];
}

/**
 * Build a wasm function that calls `fn`. The returned function can be stored in
 * a funcref table, unlike a plain JS function.
 */
function wasmCallable(fn: (...args: number[]) => void, params: number): WebAssembly.ExportValue {
  const I32 = 0x7f;
  const type = [0x60, ...leb128(params), ...new Array<number>(params).fill(I32), 0];
  const body = [0, ...Array.from({ length: params }, (_, i) => [0x20, ...leb128(i)]).flat(), 0x10, 0, 0x0b];
  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [1, ...type]),
    ...section(2, [1, ...wasmString("e"), ...wasmString("f"), 0x00, 0]),
    ...section(3, [1, 0]),
    ...section(7, [1, ...wasmString("f"), 0x00, 1]),
    ...section(10, [1, ...leb128(body.length), ...body]),
  ]);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), { e: { f: fn } });
  return instance.exports.f;
}

class GhosttyWasm {
  readonly e: Exports;
  readonly scratch: number;
  readonly writePtyFn: number;
  private bufferRef: ArrayBuffer | null = null;
  private u8View = new Uint8Array(0);
  private dataView = new DataView(new ArrayBuffer(0));
  private inputPtr = 0;
  private inputCap = 0;
  private nextId = 1;
  readonly terminals = new Map<number, WasmTerminal>();
  readonly decoder = new TextDecoder();
  readonly encoder = new TextEncoder();

  constructor(instance: WebAssembly.Instance) {
    this.e = instance.exports as Exports;
    this.scratch = this.e.ghostty_wasm_alloc(SCRATCH_SIZE) >>> 0;
    if (!this.scratch) throw new Error("libghostty-vt: out of memory");
    this.u8.fill(0, this.scratch, this.scratch + SCRATCH_SIZE);

    const table = this.e.__indirect_function_table;
    this.writePtyFn = table.grow(1);
    table.set(this.writePtyFn, wasmCallable((_terminal, userdata, data, len) => {
      this.terminals.get(userdata >>> 0)?.receiveReply(this.u8.slice(data >>> 0, (data >>> 0) + (len >>> 0)));
    }, 4));
  }

  get u8(): Uint8Array {
    this.refreshViews();
    return this.u8View;
  }

  get dv(): DataView {
    this.refreshViews();
    return this.dataView;
  }

  private refreshViews(): void {
    const buffer = this.e.memory.buffer;
    if (buffer !== this.bufferRef || this.u8View.byteLength !== buffer.byteLength) {
      this.bufferRef = buffer;
      this.u8View = new Uint8Array(buffer);
      this.dataView = new DataView(buffer);
    }
  }

  version(): string {
    const ptr = this.e.ghostty_version() >>> 0;
    const view = this.u8;
    let end = ptr;
    while (view[end] !== 0) end++;
    return this.decoder.decode(view.subarray(ptr, end));
  }

  /** Copy bytes into a reusable input buffer and return its address. */
  input(bytes: Uint8Array): number {
    if (bytes.length > this.inputCap) {
      if (this.inputPtr) this.e.ghostty_wasm_free(this.inputPtr, this.inputCap);
      this.inputCap = Math.max(4096, bytes.length * 2);
      this.inputPtr = this.e.ghostty_wasm_alloc(this.inputCap) >>> 0;
      if (!this.inputPtr) {
        this.inputCap = 0;
        throw new Error("libghostty-vt: out of memory");
      }
    }
    this.u8.set(bytes, this.inputPtr);
    return this.inputPtr;
  }

  /** Construct an opaque handle through an out-parameter slot. */
  create(name: string, call: (slot: number) => number): number {
    const slot = this.scratch + S_SLOT;
    const result = call(slot);
    if (result !== OK) throw new Error(`libghostty-vt: ${name} failed (${result})`);
    return this.e.ghostty_wasm_take_opaque(slot) >>> 0;
  }

  register(terminal: WasmTerminal): number {
    const id = this.nextId++;
    this.terminals.set(id, terminal);
    return id;
  }
}

class WasmTerminal implements GhosttyTerminal {
  private readonly w: GhosttyWasm;
  private readonly id: number;
  private handle: number;
  private renderState: number;
  private rowIterator: number;
  private rowCells: number;
  private replies: Uint8Array[] = [];
  private stale = true;
  private rowsCache: RowSnapshot[] = [];
  private dirtyRows = new Set<number>();
  private fullDirty = true;
  private cursor: CursorPosition = { col: 1, row: 1, valid: false };
  private colors = { fg: 0xffffff, bg: 0x000000, palette: new Uint8Array(768) };
  private lastScrollOffset: bigint | null = null;

  constructor(w: GhosttyWasm, cols: number, rows: number) {
    this.w = w;
    const e = w.e;
    // A null allocator selects the library's default allocator.
    this.handle = w.create("terminal", (slot) => e.ghostty_terminal_new(0, slot, cols, rows));
    this.renderState = w.create("render state", (slot) => e.ghostty_render_state_new(0, slot));
    this.rowIterator = w.create("row iterator", (slot) => e.ghostty_render_state_row_iterator_new(0, slot));
    this.rowCells = w.create("row cells", (slot) => e.ghostty_render_state_row_cells_new(0, slot));
    this.id = w.register(this);

    e.ghostty_terminal_set(this.handle, OPT_USERDATA, this.id);
    e.ghostty_terminal_set(this.handle, OPT_WRITE_PTY, w.writePtyFn);
    // kitty-graphics.ts owns the Kitty protocol (including its replies) for now,
    // so the library must not also store images or answer the same commands.
    w.dv.setBigUint64(w.scratch + S_VALUE, 0n, true);
    e.ghostty_terminal_set(this.handle, OPT_KITTY_IMAGE_STORAGE_LIMIT, w.scratch + S_VALUE);
  }

  receiveReply(bytes: Uint8Array): void {
    this.replies.push(bytes);
  }

  private alive(): boolean {
    return this.handle !== 0;
  }

  private invalidate(full = false): void {
    this.stale = true;
    if (full) this.fullDirty = true;
  }

  feed(data: Uint8Array | string): number {
    if (!this.alive()) return 1;
    const bytes = typeof data === "string" ? this.w.encoder.encode(data) : data;
    if (bytes.length === 0) return 0;
    const ptr = this.w.input(bytes);
    this.w.e.ghostty_terminal_vt_write(this.handle, ptr, bytes.length);
    this.invalidate();
    return 0;
  }

  takeResponses(): string {
    if (this.replies.length === 0) return "";
    const total = this.replies.reduce((sum, item) => sum + item.length, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const item of this.replies) {
      joined.set(item, offset);
      offset += item.length;
    }
    this.replies = [];
    return this.w.decoder.decode(joined);
  }

  resize(cols: number, rows: number, cellWidthPx = 1, cellHeightPx = 1): number {
    if (!this.alive()) return 1;
    const result = this.w.e.ghostty_terminal_resize(
      this.handle, cols, rows, Math.max(1, Math.round(cellWidthPx)), Math.max(1, Math.round(cellHeightPx)),
    );
    this.invalidate(true);
    return result === OK ? 0 : 2;
  }

  scrollViewport(deltaLines: number): number {
    if (!this.alive()) return 1;
    const at = this.w.scratch + S_STRUCT;
    const dv = this.w.dv;
    // Very large jumps are the "scroll to top/bottom" shortcuts.
    const tag = deltaLines <= -10000 ? SCROLL_TOP : deltaLines >= 10000 ? SCROLL_BOTTOM : SCROLL_DELTA;
    dv.setInt32(at, tag, true);
    dv.setInt32(at + 4, 0, true);
    dv.setInt32(at + 8, tag === SCROLL_DELTA ? deltaLines : 0, true);
    const result = this.w.e.ghostty_terminal_scroll_viewport(this.handle, at);
    this.invalidate();
    return result === OK ? 0 : 2;
  }

  setDefaultColors(fg: number, bg: number): void {
    if (!this.alive()) return;
    const s = this.w.scratch;
    const view = this.w.u8;
    writeRgb(view, s + S_FG, fg);
    writeRgb(view, s + S_BG, bg);
    this.w.e.ghostty_terminal_set(this.handle, OPT_COLOR_FOREGROUND, s + S_FG);
    this.w.e.ghostty_terminal_set(this.handle, OPT_COLOR_BACKGROUND, s + S_BG);
    this.invalidate(true);
  }

  setPalette(entries: Iterable<[number, number]>): void {
    if (!this.alive()) return;
    const at = this.w.scratch + S_PALETTE;
    this.w.e.ghostty_color_palette_default(at);
    const view = this.w.u8;
    for (const [index, color] of entries) {
      if (index >= 0 && index < 256) writeRgb(view, at + index * 3, color);
    }
    this.w.e.ghostty_terminal_set(this.handle, OPT_COLOR_PALETTE, at);
    this.invalidate(true);
  }

  // ── reads ────────────────────────────────────────────────────────────

  /** Pull the terminal into the render state and copy every dirty row out. */
  private refresh(): void {
    if (!this.alive() || !this.stale) return;
    this.stale = false;
    const { e } = this.w;
    const s = this.w.scratch;
    if (e.ghostty_render_state_update(this.renderState, this.handle) !== OK) return;

    let dv = this.w.dv;
    e.ghostty_render_state_get(this.renderState, RS_DIRTY, s + S_VALUE);
    const full = this.fullDirty || dv.getInt32(s + S_VALUE, true) === DIRTY_FULL;

    e.ghostty_render_state_get(this.renderState, RS_COLOR_FOREGROUND, s + S_FG);
    e.ghostty_render_state_get(this.renderState, RS_COLOR_BACKGROUND, s + S_BG);
    e.ghostty_render_state_get(this.renderState, RS_COLOR_PALETTE, s + S_PALETTE);
    let view = this.w.u8;
    this.colors.fg = rgbAt(view, s + S_FG);
    this.colors.bg = rgbAt(view, s + S_BG);
    this.colors.palette.set(view.subarray(s + S_PALETTE, s + S_PALETTE + 768));

    dv.setUint32(s + S_SLOT, this.rowIterator, true);
    e.ghostty_render_state_get(this.renderState, RS_ROW_ITERATOR, s + S_SLOT);
    const rows: RowSnapshot[] = [];
    let y = 0;
    while (e.ghostty_render_state_row_iterator_next(this.rowIterator)) {
      let dirty = full || !this.rowsCache[y];
      if (!dirty) {
        e.ghostty_render_state_row_get(this.rowIterator, ROW_DIRTY, s + S_VALUE);
        dirty = this.w.u8[s + S_VALUE] !== 0;
      }
      if (dirty) {
        rows.push(this.readRow());
        this.dirtyRows.add(y);
        e.ghostty_render_state_row_set(this.rowIterator, ROW_OPT_DIRTY, s + S_FALSE);
      } else {
        rows.push(this.rowsCache[y]);
      }
      y++;
    }
    this.rowsCache = rows;
    dv = this.w.dv;
    dv.setInt32(s + S_ZERO, 0, true);
    e.ghostty_render_state_set(this.renderState, RS_OPT_DIRTY, s + S_ZERO);

    e.ghostty_render_state_get(this.renderState, RS_CURSOR_VIEWPORT_HAS_VALUE, s + S_VALUE);
    e.ghostty_render_state_get(this.renderState, RS_CURSOR_VISIBLE, s + S_VALUE + 1);
    e.ghostty_render_state_get(this.renderState, RS_CURSOR_VIEWPORT_X, s + S_VALUE + 2);
    e.ghostty_render_state_get(this.renderState, RS_CURSOR_VIEWPORT_Y, s + S_VALUE + 4);
    view = this.w.u8;
    dv = this.w.dv;
    this.cursor = {
      valid: view[s + S_VALUE] !== 0 && view[s + S_VALUE + 1] !== 0,
      col: dv.getUint16(s + S_VALUE + 2, true) + 1,
      row: dv.getUint16(s + S_VALUE + 4, true) + 1,
    };
    if (full) this.fullDirty = true;
  }

  /** Read the iterator's current row: one string per physical cell plus style runs. */
  private readRow(): RowSnapshot {
    const { e } = this.w;
    const s = this.w.scratch;
    const cellsHandle = this.rowCells;
    this.w.dv.setUint32(s + S_SLOT, cellsHandle, true);
    e.ghostty_render_state_row_get(this.rowIterator, ROW_CELLS, s + S_SLOT);

    const cells: string[] = [];
    const runs: StyleRun[] = [];
    const { fg: defaultFg, bg: defaultBg, palette } = this.colors;
    let run: StyleRun | null = null;
    let col = 0;
    while (e.ghostty_render_state_row_cells_next(cellsHandle)) {
      col++;
      let dv = this.w.dv;
      e.ghostty_render_state_row_cells_get(cellsHandle, CELLS_RAW, s + S_VALUE);
      const raw = dv.getBigUint64(s + S_VALUE, true);
      e.ghostty_cell_get(raw, CELL_WIDE, s + S_VALUE);
      const wide = this.w.dv.getInt32(s + S_VALUE, true);
      e.ghostty_cell_get(raw, CELL_HAS_STYLING, s + S_VALUE);
      const styled = this.w.u8[s + S_VALUE] !== 0;

      if (wide === WIDE_SPACER_TAIL) {
        cells.push("");
      } else if (wide === WIDE_SPACER_HEAD) {
        cells.push(" ");
      } else {
        dv = this.w.dv;
        dv.setUint32(s + S_CPBUF, s + S_CODEPOINTS, true);
        dv.setUint32(s + S_CPBUF + 4, CODEPOINT_CAP, true);
        dv.setUint32(s + S_CPBUF + 8, 0, true);
        const result = e.ghostty_render_state_row_cells_get(cellsHandle, CELLS_GRAPHEMES_BUF, s + S_CPBUF);
        dv = this.w.dv;
        const len = Math.min(dv.getUint32(s + S_CPBUF + 8, true), CODEPOINT_CAP);
        if ((result !== OK && result !== OUT_OF_SPACE) || len === 0) {
          cells.push(" ");
        } else {
          const codepoints: number[] = [];
          for (let i = 0; i < len; i++) codepoints.push(dv.getUint32(s + S_CODEPOINTS + i * 4, true));
          cells.push(String.fromCodePoint(...codepoints));
        }
      }

      let fg = defaultFg;
      let flags = 0;
      if (styled) {
        e.ghostty_render_state_row_cells_get(cellsHandle, CELLS_STYLE, s + S_STYLE);
        const view = this.w.u8;
        const styleFlags = this.w.dv.getUint16(s + S_STYLE + 12, true);
        const fgTag = view[s + S_STYLE];
        const fgIndex = view[s + S_STYLE + 1];
        if (styleFlags & STYLE_INVERSE) flags |= StyleRunFlags.inverse;
        if (styleFlags & STYLE_BOLD) flags |= StyleRunFlags.bold;
        if (styleFlags & STYLE_ITALIC) flags |= StyleRunFlags.italic;
        if (styleFlags & STYLE_UNDERLINE_MASK) flags |= StyleRunFlags.underline;
        if (styleFlags & STYLE_FAINT) flags |= StyleRunFlags.faint;
        if (styleFlags & STYLE_INVISIBLE) flags |= StyleRunFlags.invisible;
        if (styleFlags & STYLE_STRIKETHROUGH) flags |= StyleRunFlags.strikethrough;
        if ((styleFlags & STYLE_BOLD) && fgTag === STYLE_COLOR_PALETTE && fgIndex < 8) {
          // Bold brightens the eight base colors, as Ghostty does by default.
          fg = rgbAt(palette, (fgIndex + 8) * 3);
        } else if (e.ghostty_render_state_row_cells_get(cellsHandle, CELLS_FG_COLOR, s + S_FG) === OK) {
          fg = rgbAt(this.w.u8, s + S_FG);
        }
      }
      let bg = defaultBg;
      if (e.ghostty_render_state_row_cells_get(cellsHandle, CELLS_BG_COLOR, s + S_BG) === OK) {
        bg = rgbAt(this.w.u8, s + S_BG);
      }
      if (flags & StyleRunFlags.inverse) [fg, bg] = [bg, fg];
      if (flags & StyleRunFlags.invisible) fg = bg;

      if (run && run.fg === fg && run.bg === bg && run.flags === flags) {
        run.endCol = col;
      } else {
        run = { startCol: col, endCol: col, fg, bg, flags };
        runs.push(run);
      }
    }
    return { cells, runs };
  }

  private row(row: number): RowSnapshot | null {
    this.refresh();
    return this.rowsCache[row] ?? null;
  }

  dumpViewportRowCells(row: number): string[] {
    return this.row(row)?.cells.slice() ?? [];
  }

  dumpViewportRowStyleRuns(row: number): StyleRun[] {
    return this.row(row)?.runs.map((run) => ({ ...run })) ?? [];
  }

  dumpViewportRow(row: number): string {
    return (this.row(row)?.cells.join("") ?? "").replace(/ +$/, "");
  }

  dumpViewport(): string {
    this.refresh();
    const lines = this.rowsCache.map((row) => row.cells.join("").replace(/ +$/, ""));
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  }

  takeDirtyViewportRows(totalRows: number): number[] {
    this.refresh();
    const rows = this.fullDirty
      ? Array.from({ length: totalRows }, (_, i) => i)
      : [...this.dirtyRows].filter((row) => row < totalRows).sort((a, b) => a - b);
    this.dirtyRows.clear();
    this.fullDirty = false;
    return rows;
  }

  takeViewportScrollDelta(): number {
    if (!this.alive()) return 0;
    const at = this.w.scratch + S_STRUCT;
    if (this.w.e.ghostty_terminal_get(this.handle, DATA_SCROLLBAR, at) !== OK) return 0;
    const offset = this.w.dv.getBigUint64(at + 8, true);
    const previous = this.lastScrollOffset;
    this.lastScrollOffset = offset;
    return previous === null ? 0 : Number(offset - previous);
  }

  cursorPosition(): CursorPosition {
    this.refresh();
    return { ...this.cursor };
  }

  hyperlinkAt(col: number, row: number): string | null {
    if (!this.alive() || col < 1 || row < 1) return null;
    const { e } = this.w;
    const s = this.w.scratch;
    const dv = this.w.dv;
    const point = s + S_STRUCT;
    dv.setInt32(point, POINT_VIEWPORT, true);
    dv.setInt32(point + 4, 0, true);
    dv.setUint16(point + 8, col - 1, true);
    dv.setUint16(point + 10, 0, true);
    dv.setUint32(point + 12, row - 1, true);
    if (e.ghostty_terminal_grid_ref(this.handle, point, s + S_GRIDREF) !== OK) return null;

    let buf = s + S_URI;
    let cap = URI_CAP;
    let owned = 0;
    let result = e.ghostty_grid_ref_hyperlink_uri(s + S_GRIDREF, buf, cap, s + S_WRITTEN);
    if (result === OUT_OF_SPACE) {
      cap = this.w.dv.getUint32(s + S_WRITTEN, true);
      owned = buf = e.ghostty_wasm_alloc(cap) >>> 0;
      if (!buf) return null;
      result = e.ghostty_grid_ref_hyperlink_uri(s + S_GRIDREF, buf, cap, s + S_WRITTEN);
    }
    try {
      if (result !== OK) return null;
      const written = this.w.dv.getUint32(s + S_WRITTEN, true);
      if (written === 0) return null;
      return this.w.decoder.decode(this.w.u8.slice(buf, buf + written));
    } finally {
      if (owned) e.ghostty_wasm_free(owned, cap);
    }
  }

  free(): void {
    if (!this.alive()) return;
    const { e } = this.w;
    e.ghostty_render_state_row_cells_free(this.rowCells);
    e.ghostty_render_state_row_iterator_free(this.rowIterator);
    e.ghostty_render_state_free(this.renderState);
    e.ghostty_terminal_free(this.handle);
    this.w.terminals.delete(this.id);
    this.handle = this.renderState = this.rowIterator = this.rowCells = 0;
    this.rowsCache = [];
    this.replies = [];
  }
}

/** Instantiate libghostty-vt from the bytes of its `.wasm` release file. */
export async function loadGhosttyVtWasm(bytes: BufferSource): Promise<GhosttyNative> {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const w = new GhosttyWasm(instance);
  const version = w.version();
  return {
    version: () => `libghostty-vt ${version} (wasm)`,
    createTerminal: (cols: number, rows: number) => new WasmTerminal(w, cols, rows),
  };
}
