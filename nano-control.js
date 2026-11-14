/** Original, independent Nano/Web Serial add-on for Skipper Chen's simulator. */
export function setupNano({getMode, getPose, setJoint, setTarget, setHeight, toggleMode, toggleHold}) {
  const root = document.createElement('section');
  root.className = 'nano-addon';
  root.innerHTML = `<div class="nano-heading"><strong>ARDUINO NANO · USB CONTROL</strong><span id="nanoStatus" role="status">Disconnected</span></div>
  <div class="nano-actions"><button type="button" id="nanoConnect" class="secondary">Connect Nano</button><button type="button" id="nanoDisconnect" class="secondary" disabled>Disconnect</button></div>
  <label class="nano-slider">Joystick sensitivity <output id="nanoSensitivityValue">35%</output><input id="nanoSensitivity" type="range" min="5" max="100" value="35" step="5"></label>
  <div class="nano-readings"><span>X <b id="nanoX">—</b></span><span>Y <b id="nanoY">—</b></span><span>SW <b id="nanoSW">—</b></span><span>B1 <b id="nanoB1">—</b></span><span>B2 <b id="nanoB2">—</b></span></div>
  <p class="nano-help">Joystick: joint angles / Cartesian XY · Hold joystick SW + move Y: tool Z · B1: change mode · B2: hold/resume. Chrome or Edge on HTTPS/localhost.</p>`;
  const aside = document.querySelector('aside.controls');
  if (!aside) throw new Error('Original controls sidebar not found');
  aside.append(root);
  const el = id => root.querySelector('#' + id);
  let port = null, reader = null, closing = false, connected = false;
  let held = false, prevB1 = false, prevB2 = false;
  let lastPacket = 0, lastTick = 0, lastB1 = 0, lastB2 = 0;
  let neutralX = 512, neutralY = 512, samples = 0;
  let lastX = 512, lastY = 512, lastSW = false;
  let accumulatedX = 0, accumulatedY = 0, accumulatedZ = 0;
  let buffered = '';
  const status = (message, error = false) => { el('nanoStatus').textContent = message; el('nanoStatus').style.color = error ? '#ff8d88' : ''; };
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const deadzone = n => Math.abs(n) < 0.15 ? 0 : Math.sign(n) * (Math.abs(n) - 0.15) / 0.85;
  const axis = (raw, center) => deadzone(clamp((raw - center) / 511, -1, 1));
  el('nanoSensitivity').addEventListener('input', () => { el('nanoSensitivityValue').textContent = el('nanoSensitivity').value + '%'; });
  function packet(data) {
    if (!data || !Number.isFinite(data.x) || !Number.isFinite(data.y)) return;
    const x = clamp(Math.round(data.x), 0, 1023), y = clamp(Math.round(data.y), 0, 1023);
    const b1 = data.b1 === 1 || data.b1 === true;
    const b2 = data.b2 === 1 || data.b2 === true;
    const sw = data.sw === 1 || data.sw === true;
    lastPacket = performance.now();
    if (samples < 20 && !b1 && !b2 && !sw) { neutralX = (neutralX * samples + x) / (samples + 1); neutralY = (neutralY * samples + y) / (samples + 1); samples++; }
    lastX = x; lastY = y; lastSW = sw;
    el('nanoX').textContent = x; el('nanoY').textContent = y;
    el('nanoB1').textContent = Number(b1); el('nanoB2').textContent = Number(b2); el('nanoSW').textContent = Number(sw);
    const now = performance.now();
    if (b1 && !prevB1 && now - lastB1 > 220) { lastB1 = now; toggleMode(); }
    if (b2 && !prevB2 && now - lastB2 > 220) { lastB2 = now; held = !held; toggleHold(held); status(held ? 'Position held' : 'Connected'); }
    prevB1 = b1; prevB2 = b2;
  }
  async function readLoop() {
    const decoder = new TextDecoder();
    try {
      while (port && !closing) {
        reader = port.readable.getReader();
        try {
          while (!closing) {
            const {value, done} = await reader.read();
            if (done) break;
            buffered += decoder.decode(value, {stream:true});
            if (buffered.length > 4096) buffered = '';
            let idx;
            while ((idx = buffered.indexOf('\n')) !== -1) {
              const line = buffered.slice(0, idx).trim(); buffered = buffered.slice(idx + 1);
              if (line) { try { packet(JSON.parse(line)); } catch (_) { /* ignore malformed serial line */ } }
            }
          }
        } finally { reader.releaseLock(); reader = null; }
        if (!port.readable) break;
      }
    } catch (err) { if (!closing) status('Serial error: ' + err.message, true); }
    finally { connected = false; el('nanoConnect').disabled = false; el('nanoDisconnect').disabled = true; if (!closing) status('Disconnected'); }
  }
  async function disconnect() {
    closing = true; connected = false;
    try { if (reader) await reader.cancel(); } catch (_) {}
    // Wait for reader.releaseLock() before closing the port.
    for (let i = 0; reader && i < 50; i++) await new Promise(r => setTimeout(r, 10));
    try { if (port) await port.close(); } catch (_) {}
    port = null; closing = false; buffered = ''; held = false; prevB1 = prevB2 = false;
    el('nanoConnect').disabled = false; el('nanoDisconnect').disabled = true; status('Disconnected');
  }
  el('nanoConnect').onclick = async () => {
    if (!('serial' in navigator)) { status('Web Serial unavailable: use Chrome/Edge on HTTPS or localhost', true); return; }
    try {
      port = await navigator.serial.requestPort();
      await port.open({baudRate:9600});
      closing = false; connected = true; samples = 0; neutralX = neutralY = 512;
      lastPacket = performance.now(); lastTick = lastPacket;
      el('nanoConnect').disabled = true; el('nanoDisconnect').disabled = false;
      status('Connected · calibrating neutral');
      void readLoop();
    } catch (err) { status('Connection failed: ' + err.message, true); }
  };
  el('nanoDisconnect').onclick = () => { void disconnect(); };
  navigator.serial?.addEventListener('disconnect', () => { if (port) void disconnect(); });
  function tick(now) {
    requestAnimationFrame(tick);
    if (!connected || held) { lastTick = now; return; }
    if (now - lastPacket > 750) { if (now - lastPacket < 1200) status('No serial data', true); lastTick = now; return; }
    if (samples >= 20 && el('nanoStatus').textContent === 'Connected · calibrating neutral') status('Connected');
    const dt = clamp((now - (lastTick || now)) / 1000, 0, .05); lastTick = now;
    const speed = Number(el('nanoSensitivity').value) / 100;
    const dx = axis(lastX, neutralX), dy = -axis(lastY, neutralY);
    if (lastSW) {
      accumulatedZ += dy * 65 * speed * dt;
      if (Math.abs(accumulatedZ) >= .4) {
        const pose = getPose();
        setHeight(clamp(pose.height + accumulatedZ, 12, 100));
        accumulatedZ = 0;
      }
      return;
    }
    if (getMode() === 'joint') {
      accumulatedX += dx * 120 * speed * dt;
      accumulatedY += dy * 120 * speed * dt;
      if (Math.abs(accumulatedX) + Math.abs(accumulatedY) >= .25) {
        const pose = getPose();
        setJoint(clamp(pose.shoulder + accumulatedX, -180, 180), clamp(pose.elbow + accumulatedY, -180, 180));
        accumulatedX = accumulatedY = 0;
      }
    } else {
      accumulatedX += dx * 160 * speed * dt;
      accumulatedY += dy * 160 * speed * dt;
      if (Math.abs(accumulatedX) + Math.abs(accumulatedY) >= .45) {
        const pose = getPose();
        setTarget(pose.x + accumulatedX, pose.y + accumulatedY);
        accumulatedX = accumulatedY = 0;
      }
    }
  }
  requestAnimationFrame(tick);
}
