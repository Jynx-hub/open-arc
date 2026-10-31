// File naming for downloads.

/** `name` if free, else `name (1).ext`, `name (2).ext`, … — the first one `taken` says is unused. */
export function uniqueFilename(name: string, taken: (candidate: string) => boolean): string {
  const clean = name.trim() || 'download';
  if (!taken(clean)) return clean;
  // The number goes before the extension. A leading dot (".env") is part of the stem; .tar.gz stays whole.
  const dot = clean.lastIndexOf('.');
  let stem = dot > 0 ? clean.slice(0, dot) : clean;
  let ext = dot > 0 ? clean.slice(dot) : '';
  if (/.\.tar$/i.test(stem)) {
    ext = stem.slice(-4) + ext;
    stem = stem.slice(0, -4);
  }
  for (let i = 1; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!taken(candidate)) return candidate;
  }
}
