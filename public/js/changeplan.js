// Read-only view of a change's plan for approvers who do not work on the change's project
// (desktop approval box and phone approval card). The server sends tk.change.plan only to them.
import { h, richText, fmtDate } from './dom.js';
import { t } from './i18n.js';

const TEXTS = ['reason', 'implementationPlan', 'backoutPlan', 'testPlan'];

export function changePlanView(plan) {
  if (!plan) return null;
  const item = (label, value) => h('div.change-plan-item', h('div.change-plan-label', label), h('div.change-plan-value', value));
  const empty = () => h('span.muted', t('app.emptyValue'));
  const cis = Array.isArray(plan.cis) ? plan.cis : [];
  return h('div.change-plan',
    h('h4.change-plan-title', t('change.planReadOnly')),
    h('div.change-plan-grid',
      item(t('change.f.changeType'), plan.changeType ? t(`change.changeType.${plan.changeType}`) : empty()),
      item(t('change.f.risk'), plan.risk ? t(`change.risk.${plan.risk}`) : empty()),
      item(t('change.f.plannedStart'), plan.plannedStart ? fmtDate(plan.plannedStart) : empty()),
      item(t('change.f.plannedEnd'), plan.plannedEnd ? fmtDate(plan.plannedEnd) : empty())),
    item(t('change.f.services'), plan.services ? plan.services : empty()),
    cis.length ? item(t('ci.inTicket'), cis.map((c) => h('span.change-plan-ci', [t(`ci.kind.${c.kind}`), c.name].filter(Boolean).join(' · ')))) : null,
    TEXTS.map((n) => item(t(`change.f.${n}`), plan[n] ? richText(plan[n]) : empty())));
}
