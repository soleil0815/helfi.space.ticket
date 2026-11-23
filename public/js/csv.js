// One text cell of a CSV file for Excel/LibreOffice. Text that starts like a formula (= + - @, also
// after tab/CR) gets a leading ' – a name such as "=HYPERLINK(…)" must stay text when the file is
// opened. Separator, quotes and line breaks are quoted as usual.
export function csvText(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";,\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
