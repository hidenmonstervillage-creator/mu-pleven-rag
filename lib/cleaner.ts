// Strip hashes, publisher names, extensions, Windows short-name suffixes, and everything after first '--'
export function cleanFilename(filename: string): string {
  // Remove file extension
  let name = filename.replace(/\.[^.]+$/, '');

  // Remove Windows 8.3 short-name tilde suffixes: e.g. GRAY'S~1 → GRAY'S, file~2 → file
  name = name.replace(/~\d+/g, '');

  // Remove everything after first '--'
  const dashIndex = name.indexOf('--');
  if (dashIndex !== -1) {
    name = name.substring(0, dashIndex);
  }

  // Remove common hash patterns (8+ hex chars)
  name = name.replace(/[_-]?[0-9a-f]{8,}/gi, '');

  // Replace underscores and hyphens with spaces
  name = name.replace(/[_-]+/g, ' ');

  // Insert space before capital letters that follow lowercase (camelCase → spaced)
  name = name.replace(/([a-z])([A-Z])/g, '$1 $2');

  // Collapse multiple spaces and trim
  name = name.replace(/\s+/g, ' ').trim();

  // Title-case: capitalise first letter of each word, lowercase the rest
  name = name
    .split(' ')
    .map((word) =>
      word.length > 0 ? word[0].toUpperCase() + word.slice(1).toLowerCase() : ''
    )
    .join(' ');

  return name || filename;
}
