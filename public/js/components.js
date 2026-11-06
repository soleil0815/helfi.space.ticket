// Components of a project for ticket field, list filter and create dialog (agents).
// Short cache so the list does not load on every ticket; admins' changes clear it.
import { api } from './api.js';

const cache = new Map(); // projectId → { at, list }
const TTL = 60 * 1000;

export async function projectComponents(projectId) {
  if (!projectId) return [];
  const hit = cache.get(projectId);
  if (hit && Date.now() - hit.at < TTL) return hit.list;
  try {
    const list = (await api.components(projectId)).components;
    cache.set(projectId, { at: Date.now(), list });
    return list;
  } catch { return []; }
}

export function clearComponentCache() { cache.clear(); }
