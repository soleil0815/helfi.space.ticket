// Replace placeholders in canned responses (German and English). No dependencies, so it is testable.
export function fillPlaceholders(text, tk, user) {
  const values = {
    // {kunde}/{customer} since 1.55; {melder}/{reporter} keep working in existing templates
    kunde: tk?.reporter?.displayName || '', customer: tk?.reporter?.displayName || '',
    melder: tk?.reporter?.displayName || '', reporter: tk?.reporter?.displayName || '',
    ticket: tk?.key || '',
    titel: tk?.title || '', title: tk?.title || '',
    bearbeiter: user?.displayName || '', agent: user?.displayName || '',
  };
  return String(text).replace(/\{(kunde|customer|melder|reporter|ticket|titel|title|bearbeiter|agent)\}/gi, (m, k) => values[k.toLowerCase()] ?? m);
}
