// Ticket history entries: readable field names and values (desktop ticket view and mobile timeline)
import { fmtDate } from './dom.js';
import { t } from './i18n.js';

/** Field name for "changed {field}" */
export function activityFieldLabel(a) {
  return a.field && !a.field.includes(':') && a.action === 'changed' ? t(`field.${a.field}`) : '';
}

/** Old/new value of a change in readable form */
export function activityValue(a, v) {
  if (v === null || v === undefined || v === '') return t('app.none');
  if (a.field === 'status') return t(`status.${v}`);
  if (a.field === 'priority') return t(`priority.${v}`);
  if (a.field === 'type') return t(`type.${v}`);
  if (a.field === 'impact' || a.field === 'urgency') return t(`level.${v}`);
  if (a.field === 'major' || a.field === 'knownError') return t(String(v) === '1' ? 'app.yes' : 'app.no');
  if (['phase', 'changeType', 'risk', 'outcome'].includes(a.field)) return t(`change.${a.field}.${v}`);
  if (a.field === 'plannedStart' || a.field === 'plannedEnd') return fmtDate(v);
  return v;
}
