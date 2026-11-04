// Application state shared by the desktop UI (app.js) and the mobile UI (/m/js/main.js).
// Kept in its own module so shared modules (e.g. brand.js) do not pull in a whole UI.
export const state = {
  boot: null,
  user: null,
  projects: [],
  agents: [],
  get isAgent() { return this.user && (this.user.role === 'agent' || this.user.role === 'admin'); },
  get isAdmin() { return this.user?.role === 'admin'; },
  get project() {
    let key = null;
    try { key = localStorage.getItem('helfi.project'); } catch { /* ignore */ }
    return this.projects.find((p) => p.key === key) || this.projects[0] || null;
  },
  set project(p) { try { localStorage.setItem('helfi.project', p?.key || ''); } catch { /* ignore */ } },
};
