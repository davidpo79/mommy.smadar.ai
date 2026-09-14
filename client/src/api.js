const BASE = '/api/mommy';

export class ApiError extends Error {
  constructor(status, code, data) {
    super(code);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

async function request(method, path, body) {
  const response = await fetch(BASE + path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    throw new ApiError(response.status, data?.error || `http_${response.status}`, data);
  }
  return data;
}

export const api = {
  session: () => request('GET', '/auth/session'),
  loginManager: (code) => request('POST', '/auth/manager', { code }),
  loginTeam: (code) => request('POST', '/auth/team', { code }),
  logout: () => request('POST', '/auth/logout'),

  state: (week) => request('GET', week ? `/state?week=${encodeURIComponent(week)}` : '/state'),
  revision: () => request('GET', '/revision'),

  createCaregiver: (payload) => request('POST', '/caregivers', payload),
  updateCaregiver: (id, payload) => request('PATCH', `/caregivers/${id}`, payload),
  deleteCaregiver: (id) => request('DELETE', `/caregivers/${id}`),

  createShift: (payload) => request('POST', '/shifts', payload),
  updateShift: (id, payload) => request('PATCH', `/shifts/${id}`, payload),
  deleteShift: (id) => request('DELETE', `/shifts/${id}`),

  createChecklistItem: (payload) => request('POST', '/checklist', payload),
  updateChecklistItem: (id, payload) => request('PATCH', `/checklist/${id}`, payload),
  deleteChecklistItem: (id) => request('DELETE', `/checklist/${id}`),
  clearDoneChecklist: () => request('POST', '/checklist/clear-done'),

  copyPreviousWeek: (week) =>
    request('POST', `/weeks/${encodeURIComponent(week)}/copy-previous`),
};
