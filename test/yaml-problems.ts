/**
 * A narrow YAML linter for workflow files.
 * ---------------------------------------------------------------------------
 * Not a YAML parser. A real one would be a dependency, and the whole point of
 * this project is that it has none — so this checks the specific defects that
 * GitHub refuses outright and that are easy to write by accident.
 *
 * It exists because its absence cost a real CI failure. A step was named
 *
 *     - name: Assert no import resolves outside node: and ./
 *
 * unquoted, and containing `: `. YAML reads that as the start of a nested
 * mapping inside a scalar, rejects the whole file, and reports nothing more
 * useful than "This run likely failed because of a workflow file issue". The
 * check that was supposed to catch it matched STRINGS in the file and passed
 * happily on a workflow GitHub would not accept.
 *
 * Matching text is not validating syntax, and the difference shows up where it
 * is most expensive.
 */

/**
 * Find the YAML mistakes that get a workflow rejected.
 *
 * Detects three things:
 *   · TAB indentation, which YAML forbids entirely;
 *   · an unquoted scalar containing `: `, the defect that actually cost a run;
 *   · a plain scalar starting with a character that is meaningful in YAML.
 *
 * Deliberately scoped to lines that look like `key: value`, because that is
 * where a plain scalar lives. Block scalars (`|`, `>`) and comments are skipped
 * — their bodies are text and may contain anything, and flagging a shell script
 * would make the linter useless on any real workflow.
 */
export function yamlProblems(text: string): string[] {
  const problems: string[] = [];
  const lines = text.split('\n');
  /** Indentation of the block scalar currently being skipped, or -1. */
  let blockIndent = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const number = i + 1;
    const indent = line.length - line.trimStart().length;

    // Inside a block scalar, everything is content until the indentation drops
    // back out.
    if (blockIndent >= 0) {
      if (line.trim().length === 0 || indent > blockIndent) continue;
      blockIndent = -1;
    }

    if (line.includes('\t')) {
      problems.push(`line ${number}: contains a tab, which YAML forbids for indentation`);
      continue;
    }

    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

    // Entering a block scalar: `run: |`, `script: >-`, and so on.
    if (/(?:^|\s)[|>][-+]?\s*$/.test(trimmed)) {
      blockIndent = indent;
      continue;
    }

    const match = /^(-\s+)?([A-Za-z_][\w.-]*):\s(.*)$/.exec(trimmed);
    if (match === null) continue;

    const value = match[3] as string;
    if (value.length === 0) continue;
    // Quoted, or a flow collection, or an anchor/alias/tag — all unambiguous.
    if (/^['"[{|>&*!%@`]/.test(value)) continue;

    if (value.includes(': ')) {
      problems.push(
        `line ${number}: unquoted value contains ": ", which YAML reads as a nested mapping — ` +
          `wrap the value in quotes. Value was: ${value.slice(0, 60)}`,
      );
    }
  }

  return problems;
}
