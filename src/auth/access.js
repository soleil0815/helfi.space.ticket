// Role and project rights of a person – without dependencies, so every module can use it.
// The role decides the base: admins and agents work on every project, users on none. On top of that
// a project gives rights: its lead, the members of its agent group (AD/SSO) and people added by hand
// (table project_agents) work on its tickets – whatever their role. A user with such projects acts as
// an agent of exactly those projects; for tickets of every other project they stay a user.

export const isAgent = (user) => user && (user.role === 'agent' || user.role === 'admin');

/**
 * Projects an agent works on: null = all projects (admins, agents), otherwise the list of project ids
 * (empty for users without projects). A person whose projects were not loaded (withProjects) gets
 * none – a forgotten load denies instead of revealing.
 */
export function agentProjects(user) {
  if (!isAgent(user)) return [];
  if (user.role === 'admin' || (user.role === 'agent' && user.projectAgent !== true)) return null;
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

/** SQL (users u): may work on the project given as the one parameter – admins, agents, its people */
export const AGENT_OF_PROJECT = "(u.role IN ('admin','agent') OR u.id IN (SELECT user_id FROM project_agents WHERE project_id=?))";

/**
 * Loads the projects of a user (row from the database) and returns the row. A user with projects
 * (lead, project group, added by hand) becomes an agent of those projects for this request:
 * role 'agent', projectAgent true, projectIds = their projects. Never write such a row back.
 */
export function withProjects(db, user) {
  if (user && user.role === 'user' && user.active !== 0) {
    const ids = db.prepare('SELECT DISTINCT project_id FROM project_agents WHERE user_id=? ORDER BY project_id').all(user.id).map((r) => r.project_id);
    if (ids.length) {
      const hidden = (k, v) => Object.defineProperty(user, k, { value: v, enumerable: false, configurable: true, writable: true });
      hidden('baseRole', 'user');
      hidden('projectAgent', true);
      hidden('projectIds', ids);
      user.role = 'agent';
    }
  }
  return user;
}
