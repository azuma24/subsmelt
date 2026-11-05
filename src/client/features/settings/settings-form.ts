/**
 * Settings page form state: the last server snapshot plus the keys the user has
 * changed since they were last saved. Keeping the two apart is what lets a
 * refetch land without discarding typing, and lets a save that finishes after a
 * newer edit clear only the edits it actually carried.
 */
export type SettingsValues = Record<string, unknown>;

export interface SettingsForm {
  server: SettingsValues;
  edits: SettingsValues;
  /** Saves on their way to the server. Until they land, `server` may not be what the server will hold. */
  inFlight: number;
}

export const EMPTY_FORM: SettingsForm = { server: {}, edits: {}, inFlight: 0 };

export const view = (form: SettingsForm): SettingsValues => ({ ...form.server, ...form.edits });

export const isDirty = (form: SettingsForm): boolean => Object.keys(form.edits).length > 0;

/** What a save sends. Never the snapshot: it may predate a value saved elsewhere, and sending it would undo that. */
export const changes = (form: SettingsForm): SettingsValues => ({ ...form.edits });

export const receiveServer = (form: SettingsForm, server: SettingsValues): SettingsForm => ({ ...form, server });

export function edit(form: SettingsForm, key: string, value: unknown): SettingsForm {
  const edits = { ...form.edits };
  if (form.inFlight === 0 && Object.is(value, form.server[key])) delete edits[key];
  else edits[key] = value;
  return { ...form, edits };
}

export const editMany = (form: SettingsForm, updates: SettingsValues): SettingsForm =>
  Object.entries(updates).reduce((acc, [key, value]) => edit(acc, key, value), form);

/** The server now holds `body`; edits that `body` carried are no longer pending. */
export function saved(form: SettingsForm, body: SettingsValues): SettingsForm {
  const edits: SettingsValues = {};
  for (const [key, value] of Object.entries(form.edits)) {
    if (!Object.is(value, body[key])) edits[key] = value;
  }
  return { server: { ...form.server, ...body }, edits, inFlight: form.inFlight - 1 };
}

export const sending = (form: SettingsForm): SettingsForm => ({ ...form, inFlight: form.inFlight + 1 });

/** The edits the save carried stay pending. */
export const sendFailed = (form: SettingsForm): SettingsForm => ({ ...form, inFlight: form.inFlight - 1 });
