import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { loadGhosttyVtWasm } from "./ghostty-wasm";

/** File name of the libghostty-vt WebAssembly module, next to main.js. */
export const GHOSTTY_VT_WASM = "ghostty-vt.wasm";

export type GhosttyNative = {
  version(): string;
  createTerminal(cols: number, rows: number): GhosttyTerminal;
};

export type CursorPosition = { col: number; row: number; valid: boolean };

export type GhosttyTerminal = {
  feed(data: Uint8Array | string): number;
  resize(cols: number, rows: number, cellWidthPx?: number, cellHeightPx?: number): number;
  scrollViewport(deltaLines: number): number;
  dumpViewport(): string;
  dumpViewportRow(row: number): string;
  // One string per physical cell; wide-character continuation cells are "".
  dumpViewportRowCells(row: number): string[];
  takeResponses(): string;
  // 1-based; valid is false when the cursor is hidden or outside the viewport.
  cursorPosition(): CursorPosition;
  dumpViewportRowStyleRuns(row: number): StyleRun[];
  takeDirtyViewportRows(totalRows: number): number[];
  takeViewportScrollDelta(): number;
  hyperlinkAt(col: number, row: number): string | null;
  setDefaultColors(fg: number, bg: number): void;
  // Palette entries (index → 0xRRGGBB) layered over the built-in 256-color palette.
  setPalette(entries: Iterable<[number, number]>): void;
  free(): void;
};

// Columns are 1-based and inclusive. Colors are resolved: inverse is already
// applied and invisible text has fg === bg.
export type StyleRun = {
  startCol: number;
  endCol: number;
  fg: number; // 0xRRGGBB
  bg: number; // 0xRRGGBB
  flags: number;
};

export const StyleRunFlags = {
  inverse:       0x01,
  bold:          0x02,
  italic:        0x04,
  underline:     0x08,
  faint:         0x10,
  invisible:     0x20,
  strikethrough: 0x40,
} as const;

export function textRangeToCells(cells: string[], start: number, end: number): { startCol: number; endCol: number } | null {
  let offset = 0;
  let startCol = -1;
  for (let col = 0; col < cells.length; col++) {
    const next = offset + cells[col].length;
    if (startCol < 0 && start >= offset && start < next) startCol = col + 1;
    if (startCol >= 0 && end <= next) {
      return { startCol, endCol: col + (cells[col + 1] === "" ? 2 : 1) + 1 };
    }
    offset = next;
  }
  return null;
}

export type GhosttyNativeState = {
  native: GhosttyNative | null;
  message: string;
};

export async function loadGhosttyNative(
  pluginDir: string,
  fallbackDir?: string
): Promise<GhosttyNativeState> {
  const baseDir = pluginDir || fallbackDir || "";
  if (!baseDir) {
    return { native: null, message: "Plugin directory is unavailable." };
  }
  const modulePath = join(baseDir, GHOSTTY_VT_WASM);
  if (!existsSync(modulePath)) {
    return {
      native: null,
      message: `libghostty-vt not found at ${modulePath}. Run make install (or make install-release) and reload.`,
    };
  }

  try {
    const native = await loadGhosttyVtWasm(readFileSync(modulePath));
    return { native, message: `Loaded ${native.version()}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { native: null, message: `Failed to load libghostty-vt: ${message}` };
  }
}
