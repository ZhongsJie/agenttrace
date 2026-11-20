export const number = value => Number.isFinite(value) ? value.toLocaleString('en-US') : 'Unknown';
export const duration = value => Number.isFinite(value) ? `${(value / 1000).toFixed(3)} s` : 'Unknown';
export const textOf = value => typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2);
export function clock(value) {
  const total = Math.max(0, Math.floor((value || 0) / 1000));
  return total >= 3600 ? `${Math.floor(total / 3600)}:${String(Math.floor(total / 60) % 60).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}` : `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function modelName(entry) {
  return entry?.session?.context.model || entry?.session?.meta.model || entry?.descriptor?.model || 'Unknown model';
}

export function complete(entry) {
  return !!entry.session && entry.session.turns.length > 0 && entry.session.turns.every(turn => Number.isFinite(turn.end));
}

export function sessionTitle(entry) {
  const filename = entry.name.split(/[\\/]/).pop();
  const match = filename.match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/i);
  return match?.[1] || entry.descriptor?.sessionId || entry.session?.meta.id || entry.session?.meta.session_id || filename;
}

export function sessionDate(entry) {
  const match = entry.name.match(/rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-\d{2}/);
  if (match) return `${match[2]}/${match[3]} ${match[4]}:${match[5]}`;
  const timestamp = Date.parse(entry.descriptor?.startedAt) || entry.session?.start;
  return Number.isFinite(timestamp) && timestamp ? new Date(timestamp).toLocaleString('en-US', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}) : 'No timestamp';
}
