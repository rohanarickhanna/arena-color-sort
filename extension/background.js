// Service worker: makes Are.na API requests on behalf of the content script.
// Content-script fetches are subject to the page's CORS rules; this worker is
// covered by host_permissions, so errors come back as real HTTP statuses.
const ALLOWED = /^https:\/\/api\.are\.na\/v[23]\//;

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (!msg || msg.type !== 'acs:fetch') return;
  if (!ALLOWED.test(msg.url)) { send({ error: 'URL not allowed' }); return; }
  const init = { method: msg.method || 'GET', headers: msg.headers || {}, credentials: 'omit' };
  if (msg.body) init.body = msg.body;
  fetch(msg.url, init)
    .then(async (res) => {
      const headers = {};
      res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      send({ status: res.status, headers, body: await res.text() });
    })
    .catch((err) => send({ error: String(err && err.message || err) }));
  return true; // reply asynchronously
});
