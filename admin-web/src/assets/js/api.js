export async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'request failed');
  return data;
}

export function post(url, body) {
  return requestJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function get(url) {
  return requestJson(url);
}

export function del(url) {
  return requestJson(url, { method: 'DELETE' });
}
