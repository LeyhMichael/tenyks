(function () {
  // Respect global "show back button" setting
  try { if (localStorage.getItem('showBackButton') !== 'true') return; } catch (_) {}

  // Only show when arriving from the platform homepage
  try {
    var ref = document.referrer;
    if (!ref) return;
    var refUrl = new URL(ref);
    var isFromHome = refUrl.origin === window.location.origin && refUrl.pathname === '/';
    if (!isFromHome) return;
  } catch (e) { return; }

  var folder = window.location.pathname.split('/').filter(Boolean)[0] || '';

  var style = document.createElement('style');
  style.textContent = [
    '#tnx-nav{position:fixed;top:16px;left:16px;z-index:2147483647;display:flex;align-items:center;gap:6px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',
    '#tnx-back{display:flex;align-items:center;gap:5px;background:#000;color:#fff;border:none;border-radius:999px;height:32px;padding:0 13px 0 10px;font-size:13px;font-weight:500;cursor:pointer;line-height:1;transition:opacity .15s;white-space:nowrap;}',
    '#tnx-back:hover{opacity:.7;}',
    '#tnx-dots-wrap{position:relative;}',
    '#tnx-dots{display:flex;align-items:center;justify-content:center;background:#000;color:#fff;border:none;border-radius:999px;width:32px;height:32px;font-size:15px;cursor:pointer;line-height:1;transition:opacity .15s;letter-spacing:.5px;padding:0;}',
    '#tnx-dots:hover{opacity:.7;}',
    '#tnx-drop{position:absolute;top:calc(100% + 6px);left:0;background:#fff;border:1px solid #e5e7eb;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,.13);overflow:hidden;min-width:110px;}',
    '#tnx-drop button{display:block;width:100%;text-align:left;padding:9px 14px;background:none;border:none;font-size:13px;color:#111;cursor:pointer;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:nowrap;}',
    '#tnx-drop button:hover{background:#f3f4f6;}',
    '@keyframes tnx-in{from{opacity:0;transform:translateY(-4px);}to{opacity:1;transform:translateY(0);}}',
    '#tnx-nav{animation:tnx-in .18s ease;}',
  ].join('');
  document.head.appendChild(style);

  var nav = document.createElement('div');
  nav.id = 'tnx-nav';
  nav.innerHTML =
    '<button id="tnx-back">' +
      '<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M8.5 1.5L3.5 6.5L8.5 11.5" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      'Back' +
    '</button>' +
    '<div id="tnx-dots-wrap">' +
      '<button id="tnx-dots" aria-label="More options">···</button>' +
    '</div>';
  document.body.appendChild(nav);

  document.getElementById('tnx-back').addEventListener('click', function () {
    history.back();
  });

  var dotsBtn = document.getElementById('tnx-dots');
  var dotsWrap = document.getElementById('tnx-dots-wrap');

  dotsBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    var existing = document.getElementById('tnx-drop');
    if (existing) { existing.remove(); return; }

    var drop = document.createElement('div');
    drop.id = 'tnx-drop';
    var hideBtn = document.createElement('button');
    hideBtn.textContent = 'Hide';
    drop.appendChild(hideBtn);
    dotsWrap.appendChild(drop);

    hideBtn.addEventListener('click', function () {
      if (folder) {
        try {
          var list = JSON.parse(localStorage.getItem('tenyks_hidden') || '[]');
          if (!list.includes(folder)) { list.push(folder); }
          localStorage.setItem('tenyks_hidden', JSON.stringify(list));
        } catch (_) {}
      }
      window.location.href = '/';
    });
  });

  document.addEventListener('click', function () {
    var drop = document.getElementById('tnx-drop');
    if (drop) drop.remove();
  });
})();
