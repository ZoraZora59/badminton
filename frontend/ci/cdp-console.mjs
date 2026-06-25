// 连 appservice，监听异常/console.error，期间 reLaunch 指定页面，输出收集到的错误。
// 用法: node ci/cdp-console.mjs <url>
const PORT = 9222;
const url = process.argv[2] || '/pages/activity/index?id=24';
async function getTargets() { return (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); }
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map(); const logs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    else if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION: ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || JSON.stringify(m.params)).slice(0, 200));
    else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) logs.push(m.params.type + ': ' + m.params.args.map(a => a.value || a.description || a.type).join(' ').slice(0, 200));
  });
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('to ' + method)); } }, 12000); });
  return { ws, ready, send, logs };
}
(async () => {
  const ts = await getTargets();
  const app = ts.find((t) => (t.url || '').includes('appservice'));
  if (!app) { console.log('no appservice'); process.exit(1); }
  const c = connect(app.webSocketDebuggerUrl); await c.ready;
  await c.send('Runtime.enable');
  await c.send('Runtime.evaluate', { expression: `new Promise(r=>wx.reLaunch({url:'${url}',complete:()=>r(1)}))`, awaitPromise: true });
  await new Promise((r) => setTimeout(r, 6000));
  console.log('--- logs (' + c.logs.length + ') ---');
  c.logs.slice(0, 25).forEach((l) => console.log(l));
  // also dump current page data keys
  const d = await c.send('Runtime.evaluate', { expression: `(()=>{const p=getCurrentPages().slice(-1)[0];return JSON.stringify({route:p.route,opts:p.options})})()`, returnByValue: true });
  console.log('page:', d.result.value);
  c.ws.close(); process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
