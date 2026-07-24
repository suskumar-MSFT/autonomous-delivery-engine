/**
 * kill-switch.ts — Loop kill-switch probe (M4-2)
 *
 * Reads the PROJECT.md file and returns `true` when the file contains the
 * magic line `LOOP PAUSED`, signalling that the loop should stop immediately.
 *
 * **Design contract:**
 * - Read-only: never writes to the project file.
 * - Injectable `readFile` seam for hermetic tests (no live FS in CI).
 * - When the project file cannot be read (e.g. ENOENT), the function returns
 *   `false` so a missing/unreadable file does NOT halt the loop by accident
 *   (fail-open for kill-switch, fail-safe for loop liveness).
 * - The sentinel string is `LOOP PAUSED` (exact match, case-sensitive,
 *   anywhere on a line) — consistent with how the main loop checks it.
 *
 * Implementation status: **M4-2 COMPLETE**.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Injectable `readFile` seam.  Resolves with the file contents as a string;
 * rejects on I/O error.  Default: Node.js `fs/promises` `readFile`.
 */
export type ReadFileFn = (path: string, encoding: 'utf8') => Promise<string>;

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Probes the PROJECT.md file for the kill-switch sentinel `LOOP PAUSED`.
 *
 * Returns `true` if the loop should stop (kill-switch is active).
 * Returns `false` if the loop should continue (sentinel absent or file unreadable).
 *
 * @param projectFilePath - Absolute path to the PROJECT.md file.
 * @param readFile        - Optional injectable file reader (for tests).
 */
export async function checkKillSwitch(
  projectFilePath: string,
  readFile?: ReadFileFn,
): Promise<boolean> {
  const readFileFn: ReadFileFn =
    readFile ??
    (async (p, enc) => {
      const { readFile: fsReadFile } = await import('node:fs/promises');
      return fsReadFile(p, enc);
    });

  let contents: string;
  try {
    contents = await readFileFn(projectFilePath, 'utf8');
  } catch {
    // File unreadable (ENOENT, EACCES, etc.) — do NOT halt the loop.
    return false;
  }

  // Check each line for the exact sentinel (case-sensitive).
  for (const line of contents.split('\n')) {
    if (line.includes('LOOP PAUSED')) {
      return true;
    }
  }
  return false;
}
