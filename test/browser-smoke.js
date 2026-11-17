import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import WebSocket from 'ws';

const chromePath = process.env.CHROME_PATH
    || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const targetUrl = process.env.BURNIT_TEST_URL || 'https://burnit.chat/';
const websocketOverride = process.env.BURNIT_TEST_WS_OVERRIDE || '';
const disableHttp2 = process.env.BURNIT_TEST_HTTP1 === '1'
    || process.env.BURNIT_TEST_DISABLE_HTTP2 === '1';
const disableQuic = process.env.BURNIT_TEST_HTTP1 === '1'
    || process.env.BURNIT_TEST_DISABLE_QUIC === '1';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function reservePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
}

async function fetchJson(url, options) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
            const response = await fetch(url, options);
            if (response.ok) {
                return response.json();
            }
        } catch {
            // Chrome może jeszcze uruchamiać port diagnostyczny.
        }
        await delay(100);
    }
    throw new Error(`Chrome nie udostępnił CDP pod ${url}.`);
}

const port = await reservePort();
const profile = await mkdtemp(path.join(os.tmpdir(), 'burnit-browser-smoke-'));
const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    ...(disableHttp2 ? ['--disable-http2'] : []),
    ...(disableQuic ? ['--disable-quic'] : []),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank'
], { stdio: 'ignore' });

let socket;
try {
    await fetchJson(`http://127.0.0.1:${port}/json/version`);
    const target = await fetchJson(
        `http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`,
        { method: 'PUT' }
    );
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });

    let commandId = 0;
    const pending = new Map();
    const events = [];
    socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString('utf8'));
        if (message.id) {
            const waiter = pending.get(message.id);
            if (waiter) {
                pending.delete(message.id);
                waiter(message);
            }
            return;
        }
        if (
            message.method === 'Runtime.exceptionThrown'
            || message.method === 'Log.entryAdded'
            || message.method.startsWith('Network.webSocket')
        ) {
            events.push(message);
        }
    });

    const command = (method, params = {}) => new Promise((resolve, reject) => {
        commandId += 1;
        const id = commandId;
        const timeout = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Brak odpowiedzi CDP na ${method}.`));
        }, 5_000);
        pending.set(id, (message) => {
            clearTimeout(timeout);
            if (message.error) {
                reject(new Error(message.error.message));
            } else {
                resolve(message.result);
            }
        });
        socket.send(JSON.stringify({ id, method, params }));
    });

    await Promise.all([
        command('Runtime.enable'),
        command('Log.enable'),
        command('Network.enable'),
        command('Page.enable')
    ]);
    if (websocketOverride) {
        await command('Page.addScriptToEvaluateOnNewDocument', {
            source: `{
                const NativeWebSocket = window.WebSocket;
                window.WebSocket = class extends NativeWebSocket {
                    constructor(_url, protocols) {
                        super(${JSON.stringify(websocketOverride)}, protocols);
                    }
                };
            }`
        });
    }
    await command('Page.navigate', { url: targetUrl });
    await delay(2_000);
    await command('Runtime.evaluate', {
        expression: "document.querySelector('#create-room').click()"
    });
    await delay(10_000);
    const result = await command('Runtime.evaluate', {
        expression: `JSON.stringify({
            url: location.href,
            status: document.querySelector('#connection-status span')?.textContent,
            inviteVisible: !document.querySelector('#invite-view')?.classList.contains('hidden'),
            closedVisible: !document.querySelector('#closed-view')?.classList.contains('hidden'),
            invite: document.querySelector('#invite-link')?.value
        })`,
        returnByValue: true
    });
    console.log(result.result.value);
    console.log(JSON.stringify(events));
} finally {
    socket?.close();
    chrome.kill();
    await delay(500);
    try {
        await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
        // Windows może przez moment trzymać plik diagnostyczny procesu Chrome.
    }
}
