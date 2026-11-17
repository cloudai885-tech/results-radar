// Puts a part of the news alerts into the app's public row (Supabase radar id=1, key "news"),
// keeping everything else in that row (ratings, Gap & Go, IPOs) untouched.
export async function publishNews(part, value) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return;
  try {
    const rows = await (await fetch(`${url}/rest/v1/radar?id=eq.1&select=payload`, { headers: { apikey: key } })).json();
    const payload = rows?.[0]?.payload;
    if (!payload) return; // never create the app row from here
    payload.news = { ...(payload.news ?? {}), [part]: value, updated: new Date().toISOString() };
    const res = await fetch(`${url}/rest/v1/radar`, { method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ id: 1, payload, updated_at: new Date().toISOString() }) });
    if (!res.ok) console.warn(`App update failed: ${res.status}`);
  } catch (e) { console.warn(`App update failed: ${e.message}`); }
}
