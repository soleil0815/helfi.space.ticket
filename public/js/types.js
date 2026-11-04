// Ticket types in the UI. Only agents create problems and changes.
export const TYPES = ['incident', 'request', 'task', 'question', 'problem', 'change'];
export const USER_TYPES = ['incident', 'request', 'task', 'question'];
export const typesFor = (agent) => (agent ? TYPES : USER_TYPES);
