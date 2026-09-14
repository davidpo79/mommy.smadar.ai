export function serializeCaregiver(row, { isManager }) {
  return {
    id: row.id,
    name: row.name,
    // Pay information is manager-only; the team view never receives it.
    paid: isManager ? row.paid : false,
    rate: isManager ? Number(row.hourly_rate) : 0,
    active: row.active,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function serializeShift(row) {
  return {
    id: row.id,
    caregiverId: row.caregiver_id,
    person: row.caregiver_name || '',
    week: row.week_start,
    day: row.day_of_week,
    start: row.start_minute,
    end: row.end_minute,
    note: row.note,
    msg: row.message,
    confirmed: row.confirmed,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

export function serializeChecklistItem(row) {
  return {
    id: row.id,
    text: row.body,
    done: row.done,
    createdById: row.created_by,
    createdByName: row.created_by_name || '',
    doneById: row.done_by,
    doneByName: row.done_by_name || '',
    doneAt: row.done_at,
    position: row.position,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
