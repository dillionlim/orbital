import { httpBase } from './engineUrl';
// Pause / resume a bot on the engine. Owner-only — the engine validates the
// API key, derives the user_id, and refuses if it doesn't match the bot's
// recorded owner. Pausing also kicks any live WS sessions for that client_id.

export type PauseError =
  | 'unauthorized'
  | 'not_owner'
  | 'not_found'
  | 'internal_bot'
  | 'network';

export interface PauseResponse {
  ok: boolean;
  error?: PauseError;
  message?: string;
}

async function call(
  server: string,
  clientId: string,
  apiKey: string,
  action: 'pause' | 'resume',
): Promise<PauseResponse> {
  try {
    const res = await fetch(
      `${httpBase(server)}/bots/${encodeURIComponent(clientId)}/${action}`,
      { method: 'POST', headers: { 'Api-Key': apiKey } },
    );
    if (res.ok) return { ok: true };
    let err: PauseError = 'network';
    if (res.status === 401) err = 'unauthorized';
    else if (res.status === 403) err = 'not_owner';
    else if (res.status === 404) err = 'not_found';
    else if (res.status === 409) err = 'internal_bot';
    let msg = '';
    try {
      const body = await res.json() as { error?: string };
      msg = body.error || '';
    } catch {
      // Ignore body parse failures — status code is enough.
    }
    return { ok: false, error: err, message: msg };
  } catch (e) {
    return { ok: false, error: 'network', message: e instanceof Error ? e.message : '' };
  }
}

export const pauseBot = (server: string, clientId: string, apiKey: string) =>
  call(server, clientId, apiKey, 'pause');

export const resumeBot = (server: string, clientId: string, apiKey: string) =>
  call(server, clientId, apiKey, 'resume');
