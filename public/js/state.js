// Application state shared by the desktop UI (app.js) and the mobile UI (/m/js/main.js).
// Kept in its own module so shared modules (e.g. brand.js) do not pull in a whole UI.
export const state = {
  boot: null,
  user: null,
  projects: [],
  agents: [],
  get isAgent() { return this.user && (this.user.role === 'agent' || this.user.role === 'admin'); },
  get isAdmin() { return this.user?.role === 'admin'; },
  /** Projects the person works on as an agent (switcher, board, filters); requests may go to every project */
  get agentProjects() { return this.isAgent ? this.projects.filter((p) => p.agent) : []; },
  /** Agent of this project (id): agent tools for its tickets */
  isAgentOf(projectId) { return !!this.isAgent && this.projects.some((p) => p.id === Number(projectId) && p.agent); },
  get project() {
    let key = null;
    try { key = localStorage.getItem('helfi.project'); } catch { /* ignore */ }
    const list = this.isAgent ? this.agentProjects : this.projects;
    return list.find((p) => p.key === key) || list[0] || null;
  },
  set project(p) { try { localStorage.setItem('helfi.project', p?.key || ''); } catch { /* ignore */ } },
};
