// Resolves the current API key against an engine's `/me` endpoint to learn
// which `user_id` the engine sees us as. Used to decide which bot rows the
// signed-in user owns (and therefore which pause/resume buttons to render).
//
// The OMS's user_id (Clerk's user object) is *not* what the engine knows —
// the engine only sees whatever the NestJS backend returned for the API
// key. So we round-trip through the engine instead of reading Clerk locally.

export async function fetchEngineUserId(
  server: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const res = await fetch(`http://${server}/me`, {
    headers: { 'Api-Key': apiKey },
    signal,
  });
  if (!res.ok) return null;
  const data = await res.json() as { user_id?: string };
  return data.user_id || null;
}
