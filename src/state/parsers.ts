export interface Milestone {
  id: string;
  name: string;
  /** Phase label, e.g. "crawl", "walk", "run", "crawl-", or a numeric string "0". */
  phase: string;
  status: 'planned' | 'in-progress' | 'done' | 'blocked';
}

export interface BacklogItem {
  id: string;
  /** 0 when no GitHub issue is linked yet. */
  ghNumber: number;
  title: string;
  type: 'story' | 'task' | 'bug' | 'spike' | 'epic';
  status: 'planned' | 'ready' | 'in-progress' | 'in-review' | 'done' | 'blocked';
  owner: string;
}

export interface ProjectState {
  /** Phase label or description; may be a string like "M0 - crawl". */
  phase: string;
  /** Current focus text; empty string when not present. */
  focus: string;
}

// Status / type helpers

function mapMilestoneStatus(raw: string): Milestone['status'] {
  const s = raw.trim();
  if (s.startsWith('\u2705') || /done/i.test(s)) return 'done';
  if (s.startsWith('\uD83D\uDD35') || /in-progress/i.test(s)) return 'in-progress';
  if (s.startsWith('\u26D4') || /blocked/i.test(s)) return 'blocked';
  return 'planned';
}

function mapItemStatus(raw: string): BacklogItem['status'] {
  const s = raw.trim();
  if (s.startsWith('\u2705') || /^done$/i.test(s)) return 'done';
  if (s.startsWith('\uD83D\uDD35') || /^in-progress$/i.test(s)) return 'in-progress';
  if (s.startsWith('\uD83D\uDC40') || /^in-review$/i.test(s)) return 'in-review';
  if (s.startsWith('\u2B1C') || /^ready$/i.test(s)) return 'ready';
  if (s.startsWith('\u26D4') || /^blocked$/i.test(s)) return 'blocked';
  if (/^planned$/i.test(s)) return 'planned';
  return 'planned';
}

function mapItemType(raw: string): BacklogItem['type'] {
  const s = raw.trim().toLowerCase();
  const valid = new Set<string>(['story', 'task', 'bug', 'spike', 'epic']);
  return valid.has(s) ? (s as BacklogItem['type']) : 'task';
}

function parseGhNumber(raw: string): number {
  const s = raw.trim();
  if (!s || s === '\u2014' || s === '-') return 0;
  const m = s.match(/^#?(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

function parseOwner(raw: string): string {
  const s = raw.trim();
  if (!s || s === '\u2014' || s === '-') return '';
  return s;
}

// Markdown table helpers

/**
 * Parses a markdown table section into rows.
 * Returns array of string[] (one per data row), skipping header and separator.
 */
function parseMarkdownTable(section: string): string[][] {
  const lines = section.split('\n').map(l => l.trim()).filter(l => l.startsWith('|'));
  const dataLines = lines.slice(2);
  return dataLines.map(line => {
    return line.split('|').map(c => c.trim()).filter((_, i, arr) => i > 0 && i < arr.length - 1);
  }).filter(row => row.length > 0);
}

/**
 * Extracts a named section (## Heading) from markdown.
 * Throws if not found.
 */
function extractSection(md: string, heading: string): string {
  const pattern = new RegExp(`##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'i');
  const match = md.match(pattern);
  if (!match) throw new Error(`Section "## ${heading}" not found in markdown`);
  return match[1];
}

/**
 * Tries each heading in order; returns first match or throws with the first heading name.
 */
function extractSectionAny(md: string, ...headings: string[]): string {
  for (const h of headings) {
    try { return extractSection(md, h); } catch { /* try next */ }
  }
  throw new Error(`Section "## ${headings[0]}" not found in markdown`);
}

// Public parsers

/**
 * Parses ROADMAP.md markdown into milestones[].
 *
 * Accepts tables with 4 columns (ID, Name, Phase, Status) or 5 columns
 * (#, Milestone, Phase, Goal, Status). Phase is kept as a string label.
 * Status values may be plain text or emoji; unknown values default to 'planned'.
 */
export function parseRoadmap(md: string): Milestone[] {
  const section = extractSection(md, 'Milestones');
  const rows = parseMarkdownTable(section);

  if (rows.length === 0) throw new Error('Roadmap table has no data rows');

  return rows.map((cols, rowIdx) => {
    if (cols.length < 4) {
      throw new Error(`Roadmap row ${rowIdx + 1} has only ${cols.length} columns, expected 4`);
    }
    const id = cols[0].replace(/\*\*/g, '').trim();
    const name = cols[1].trim();
    const phase = cols[2].trim();
    const status = mapMilestoneStatus(cols[cols.length - 1]);

    return { id, name, phase, status };
  });
}

/**
 * Parses BACKLOG.md markdown into BacklogItem[].
 *
 * Finds all "## Items" and "## Milestone ..." sections and unions their rows.
 * Handles 6-column (ID, GH#, Title, Type, Status, Owner) and 7-column (..., Notes) tables.
 * GH# may be "#n" or the em-dash. Statuses may be emoji.
 */
export function parseBacklog(md: string): BacklogItem[] {
  const parts = md.split(/^(?=##\s)/m);
  const bodies: string[] = [];
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const heading = nl >= 0 ? part.slice(0, nl).replace(/^##\s+/, '').trim() : '';
    if (/^items$/i.test(heading) || /^milestone\b/i.test(heading)) {
      bodies.push(nl >= 0 ? part.slice(nl + 1) : '');
    }
  }

  if (bodies.length === 0) {
    throw new Error('Section "## Items" not found in markdown');
  }

  const allRows: string[][] = [];
  for (const body of bodies) {
    allRows.push(...parseMarkdownTable(body));
  }

  if (allRows.length === 0) throw new Error('Backlog table has no data rows');

  const items: BacklogItem[] = [];
  for (const cols of allRows) {
    if (cols.length < 6) continue;
    const [idRaw, ghRaw, title, typeRaw, statusRaw, ownerRaw] = cols;
    const id = idRaw.trim();
    if (!id) continue;
    items.push({
      id,
      ghNumber: parseGhNumber(ghRaw),
      title: title.trim(),
      type: mapItemType(typeRaw),
      status: mapItemStatus(statusRaw),
      owner: parseOwner(ownerRaw),
    });
  }

  return items;
}

/**
 * Parses PROJECT.md markdown into ProjectState.
 *
 * Accepts both "## Current phase" and "## Phase" as the phase heading.
 * Focus section is optional (returns empty string if absent).
 */
export function parseProject(md: string): ProjectState {
  const phaseSection = extractSectionAny(md, 'Current phase', 'Phase');
  // Take first non-empty line as a concise phase label
  const phaseLines = phaseSection.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const phase = phaseLines.length > 0 ? phaseLines[0] : phaseSection.trim();

  // Focus is optional per ADR-016
  let focus = '';
  try {
    const focusSection = extractSection(md, 'Focus').trim();
    const focusLines = focusSection.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    focus = focusLines.length > 0 ? focusLines[0] : focusSection;
  } catch {
    // not required
  }

  return { phase, focus };
}