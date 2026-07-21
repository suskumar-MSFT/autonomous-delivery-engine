export interface Milestone {
  id: string;
  name: string;
  phase: number;
  status: 'planned' | 'in-progress' | 'done' | 'blocked';
}

export interface BacklogItem {
  id: string;
  ghNumber: number;
  title: string;
  type: 'story' | 'task' | 'bug' | 'spike';
  status: 'planned' | 'ready' | 'in-progress' | 'done' | 'blocked';
  owner: string;
}

export interface ProjectState {
  phase: number;
  focus: string;
}

const VALID_MILESTONE_STATUSES = new Set(['planned', 'in-progress', 'done', 'blocked']);
const VALID_ITEM_TYPES = new Set(['story', 'task', 'bug', 'spike']);
const VALID_ITEM_STATUSES = new Set(['planned', 'ready', 'in-progress', 'done', 'blocked']);

/**
 * Parses a markdown table section into rows.
 * Returns array of string[] (one per data row), skipping header and separator.
 */
function parseMarkdownTable(section: string): string[][] {
  const lines = section.split('\n').map(l => l.trim()).filter(l => l.startsWith('|'));
  // First line = header, second line = separator (|---|), rest = data
  const dataLines = lines.slice(2);
  return dataLines.map(line => {
    // Split by | and trim, filter empty start/end
    return line.split('|').map(c => c.trim()).filter((_, i, arr) => i > 0 && i < arr.length - 1);
  }).filter(row => row.length > 0);
}

/**
 * Extracts a named section (## Heading) from markdown.
 */
function extractSection(md: string, heading: string): string {
  const pattern = new RegExp(`##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'i');
  const match = md.match(pattern);
  if (!match) throw new Error(`Section "## ${heading}" not found in markdown`);
  return match[1];
}

/**
 * Parses ROADMAP.md markdown into milestones[].
 */
export function parseRoadmap(md: string): Milestone[] {
  const section = extractSection(md, 'Milestones');
  const rows = parseMarkdownTable(section);

  if (rows.length === 0) throw new Error('Roadmap table has no data rows');

  return rows.map((cols, rowIdx) => {
    if (cols.length < 4) {
      throw new Error(`Roadmap row ${rowIdx + 1} has only ${cols.length} columns, expected 4`);
    }
    const [id, name, phaseStr, status] = cols;
    const phase = parseInt(phaseStr, 10);
    if (isNaN(phase)) throw new Error(`Roadmap row ${rowIdx + 1}: invalid phase "${phaseStr}"`);
    if (!VALID_MILESTONE_STATUSES.has(status)) {
      throw new Error(`Roadmap row ${rowIdx + 1}: invalid status "${status}"`);
    }
    return {
      id,
      name,
      phase,
      status: status as Milestone['status'],
    };
  });
}

/**
 * Parses BACKLOG.md markdown into BacklogItem[].
 */
export function parseBacklog(md: string): BacklogItem[] {
  const section = extractSection(md, 'Items');
  const rows = parseMarkdownTable(section);

  if (rows.length === 0) throw new Error('Backlog table has no data rows');

  return rows.map((cols, rowIdx) => {
    if (cols.length < 6) {
      throw new Error(`Backlog row ${rowIdx + 1} has only ${cols.length} columns, expected 6`);
    }
    const [id, ghNumberStr, title, type, status, owner] = cols;
    const ghNumber = parseInt(ghNumberStr, 10);
    if (isNaN(ghNumber)) {
      throw new Error(`Backlog row ${rowIdx + 1}: invalid gh number "${ghNumberStr}"`);
    }
    if (!VALID_ITEM_TYPES.has(type)) {
      throw new Error(`Backlog row ${rowIdx + 1}: invalid type "${type}"`);
    }
    if (!VALID_ITEM_STATUSES.has(status)) {
      throw new Error(`Backlog row ${rowIdx + 1}: invalid status "${status}"`);
    }
    return {
      id,
      ghNumber,
      title,
      type: type as BacklogItem['type'],
      status: status as BacklogItem['status'],
      owner,
    };
  });
}

/**
 * Parses PROJECT.md markdown into ProjectState.
 */
export function parseProject(md: string): ProjectState {
  const phaseSection = extractSection(md, 'Phase');
  const focusSection = extractSection(md, 'Focus');

  const phaseStr = phaseSection.trim();
  const phase = parseInt(phaseStr, 10);
  if (isNaN(phase)) throw new Error(`Invalid phase value: "${phaseStr}"`);

  const focus = focusSection.trim();
  if (!focus) throw new Error('Focus section is empty');

  return { phase, focus };
}
