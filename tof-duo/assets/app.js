const ui = new WebUI();
const N = 8, MAX_MM = 3000, ALERT_MM = 400;
const $ = (id) => document.getElementById(id);

const tiny = document.createElement('canvas'); tiny.width = N; tiny.height = N;
const tctx = tiny.getContext('2d');

function hsl2rgb(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
function colorFor(d) {
  if (!(d > 0)) return [18, 22, 32];
  const t = Math.min(1, d / MAX_MM);
  return hsl2rgb(t * 210, 85, 50 - 5 * t);
}
function minOf(z) { const v = z.filter((d) => d > 0); return v.length ? Math.min(...v) : 0; }

// ---- panels: one per board (me + each peer), created on demand ----
const frames = {};     // name -> latest zones
const labels = {};     // name -> display name (any language), falls back to the board id
const titleOf = (n) => labels[n] || n;
function panel(name, isMe) {
  const id = 'p-' + name;
  let el = $(id);
  if (!el) {
    el = document.createElement('figure'); el.id = id;
    el.innerHTML = `<figcaption><span><i class="dot"></i><span class="pn"></span><small></small></span><em>-</em></figcaption>
                    <canvas></canvas>`;
    el.querySelector('.pn').textContent = titleOf(name);
    if (isMe) $('grid').prepend(el); else $('grid').append(el);
  }
  return el;
}

// Fill zones with no reading from valid neighbours (display only). est[i] = true for filled zones.
function fillGaps(zones) {
  const out = zones.slice(), est = new Array(64).fill(false);
  for (let pass = 0; pass < 2; pass++) {
    const snap = out.slice();
    for (let i = 0; i < 64; i++) {
      if (snap[i] > 0) continue;
      const r = Math.floor(i / 8), c = i % 8, v = [];
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc; if ((!dr && !dc) || rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
        if (snap[rr * 8 + cc] > 0) v.push(snap[rr * 8 + cc]);
      }
      if (v.length >= 2) { v.sort((a, b) => a - b); out[i] = v.length % 2 ? v[v.length >> 1] : Math.round((v[v.length / 2 - 1] + v[v.length / 2]) / 2); est[i] = true; }   // median: no fake mid-values at near/far edges
    }
  }
  return { out, est };
}
// Crisp canvas: backing store = CSS size * devicePixelRatio (never upscaled), capped at 300 CSS px.
function fitCanvas(cv) {
  const dpr = window.devicePixelRatio || 1, css = Math.min(cv.clientWidth || 300, 480), px = Math.round(css * dpr);
  if (cv.width !== px || cv.height !== px) { cv.width = px; cv.height = px; }
  return cv.width / 300;   // scale factor for fonts/gaps designed at 300px
}

// Smooth view: true bilinear upsampling 8x8 -> 64x64 (colour computed per pixel), then scaled to the canvas.
const big = document.createElement('canvas'); big.width = 64; big.height = 64;
const bctx = big.getContext('2d');
function drawSmooth(ctx, cv, out) {
  const img = bctx.createImageData(64, 64);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const fx = Math.min(7, Math.max(0, (x + 0.5) / 8 - 0.5)), fy = Math.min(7, Math.max(0, (y + 0.5) / 8 - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(7, x0 + 1), y1 = Math.min(7, y0 + 1), tx = fx - x0, ty = fy - y0;
    const v = (xx, yy) => { const d = out[yy * 8 + xx]; return d > 0 ? d : MAX_MM; };
    const d = (v(x0, y0) * (1 - tx) + v(x1, y0) * tx) * (1 - ty) + (v(x0, y1) * (1 - tx) + v(x1, y1) * tx) * ty;
    const [r, g, b] = colorFor(d); img.data.set([r, g, b, 255], (y * 64 + x) * 4);
  }
  bctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(big, 0, 0, cv.width, cv.height);
}
function drawPanel(name, zones, isMe) {
  frames[name] = zones;
  const el = panel(name, isMe), cv = el.querySelector('canvas'), k = fitCanvas(cv), ctx = cv.getContext('2d');
  const { out, est } = $('fill').checked ? fillGaps(zones) : { out: zones, est: new Array(64).fill(false) };
  ctx.clearRect(0, 0, cv.width, cv.height);
  if ($('view').value === 'matrix') {
    const w = cv.width / N, gap = 3 * k;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i < 64; i++) {
      const x = (i % N) * w + gap / 2, y = Math.floor(i / N) * w + gap / 2, s = w - gap;
      const [r, g, b] = colorFor(out[i]);
      ctx.fillStyle = `rgba(${r|0},${g|0},${b|0},${est[i] ? 0.55 : 1})`;
      ctx.beginPath(); ctx.roundRect(x, y, s, s, 6 * k); ctx.fill();
      if ($('nums').checked) {
        ctx.font = `${est[i] ? 'italic 500' : '600'} ${11 * k}px system-ui`; ctx.fillStyle = est[i] ? 'rgba(255,255,255,.8)' : 'rgba(0,0,0,.75)';
        ctx.fillText(out[i] > 0 ? out[i] : '-', x + s / 2, y + s / 2);
      }
    }
  } else {
    drawSmooth(ctx, cv, out);
    if ($('nums').checked) {
      const w = cv.width / N;
      ctx.font = `${11 * k}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      for (let i = 0; i < 64; i++) if (out[i] > 0) ctx.fillText(out[i], (i % N) * w + w / 2, Math.floor(i / N) * w + w / 2);
    }
  }
  const m = minOf(zones);
  el.querySelector('em').textContent = m ? m + ' mm' : '-';
  checkAlert();
}
function checkAlert() {
  const close = Object.entries(frames).map(([n, z]) => [n, minOf(z)]).filter(([, m]) => m && m < ALERT_MM);
  const el = $('alert');
  el.classList.toggle('hidden', close.length < 2);
  if (close.length >= 2) el.textContent = '동시 접근 감지 · ' + close.map(([n, m]) => `${n} ${m}mm`).join(' / ');
}

let myName = '';
ui.on_message('local_zones', (m) => { if (myName) drawPanel(myName, m.zones, true); });
ui.on_message('peer_zones', (m) => { if (m.label) labels[m.name] = m.label; drawPanel(m.name, m.zones, false); });
ui.on_message('status', (s) => {
  myName = s.name || myName;
  if (s.team) $('hublink').href = '/hub/index.html?team=' + encodeURIComponent(s.team) + '&mode=radar';
  if (s.sensor_ok === false) $('msg').textContent = '내 센서 데이터가 들어오지 않습니다. 배선을 확인하고 앱을 재시작하세요.';
  else if ($('msg').textContent.startsWith('내 센서')) $('msg').textContent = '';
  if (s.label) labels[myName] = s.label;
  s.peers.forEach((p) => { if (p.label) labels[p.name] = p.label; });
  document.querySelectorAll('#grid figure').forEach((f) => { const n = f.id.slice(2); f.querySelector('.pn').textContent = titleOf(n); });
  $('link').classList.toggle('on', s.mqtt);
  $('link-text').textContent = !s.team ? '설정 필요' : s.mqtt ? `${s.broker} 연결됨` : 'MQTT 재연결 중...';
  $('s-mqtt').textContent = s.mqtt ? 'ON' : 'OFF';
  $('s-tx').textContent = s.tx_ok;
  $('s-team').textContent = s.team || '-';
  const alive = s.peers.filter((p) => p.alive).length;
  $('s-peers').textContent = `${alive} / ${s.peers.length}`;
  s.peers.forEach((p) => {
    const el = panel(p.name, false);
    el.querySelector('.dot').classList.toggle('on', p.alive);
    el.querySelector('small').textContent = p.alive ? `${p.fps}Hz · 손실 ${p.loss_pct}%` : '응답 없음';
  });
  const me = myName && $('p-' + myName);
  if (me) me.querySelector('.dot').classList.toggle('on', s.mqtt);
});

async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
$('connect').onclick = async () => {
  const body = { team: $('team').value, name: $('name').value, label: $('label').value, broker: $('broker').value };
  const r = await post('/set_config', body);
  $('msg').textContent = r.ok ? '' : (r.error || '설정 실패');
  if (r.ok) {
    document.querySelectorAll('#grid figure').forEach((f) => f.remove());
    Object.keys(frames).forEach((k) => delete frames[k]);
    myName = r.name;
    try { localStorage.setItem('tofteam', JSON.stringify(body)); } catch (e) {}
  }
};
$('view').onchange = $('nums').onchange = $('fill').onchange = () => Object.entries(frames).forEach(([n, z]) => drawPanel(n, z, n === myName));

(async () => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('tofteam') || '{}'); } catch (e) {}
  try { const s = await (await fetch('/state')).json(); Object.entries(s).forEach(([k, v]) => { if (v) saved[k] = v; }); } catch (e) {}
  ['team', 'name', 'label', 'broker'].forEach((k) => { if (saved[k]) $(k).value = saved[k]; });
})();

// Frame reset: forget all received frames / panels / stats (also on the server) before a recording or a retry.
$('reset').onclick = async () => {
  try { await post('/reset', {}); } catch (e) {}
  document.querySelectorAll('#grid figure').forEach((f) => f.remove());
  Object.keys(frames).forEach((k) => delete frames[k]);
  $('alert').classList.add('hidden');
  $('msg').textContent = '프레임을 초기화했습니다. 새 프레임이 들어오면 다시 표시됩니다.';
};
