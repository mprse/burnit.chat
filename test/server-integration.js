import assert from 'node:assert/strict';
import { createECDH, createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import WebSocket from 'ws';

const allowedOrigin = 'https://burnit.chat';
const externalEndpoint = process.env.BURNIT_TEST_WS || '';

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function reservePort() {
    const probe = net.createServer();
    await new Promise((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', resolve);
    });
    const address = probe.address();
    const port = address.port;
    await new Promise((resolve) => probe.close(resolve));
    return port;
}

async function waitUntilReady(healthUrl, child) {
    let lastError = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (child && child.exitCode !== null) {
            throw new Error(`Relay zakończył działanie z kodem ${child.exitCode}.`);
        }
        try {
            const response = await fetch(healthUrl, { cache: 'no-store' });
            if (response.ok) {
                const health = await response.json();
                assert.deepEqual(health, {
                    service: 'burnit.chat-relay',
                    status: 'ok'
                });
                return;
            }
        } catch (error) {
            lastError = error;
        }
        await delay(100);
    }
    throw new Error(`Relay nie uruchomił się na czas: ${lastError?.message || 'brak odpowiedzi'}`);
}

async function startLocalRelay() {
    const port = await reservePort();
    const child = spawn(process.execPath, ['server/node-relay.cjs'], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            NODE_ENV: 'test',
            PORT: String(port),
            BURNIT_ALLOWED_ORIGINS: allowedOrigin,
            BURNIT_LOG_LEVEL: 'off'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let diagnostics = '';
    child.stdout.on('data', (chunk) => {
        diagnostics += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
        diagnostics += chunk.toString();
    });

    try {
        await waitUntilReady(`http://127.0.0.1:${port}/ws`, child);
    } catch (error) {
        child.kill('SIGTERM');
        throw new Error(`${error.message}\n${diagnostics}`.trim());
    }

    return {
        child,
        endpoint: `ws://127.0.0.1:${port}/ws`,
        diagnostics: () => diagnostics
    };
}

class TestClient {
    #socket;
    #queue = [];
    #waiters = [];

    static async connect(endpoint, origin = allowedOrigin) {
        const client = new TestClient();
        await client.#open(endpoint, origin);
        return client;
    }

    async #open(endpoint, origin) {
        this.#socket = new WebSocket(endpoint, { origin });
        this.#socket.on('message', (data) => {
            const message = JSON.parse(data.toString('utf8'));
            const waiter = this.#waiters.shift();
            if (waiter) {
                clearTimeout(waiter.timer);
                waiter.resolve(message);
            } else {
                this.#queue.push(message);
            }
        });
        await new Promise((resolve, reject) => {
            this.#socket.once('open', resolve);
            this.#socket.once('error', reject);
        });
    }

    send(message) {
        this.#socket.send(JSON.stringify(message));
    }

    receive(timeout = 2_000) {
        const queued = this.#queue.shift();
        if (queued) {
            return Promise.resolve(queued);
        }

        return new Promise((resolve, reject) => {
            const entry = {
                resolve,
                reject,
                timer: null
            };
            entry.timer = setTimeout(() => {
                const index = this.#waiters.indexOf(entry);
                if (index >= 0) {
                    this.#waiters.splice(index, 1);
                    reject(new Error('Przekroczono czas oczekiwania na wiadomość WebSocket.'));
                }
            }, timeout);
            this.#waiters.push(entry);
        });
    }

    close() {
        if (this.#socket.readyState === WebSocket.OPEN) {
            this.#socket.close();
        }
    }
}

async function assertOriginRejected(endpoint) {
    await new Promise((resolve, reject) => {
        const socket = new WebSocket(endpoint, { origin: 'https://attacker.example' });
        const timer = setTimeout(() => {
            socket.terminate();
            reject(new Error('Timeout podczas sprawdzania niedozwolonego Origin.'));
        }, 5_000);
        const finish = (callback) => {
            clearTimeout(timer);
            callback();
        };
        socket.once('open', () => {
            socket.terminate();
            finish(() => reject(new Error('Relay zaakceptował niedozwolony origin.')));
        });
        socket.once('unexpected-response', (_request, response) => {
            assert.ok(
                [403, 503].includes(response.statusCode),
                `Obcy Origin powinien zostać odrzucony kodem 403 albo przez proxy kodem 503, otrzymano ${response.statusCode}.`
            );
            response.resume();
            finish(resolve);
        });
        socket.once('error', () => {
            finish(resolve);
        });
    });
}

let localRelay = null;
let creator = null;
let guest = null;
let intruder = null;
let temporaryGuest = null;
let falseResumer = null;
let invalidCreator = null;

