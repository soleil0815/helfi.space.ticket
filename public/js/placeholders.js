// Replace placeholders in canned responses (German and English). No dependencies, so it is testable.
export function fillPlaceholders(text, tk, user) {
  const values = {
    melder: tk?.reporter?.displayName || '', reporter: tk?.reporter?.displayName || '',
    ticket: tk?.key || '',
    titel: tk?.title || '', title: tk?.title || '',
    bearbeiter: user?.displayName || '', agent: user?.displayName || '',
  };
  return String(text).replace(/\{(melder|reporter|ticket|titel|title|bearbeiter|agent)\}/gi, (m, k) => values[k.toLowerCase()] ?? m);
}
