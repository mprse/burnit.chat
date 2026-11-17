'use strict';

const crypto = require('node:crypto');
const WebSocket = require('ws');

const endpoint = process.argv[2];
if (typeof endpoint !== 'string' || !endpoint.startsWith('wss://')) {
    console.error('Podaj bezpieczny endpoint WebSocket wss://.');
    process.exit(2);
}

const socket = new WebSocket(endpoint, {
    origin: 'https://burnit.chat',
    perMessageDeflate: false
});
let roomCreated = false;

const timeout = setTimeout(() => {
    console.error('Timeout testu WebSocket create -> created -> leave.');
    socket.terminate();
    process.exit(1);
}, 12_000);

socket.once('open', () => {
    const ecdh = crypto.createECDH('prime256v1');
    const publicKey = ecdh.generateKeys().toString('base64url');
    const roomId = crypto
        .createHash('sha256')
        .update(Buffer.from(publicKey, 'base64url'))
        .digest()
        .subarray(0, 16)
        .toString('base64url');
    socket.send(JSON.stringify({
        type: 'create',
        roomId,
        publicKey,
        resumeToken: crypto.randomBytes(32).toString('base64url')
    }));
});

socket.once('message', (data, isBinary) => {
    try {
        if (isBinary) {
            throw new Error('Relay zwrócił nieoczekiwaną ramkę binarną.');
        }
        const response = JSON.parse(data.toString('utf8'));
        if (response.type !== 'created') {
            throw new Error(`Nieoczekiwana odpowiedź relaya: ${data}`);
        }
        roomCreated = true;
        socket.send(JSON.stringify({ type: 'leave' }));
    } catch (error) {
        clearTimeout(timeout);
        console.error(error.message);
        socket.terminate();
        process.exit(1);
    }
});

socket.once('error', (error) => {
    clearTimeout(timeout);
    console.error(`Błąd połączenia WebSocket: ${error.message}`);
    process.exit(1);
});

socket.once('close', () => {
    clearTimeout(timeout);
    if (!roomCreated) {
        console.error('WebSocket zamknięto przed utworzeniem testowego pokoju.');
        process.exitCode = 1;
        return;
    }
    console.log('Health check WebSocket create -> created -> leave: OK');
});
