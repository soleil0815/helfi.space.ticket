// Role and project rights of a person – without dependencies, so every module can use it.
// Agents either work on all projects (agent_scope 'all', admins always) or only on the projects
// listed in project_agents (agent_scope 'projects'): for tickets of other projects they are a user.

export const isAgent = (user) => user && (user.role === 'agent' || user.role === 'admin');

/**
 * Projects an agent works on: null = all projects (admins, agents with "all projects"),
 * otherwise the list of project ids (empty for non-agents). Agents limited to projects whose
 * list was not loaded (withProjects) get none – a forgotten load denies instead of revealing.
 */
export function agentProjects(user) {
  if (!isAgent(user)) return [];
  if (user.role === 'admin' || user.agent_scope !== 'projects') return null;
  return Array.isArray(user.projectIds) ? user.projectIds : [];
}

/** Agent for this project: may see and work on its tickets as an agent */
export function agentOn(user, projectId) {
  const p = agentProjects(user);
  return p === null ? !!isAgent(user) : p.includes(Number(projectId));
}

/** SQL condition "ticket project is one of the agent's projects" (col = column with the project id) */
export function projectScopeSql(user, col = 't.project_id') {
  const p = agentProjects(user);
  if (p === null) return { sql: '1', args: [] };
  return { sql: `${col} IN (SELECT value FROM json_each(?))`, args: [JSON.stringify(p)] };
}

/** Loads the projects of an agent limited to projects (user row from the database). Returns the row. */
export function withProjects(db, user) {
  if (user && user.role === 'agent' && user.agent_scope === 'projects') {
    const ids = db.prepare('SELECT DISTINCT project_id FROM project_agents WHERE user_id=? ORDER BY project_id').all(user.id).map((r) => r.project_id);
    Object.defineProperty(user, 'projectIds', { value: ids, enumerable: false, configurable: true, writable: true });
  }
  return user;
}