try {
    if (externalEndpoint) {
        await waitUntilReady(externalEndpoint.replace(/^ws/u, 'http'), null);
    } else {
        localRelay = await startLocalRelay();
    }
    const endpoint = externalEndpoint || localRelay.endpoint;

    await assertOriginRejected(endpoint);

    const creatorEcdh = createECDH('prime256v1');
    const creatorPublicKey = creatorEcdh.generateKeys().toString('base64url');
    const roomId = createHash('sha256')
        .update(Buffer.from(creatorPublicKey, 'base64url'))
        .digest()
        .subarray(0, 16)
        .toString('base64url');
    const creatorResumeToken = randomBytes(32).toString('base64url');
    const guestResumeToken = randomBytes(32).toString('base64url');
    const guestEcdh = createECDH('prime256v1');
    const fakePublicKey = guestEcdh.generateKeys().toString('base64url');

    invalidCreator = await TestClient.connect(endpoint);
    invalidCreator.send({
        type: 'create',
        roomId: randomBytes(16).toString('base64url'),
        publicKey: creatorPublicKey,
        resumeToken: randomBytes(32).toString('base64url')
    });
    assert.deepEqual(await invalidCreator.receive(), {
        type: 'error',
        code: 'invalid_request'
    });

    creator = await TestClient.connect(endpoint);
    creator.send({
        type: 'create',
        roomId,
        publicKey: creatorPublicKey,
        resumeToken: creatorResumeToken
    });
    assert.deepEqual(await creator.receive(), { type: 'created' });

    creator.close();
    await delay(100);

    temporaryGuest = await TestClient.connect(endpoint);
    temporaryGuest.send({
        type: 'join',
        roomId,
        publicKey: fakePublicKey,
        resumeToken: randomBytes(32).toString('base64url')
    });
    assert.deepEqual(await temporaryGuest.receive(), {
        type: 'error',
        code: 'creator_away'
    });

    falseResumer = await TestClient.connect(endpoint);
    falseResumer.send({
        type: 'resume',
        roomId,
        resumeToken: randomBytes(32).toString('base64url')
    });
    assert.deepEqual(await falseResumer.receive(), {
        type: 'error',
        code: 'resume_denied'
    });

    creator = await TestClient.connect(endpoint);
    creator.send({ type: 'resume', roomId, resumeToken: creatorResumeToken });
    assert.deepEqual(await creator.receive(), {
        type: 'resumed',
        roomState: 'waiting',
        peerPresent: false
    });

    guest = await TestClient.connect(endpoint);
    guest.send({
        type: 'join',
        roomId,
        publicKey: fakePublicKey,
        resumeToken: guestResumeToken
    });
    assert.deepEqual(await creator.receive(), {
        type: 'peer_joined',
        publicKey: fakePublicKey
    });
    assert.deepEqual(await guest.receive(), {
        type: 'joined',
        publicKey: creatorPublicKey
    });

    intruder = await TestClient.connect(endpoint);
    intruder.send({
        type: 'join',
        roomId,
        publicKey: fakePublicKey,
        resumeToken: randomBytes(32).toString('base64url')
    });
    assert.deepEqual(await intruder.receive(), {
        type: 'error',
        code: 'room_locked'
    });

    const encryptedPayload = {
        v: 1,
        iv: 'AAAAAAAAAAAAAAAA',
        ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA'
    };
    creator.send({ type: 'relay', payload: encryptedPayload });
    assert.deepEqual(await guest.receive(), {
        type: 'relay',
        payload: encryptedPayload
    });

    creator.close();
    assert.deepEqual(await guest.receive(), {
        type: 'peer_away',
        reconnectGraceMs: 120_000
    });
    await delay(100);

    creator = await TestClient.connect(endpoint);
    creator.send({
        type: 'resume',
        roomId,
        resumeToken: creatorResumeToken
    });
    assert.deepEqual(await creator.receive(), {
        type: 'resumed',
        roomState: 'active',
        peerPresent: true
    });
    assert.deepEqual(await guest.receive(), { type: 'peer_returned' });

    guest.close();
    assert.deepEqual(await creator.receive(), {
        type: 'peer_away',
        reconnectGraceMs: 120_000
    });
    await delay(100);

    guest = await TestClient.connect(endpoint);
    guest.send({
        type: 'resume',
        roomId,
        resumeToken: guestResumeToken
    });
    assert.deepEqual(await guest.receive(), {
        type: 'resumed',
        roomState: 'active',
        peerPresent: true
    });
    assert.deepEqual(await creator.receive(), { type: 'peer_returned' });

    creator.close();
    assert.deepEqual(await guest.receive(), {
        type: 'peer_away',
        reconnectGraceMs: 120_000
    });
    guest.close();
    await delay(100);

    creator = await TestClient.connect(endpoint);
    creator.send({
        type: 'resume',
        roomId,
        resumeToken: creatorResumeToken
    });
    assert.deepEqual(await creator.receive(), {
        type: 'resumed',
        roomState: 'active',
        peerPresent: false
    });

    guest = await TestClient.connect(endpoint);
    guest.send({
        type: 'resume',
        roomId,
        resumeToken: guestResumeToken
    });
    assert.deepEqual(await guest.receive(), {
        type: 'resumed',
        roomState: 'active',
        peerPresent: true
    });
    assert.deepEqual(await creator.receive(), { type: 'peer_returned' });

    guest.send({ type: 'relay', payload: encryptedPayload });
    assert.deepEqual(await creator.receive(), {
        type: 'relay',
        payload: encryptedPayload
    });

    creator.send({ type: 'leave' });
    assert.deepEqual(await guest.receive(), { type: 'force_close' });

    console.log(
        'Integracja Node WebSocket: commitment Public A, create, join, relay, resume obu ról i force_close — OK'
    );
} finally {
    creator?.close();
    guest?.close();
    intruder?.close();
    temporaryGuest?.close();
    falseResumer?.close();
    invalidCreator?.close();
    if (localRelay) {
        localRelay.child.kill('SIGTERM');
        await Promise.race([
            new Promise((resolve) => localRelay.child.once('exit', resolve)),
            delay(3_500)
        ]);
        if (localRelay.child.exitCode && localRelay.child.exitCode !== 0) {
            throw new Error(
                `Relay testowy zakończył się z kodem ${localRelay.child.exitCode}.\n`
                + localRelay.diagnostics()
            );
        }
    }
}
