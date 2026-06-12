import { existsSync } from "fs";
import { join } from "path";

export type GhosttyNative = {
  version(): string;
  renderDemo(): string;
  createTerminal(cols: number, rows: number): GhosttyTerminal;
};

export type GhosttyTerminal = {
  feed(data: Uint8Array | string): number;
  resize(cols: number, rows: number): number;
  scrollViewport(deltaLines: number): number;
  dumpViewport(): string;
  dumpViewportRow(row: number): string;
  cursorPosition(): { col: number; row: number; valid: boolean };
  // Phase 2: rich rendering APIs
  dumpViewportRowStyleRuns(row: number): Buffer;
  takeDirtyViewportRows(totalRows: number): Buffer;
  takeViewportScrollDelta(): number;
  hyperlinkAt(col: number, row: number): string | null;
  setDefaultColors(fg: number, bg: number): void;
  free(): void;
};

// StyleRun: 12-byte packed struct per IMPLEMENTATION.md
// uint16 start_col, uint16 end_col, u8 fg_r,fg_g,fg_b, u8 bg_r,bg_g,bg_b, u8 flags, u8 reserved
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

export function parseStyleRuns(buf: Buffer): StyleRun[] {
  const STRIDE = 12;
  const count = Math.floor(buf.length / STRIDE);
  const runs: StyleRun[] = [];
  for (let i = 0; i < count; i++) {
    const off = i * STRIDE;
    runs.push({
      startCol: buf.readUInt16LE(off),
      endCol:   buf.readUInt16LE(off + 2),
      fg: (buf[off + 4] << 16) | (buf[off + 5] << 8) | buf[off + 6],
      bg: (buf[off + 7] << 16) | (buf[off + 8] << 8) | buf[off + 9],
      flags:    buf[off + 10],
    });
  }
  return runs;
}

export function parseDirtyRows(buf: Buffer): number[] {
  const rows: number[] = [];
  for (let i = 0; i + 1 < buf.length; i += 2) {
    rows.push(buf.readUInt16LE(i));
  }
  return rows;
}

export type GhosttyNativeState = {
  native: GhosttyNative | null;
  message: string;
};

export function tryLoadGhosttyNative(
  pluginDir: string,
  fallbackDir?: string
): GhosttyNativeState {
  const baseDir = pluginDir || fallbackDir || "";
  if (!baseDir) {
    return {
      native: null,
      message: "Plugin directory is unavailable.",
    };
  }
  const modulePath = join(baseDir, "native", "ghostty_vt.node");

  if (!existsSync(modulePath)) {
    return {
      native: null,
      message: `Native module not found at ${modulePath}. baseDir=${baseDir}`,
    };
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Native .node addon needs runtime require() for dynamic path resolution in Electron
    const native = require(modulePath) as GhosttyNative;
    return {
      native,
      message: `Native module loaded: ${native.version()}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      native: null,
      message: `Failed to load native module: ${message}`,
    };
  }
}
