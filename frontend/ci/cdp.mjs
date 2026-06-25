// 极简 CDP 客户端：连微信开发者工具的 --remote-debugging-port，截图/导航/注入/点击。
// 用法: node ci/cdp.mjs shot <out.png> [targetIndex]
//       node ci/cdp.mjs list
//       node ci/cdp.mjs tap <x> <y> [targetIndex]
//       node ci/cdp.mjs eval "<expr>" [targetIndex]
const PORT = 9222;
const HOST = '127.0.0.1';

async function getTargets() {
  const r = await fetch(`http://${HOST}:${PORT}/json`);
  return r.json();
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params }));
      setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('timeout ' + method)); } }, 15000);
    });
  return { ws, ready, send, events };
}

const [, , cmd, a1, a2] = process.argv;

(async () => {
  const ts = await getTargets();
  const cand = ts.filter((t) => (t.type === 'page' || t.type === 'webview') && t.webSocketDebuggerUrl);
  if (cmd === 'list') {
    ts.forEach((t, i) => console.log(i, t.type, '|', (t.title || '').slice(0, 50), '|', (t.url || '').slice(0, 70)));
    return;
  }
  // selector: shot <out> <sel>; tap <x> <y> <sel>; eval <expr> <sel>
  const sel = cmd === 'shot' ? process.argv[4] : cmd === 'tap' ? process.argv[5] : cmd === 'reload' ? a1 : process.argv[4];
  let target;
  if (sel == null || sel === '') target = cand[0];
  else if (/^\d+$/.test(sel)) target = cand[Number(sel)];
  else target = cand.find((t) => ((t.url || '') + (t.title || '')).includes(sel));
  if (!target) { console.error('no target for selector', sel, '— candidates:', cand.map((t) => t.url.slice(0, 40))); process.exit(2); }
  const c = connect(target.webSocketDebuggerUrl);
  await c.ready;

  if (cmd === 'shot') {
    await c.send('Page.enable');
    const { data } = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const fs = await import('fs');
    fs.writeFileSync(a1, Buffer.from(data, 'base64'));
    console.log('saved', a1, '->', target.url.slice(0, 55));
  } else if (cmd === 'tap') {
    const x = Number(a1), y = Number(a2);
    for (const type of ['touchStart', 'touchEnd']) {
      await c.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchStart' ? [{ x, y }] : [],
      });
    }
    // 同时发鼠标点击兜底（IDE 自身 UI 用鼠标）
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    console.log('tapped', x, y);
  } else if (cmd === 'reload') {
    await c.send('Page.enable');
    await c.send('Page.reload', {});
    console.log('reloaded', target.url.slice(0, 50));
  } else if (cmd === 'eval') {
    const r = await c.send('Runtime.evaluate', { expression: a1, returnByValue: true, awaitPromise: true });
    console.log(JSON.stringify(r.result?.value ?? r.result, null, 2));
  }
  c.ws.close();
  process.exit(0);
})().catch((e) => { console.error('CDP ERR', e.message); process.exit(1); });
