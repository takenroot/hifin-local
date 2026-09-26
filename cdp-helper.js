const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://${CDP_HOST}:${CDP_PORT}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
  });
}

async function getTabs() {
  const data = await httpGet('/json/list');
  return JSON.parse(data);
}

async function findOrCreateHiFinTab() {
  const tabs = await getTabs();
  let tab = tabs.find(t => t.url.includes('app.hifin.ai'));
  if (!tab) {
    const data = await httpGet('/json/new?https://app.hifin.ai/account/list');
    tab = JSON.parse(data);
  }
  return tab;
}

function cdpCall(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('CDP timeout'));
    }, 15000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method, params }));
    });

    ws.on('message', (data) => {
      clearTimeout(timeout);
      const msg = JSON.parse(data);
      ws.close();
      resolve(msg);
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function cdpSequence(wsUrl, steps) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const results = [];
    let stepIdx = 0;
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('CDP sequence timeout'));
    }, 30000);

    function next() {
      if (stepIdx >= steps.length) {
        clearTimeout(timeout);
        ws.close();
        resolve(results);
        return;
      }
      const step = steps[stepIdx++];
      ws.send(JSON.stringify({ id: stepIdx, method: step.method, params: step.params || {} }));
    }

    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 0, method: 'Page.enable', params: {} }));
      setTimeout(next, 300);
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.id > 0) {
        results.push({ step: msg.id, result: msg.result, error: msg.error });
        setTimeout(next, 100);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function main() {
  const command = process.argv[2];
  const tab = await findOrCreateHiFinTab();
  console.error('Using tab:', tab.url, tab.id);

  if (command === 'screenshot') {
    const path = process.argv[3] || 'screenshot.png';
    const msg = await cdpCall(tab.webSocketDebuggerUrl, 'Page.captureScreenshot', { format: 'png' });
    if (msg.result && msg.result.data) {
      fs.writeFileSync(path, Buffer.from(msg.result.data, 'base64'));
      console.log('Screenshot saved to', path);
    } else {
      console.error('Screenshot failed:', msg);
      process.exit(1);
    }
  } else if (command === 'eval') {
    const expr = process.argv[3] || 'document.title';
    const msg = await cdpCall(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    console.log(JSON.stringify(msg.result, null, 2));
  } else if (command === 'click-text') {
    const text = process.argv[3];
    const expr = `(() => {
      const el = Array.from(document.querySelectorAll('button, a, [role="button"]')).find(e => e.textContent.includes('${text}'));
      if (el) { el.click(); return 'clicked: ' + el.textContent.trim(); }
      return 'not found';
    })()`;
    const msg = await cdpCall(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    console.log(JSON.stringify(msg.result, null, 2));
  } else if (command === 'navigate') {
    const url = process.argv[3];
    await cdpCall(tab.webSocketDebuggerUrl, 'Page.navigate', { url });
    // wait a bit
    await new Promise(r => setTimeout(r, 2000));
    console.log('Navigated to', url);
  } else if (command === 'html') {
    const msg = await cdpCall(tab.webSocketDebuggerUrl, 'Runtime.evaluate', {
      expression: 'document.documentElement.outerHTML',
      returnByValue: true
    });
    console.log(msg.result.value);
  } else {
    console.log('Usage: node cdp-helper.js [screenshot|eval|click-text|navigate|html] [arg]');
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
