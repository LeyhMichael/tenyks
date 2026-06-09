function show(id, data, isError = false) {
  const el = document.getElementById(id);
  el.textContent = JSON.stringify(data, null, 2);
  el.className = 'result visible' + (isError ? ' error' : '');
}

async function call(id, url, options = {}) {
  const btn = document.querySelector(`button[onclick="${id.split('-')[0]}()"]`);
  if (btn) btn.disabled = true;

  try {
    const res = await fetch(url, options);
    const data = await res.json();
    show(id, data, !res.ok);
  } catch (err) {
    show(id, { error: err.message }, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function ping() {
  call('ping-result', 'api/ping');
}

function echo() {
  const message = document.getElementById('echo-input').value.trim();
  call('echo-result', 'api/echo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
}

function time() {
  call('time-result', 'api/time');
}

function ask() {
  const prompt = document.getElementById('ask-input').value.trim();
  if (!prompt) return;
  call('ask-result', 'api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
}
