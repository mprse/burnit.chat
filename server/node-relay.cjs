'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { URL } = require('node:url');
const mysql = require('mysql2/promise');
const { WebSocket, WebSocketServer } = require('ws');

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const RESUME_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{87}$/;
const IV_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const CIPHERTEXT_PATTERN = /^[A-Za-z0-9_-]{22,87382}$/;

function boundedInteger(name, fallback, minimum, maximum) {
    const parsed = Number.parseInt(process.env[name] || '', 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.min(maximum, Math.max(minimum, parsed));
}

function normalizedPath(value) {
    const withLeadingSlash = value.startsWith('/') ? value : `/${value}`;
    return withLeadingSlash.length > 1
        ? withLeadingSlash.replace(/\/+$/u, '')
        : withLeadingSlash;
}

const config = Object.freeze({
    port: boundedInteger('PORT', 8080, 1, 65535),
    websocketPath: normalizedPath(process.env.BURNIT_WS_PATH || '/ws'),
    runsUnderLiteSpeed: Boolean(process.env.LSNODE_SOCKET),
    allowedOrigins: new Set(
        (
            process.env.BURNIT_ALLOWED_ORIGINS
            || (
                process.env.NODE_ENV === 'production'
                    ? 'https://burnit.chat,https://www.burnit.chat'
                    : 'https://burnit.chat,https://www.burnit.chat,http://localhost,http://127.0.0.1,http://safechat.test'
            )
        )
            .split(',')
            .map((origin) => origin.trim())
            .filter(Boolean)
    ),
    initialRequestTimeoutMs: boundedInteger(
        'BURNIT_INITIAL_REQUEST_TIMEOUT_MS',
        20_000,
        5_000,
        120_000
    ),
    waitingTtlMs: boundedInteger('BURNIT_WAITING_TTL_MS', 900_000, 60_000, 3_600_000),
    reconnectGraceMs: boundedInteger(
        process.env.BURNIT_RECONNECT_GRACE_MS
            ? 'BURNIT_RECONNECT_GRACE_MS'
            : 'BURNIT_CREATOR_RECONNECT_GRACE_MS',
        120_000,
        10_000,
        300_000
    ),
    maxFrameBytes: boundedInteger('BURNIT_MAX_FRAME_BYTES', 70_000, 4_096, 262_144),
    rateLimitMessages: boundedInteger('BURNIT_RATE_LIMIT_MESSAGES', 60, 10, 1_000),
    rateLimitWindowMs: boundedInteger('BURNIT_RATE_LIMIT_WINDOW_MS', 10_000, 1_000, 60_000),
    logLevel: (process.env.BURNIT_LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug')).toLowerCase(),
    database: Object.freeze({
        required: process.env.NODE_ENV === 'production',
        host: process.env.BURNIT_DB_HOST || 'localhost',
        port: boundedInteger('BURNIT_DB_PORT', 3306, 1, 65535),
        name: process.env.BURNIT_DB_NAME || '',
        user: process.env.BURNIT_DB_USER || '',
        password: process.env.BURNIT_DB_PASSWORD || ''
    })
});

const logPriorities = Object.freeze({
    debug: 10,
    info: 20,
    warning: 30,
    error: 40,
    off: 100
});

function log(level, event, context = {}) {
    const configuredPriority = logPriorities[config.logLevel] || logPriorities.info;
    const messagePriority = logPriorities[level] || logPriorities.info;
    if (messagePriority < configuredPriority) {
        return;
    }

    const target = level === 'error' ? console.error : console.log;
    target(JSON.stringify({
        time: new Date().toISOString(),
        level,
        event,
        ...context
    }));
}

function roomTag(roomId) {
    return crypto.createHash('sha256').update(roomId).digest('hex').slice(0, 10);
}

function resumeTokenHash(token) {
    return crypto.createHash('sha256').update(token).digest();
}

function roomIdFromPublicKey(publicKey) {
    try {
        const raw = Buffer.from(publicKey, 'base64url');
        if (
            raw.length !== 65
            || raw[0] !== 0x04
            || raw.toString('base64url') !== publicKey
        ) {
            return null;
        }
        crypto.ECDH.convertKey(raw, 'prime256v1', undefined, undefined, 'uncompressed');
        return crypto
            .createHash('sha256')
            .update(raw)
            .digest()
            .subarray(0, 16)
            .toString('base64url');
    } catch {
        return null;
    }
}

let database = null;
let databaseLockName = null;
let databaseFailed = false;

async function initializeDatabase() {
    const databaseConfigured = Boolean(
        config.database.name
        && config.database.user
        && config.database.password
    );
    if (!databaseConfigured) {
        if (config.database.required) {
            throw new Error(
                'Produkcja wymaga zmiennych BURNIT_DB_NAME, BURNIT_DB_USER i BURNIT_DB_PASSWORD.'
            );
        }
        log('warning', 'database.disabled_for_local_development');
        return;
    }

    database = await mysql.createConnection({
        host: config.database.host,
        port: config.database.port,
        database: config.database.name,
        user: config.database.user,
        password: config.database.password,
        charset: 'utf8mb4',
        connectTimeout: 10_000,
        enableKeepAlive: true
    });

    await database.execute(
        `CREATE TABLE IF NOT EXISTS rooms (
            id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            status ENUM('waiting', 'active') NOT NULL DEFAULT 'waiting',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            INDEX idx_rooms_status_created (status, created_at)
        ) ENGINE=InnoDB`
    );

    if (!config.runsUnderLiteSpeed) {
        databaseLockName = `burnit_ws_${crypto
            .createHash('sha256')
            .update(config.database.name)
            .digest('hex')
            .slice(0, 32)}`;
        const [lockRows] = await database.execute(
            'SELECT GET_LOCK(?, 0) AS acquired',
            [databaseLockName]
        );
        if (Number(lockRows[0]?.acquired) !== 1) {
            throw new Error('Inna instancja relaya burnit.chat korzysta już z tej bazy.');
        }
    }

    const [purgeResult] = await database.execute('DELETE FROM rooms');
    log('info', 'database.ready', {
        host: config.database.host,
        database: config.database.name,
        purgedRows: purgeResult.affectedRows,
        singleInstanceLock: Boolean(databaseLockName)
    });
}

async function insertRoomRecord(roomId) {
    if (!database) {
        return true;
    }
    try {
        await database.execute(
            "INSERT INTO rooms (id, status) VALUES (?, 'waiting')",
            [roomId]
        );
        return true;
    } catch (error) {
        if (error && error.code === 'ER_DUP_ENTRY') {
            return false;
        }
        throw error;
    }
}

async function lockRoomRecord(roomId) {
    if (!database) {
        return true;
    }
    const [result] = await database.execute(
        "UPDATE rooms SET status = 'active' WHERE id = ? AND status = 'waiting'",
        [roomId]
    );
    return result.affectedRows === 1;
}

async function deleteRoomRecord(roomId) {
    if (!database) {
        return;
    }
    try {
        await database.execute('DELETE FROM rooms WHERE id = ?', [roomId]);
    } catch (error) {
        log('error', 'database.room_delete_failed', {
            room: roomTag(roomId),
            error: error.message
        });
    }
}

function handleDatabaseFailure(error) {
    if (databaseFailed) {
        return;
    }
    databaseFailed = true;
    log('error', 'database.connection_lost', { error: error.message });
    for (const websocket of clients.keys()) {
        if (websocket.readyState === WebSocket.OPEN) {
            websocket.close(1011, 'database unavailable');
        } else {
            websocket.terminate();
        }
    }
    server.close(() => process.exit(1));
    const forcedExit = setTimeout(() => process.exit(1), 3_000);
    forcedExit.unref();
}

function requestPath(request) {
    try {
        return new URL(request.url || '/', 'http://localhost').pathname;
    } catch {
        return '';
    }
}

function pathAllowed(pathname) {
    return pathname === '/'
        || pathname === config.websocketPath
        || pathname === `${config.websocketPath}/`;
}

function rejectUpgrade(socket, status, reason) {
    const body = `${reason}\n`;
    socket.end(
        `HTTP/1.1 ${status} ${reason}\r\n`
        + 'Connection: close\r\n'
        + 'Content-Type: text/plain; charset=utf-8\r\n'
        + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`
        + body
    );
}

let serviceReady = false;

const server = http.createServer((request, response) => {
    if (!pathAllowed(requestPath(request))) {
        response.writeHead(404, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        });
        response.end(JSON.stringify({ status: 'not_found' }));
        return;
    }

    if (!serviceReady) {
        response.writeHead(503, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Retry-After': '2',
            'X-Content-Type-Options': 'nosniff'
        });
        response.end(JSON.stringify({
            service: 'burnit.chat-relay',
            status: 'starting'
        }));
        return;
    }

    response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    response.end(JSON.stringify({
        service: 'burnit.chat-relay',
        status: 'ok'
    }));
});

const websocketServer = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    maxPayload: config.maxFrameBytes,
    perMessageDeflate: false
});

server.on('upgrade', (request, socket, head) => {
    const pathname = requestPath(request);
    if (!pathAllowed(pathname)) {
        rejectUpgrade(socket, 404, 'Not Found');
        return;
    }
    if (!serviceReady) {
        rejectUpgrade(socket, 503, 'Service Unavailable');
        return;
    }

    const origin = request.headers.origin || '';
    if (!config.allowedOrigins.has(origin)) {
        log('warning', 'websocket.origin_rejected', {
            origin: origin || null
        });
        rejectUpgrade(socket, 403, 'Forbidden');
        return;
    }

    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        websocketServer.emit('connection', websocket, request);
    });
});

const clients = new Map();
const rooms = new Map();

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sendJson(websocket, payload, callback) {
    if (websocket.readyState !== WebSocket.OPEN) {
        if (callback) {
            callback(new Error('WebSocket is not open.'));
        }
        return;
    }

    websocket.send(JSON.stringify(payload), callback);
}

function closeAfterSend(websocket, code, reason) {
    let closed = false;
    const finish = () => {
        if (closed) {
            return;
        }
        closed = true;
        if (websocket.readyState === WebSocket.OPEN) {
            websocket.close(code, reason);
        } else if (websocket.readyState !== WebSocket.CLOSED) {
            websocket.terminate();
        }
    };

    const timer = setTimeout(finish, 500);
    timer.unref();
    return () => {
        clearTimeout(timer);
        finish();
    };
}

function sendError(websocket, code) {
    const client = clients.get(websocket);
    if (client) {
        client.resumeAllowed = false;
    }
    const finish = closeAfterSend(websocket, 1008, code);
    sendJson(websocket, { type: 'error', code }, finish);
}

function clientContext(websocket) {
    const client = clients.get(websocket);
    if (!client) {
        return { connection: 'disconnected' };
    }
    return {
        connection: client.traceId,
        role: client.role,
        room: client.roomId ? roomTag(client.roomId) : null
    };
}

function destroyClient(websocket, notifyPeer, reason) {
    const client = clients.get(websocket);
    if (!client || client.cleaned) {
        return;
    }

    client.cleaned = true;
    clearTimeout(client.initialRequestTimer);
    clients.delete(websocket);

    const roomId = client.roomId;
    const peer = client.peer;
    client.roomId = null;
    client.peer = null;

    if (roomId) {
        const room = rooms.get(roomId);
        const canResumeWaitingCreator = (
            reason === 'socket_closed'
            && client.resumeAllowed
            && client.role === 'creator'
            && room
            && room.status === 'waiting'
            && room.creator === websocket
            && room.guest === null
        );
        const canResumeActiveParticipant = (
            reason === 'socket_closed'
            && client.resumeAllowed
            && room
            && room.status === 'active'
            && (
                (client.role === 'creator' && room.creator === websocket)
                || (client.role === 'guest' && room.guest === websocket)
            )
        );
        if (canResumeWaitingCreator || canResumeActiveParticipant) {
            const role = client.role;
            const peerRole = role === 'creator' ? 'guest' : 'creator';
            const reconnectUntilField = role === 'creator'
                ? 'creatorReconnectUntil'
                : 'guestReconnectUntil';
            room[role] = null;
            room[reconnectUntilField] = Date.now() + config.reconnectGraceMs;
            const peerSocket = room[peerRole];
            const peerClient = peerSocket ? clients.get(peerSocket) : null;
            if (peerClient && !peerClient.cleaned) {
                peerClient.peer = null;
                sendJson(peerSocket, {
                    type: 'peer_away',
                    reconnectGraceMs: config.reconnectGraceMs
                });
            }

            log('info', canResumeWaitingCreator
                ? 'room.creator_temporarily_disconnected'
                : 'room.participant_temporarily_disconnected', {
                connection: client.traceId,
                role,
                room: roomTag(roomId),
                reconnectGraceMs: config.reconnectGraceMs
            });
            return;
        }

        if (room) {
            room.creatorReconnectUntil = null;
            room.guestReconnectUntil = null;
        }

        rooms.delete(roomId);
        void deleteRoomRecord(roomId);
        log('info', 'room.destroyed', {
            connection: client.traceId,
            role: client.role,
            room: roomTag(roomId),
            reason
        });
    }

    const peerClient = peer ? clients.get(peer) : null;
    if (notifyPeer && peerClient && !peerClient.cleaned) {
        peerClient.roomId = null;
        peerClient.peer = null;
        const finish = closeAfterSend(peer, 1000, 'room closed');
        sendJson(peer, { type: 'force_close' }, finish);
    }
}

function withinRateLimit(client) {
    const now = Date.now();
    if (now - client.rateWindowAt >= config.rateLimitWindowMs) {
        client.rateWindowAt = now;
        client.rateCount = 0;
    }
    client.rateCount += 1;
    return client.rateCount <= config.rateLimitMessages;
}

async function createRoom(websocket, message) {
    const client = clients.get(websocket);
    const roomId = message.roomId;
    const publicKey = message.publicKey;
    const resumeToken = message.resumeToken;
    if (
        client.roomId !== null
        || typeof roomId !== 'string'
        || !ROOM_ID_PATTERN.test(roomId)
        || typeof publicKey !== 'string'
        || !PUBLIC_KEY_PATTERN.test(publicKey)
        || roomIdFromPublicKey(publicKey) !== roomId
        || typeof resumeToken !== 'string'
        || !RESUME_TOKEN_PATTERN.test(resumeToken)
    ) {
        sendError(websocket, 'invalid_request');
        return;
    }
    if (rooms.has(roomId)) {
        sendError(websocket, 'room_exists');
        return;
    }
    if (!await insertRoomRecord(roomId)) {
        sendError(websocket, 'room_exists');
        return;
    }
    if (client.cleaned || websocket.readyState !== WebSocket.OPEN) {
        await deleteRoomRecord(roomId);
        return;
    }

    clearTimeout(client.initialRequestTimer);
    client.roomId = roomId;
    client.role = 'creator';
    rooms.set(roomId, {
        status: 'waiting',
        creator: websocket,
        guest: null,
        createdAt: Date.now(),
        creatorPublicKey: publicKey,
        creatorResumeTokenHash: resumeTokenHash(resumeToken),
        guestResumeTokenHash: null,
        creatorReconnectUntil: null,
        guestReconnectUntil: null
    });
    sendJson(websocket, { type: 'created' });
    log('info', 'room.created', {
        ...clientContext(websocket),
        roomsInMemory: rooms.size
    });
}

function resumeRoom(websocket, message) {
    const client = clients.get(websocket);
    const roomId = message.roomId;
    const resumeToken = message.resumeToken;
    if (
        client.roomId !== null
        || typeof roomId !== 'string'
        || !ROOM_ID_PATTERN.test(roomId)
        || typeof resumeToken !== 'string'
        || !RESUME_TOKEN_PATTERN.test(resumeToken)
    ) {
        sendError(websocket, 'invalid_request');
        return;
    }

    const room = rooms.get(roomId);
    const suppliedHash = resumeTokenHash(resumeToken);
    const now = Date.now();
    const canResumeCreator = Boolean(
        room
        && room.creator === null
        && Number.isFinite(room.creatorReconnectUntil)
        && now <= room.creatorReconnectUntil
        && room.creatorResumeTokenHash
        && crypto.timingSafeEqual(room.creatorResumeTokenHash, suppliedHash)
    );
    const canResumeGuest = Boolean(
        room
        && room.status === 'active'
        && room.guest === null
        && Number.isFinite(room.guestReconnectUntil)
        && now <= room.guestReconnectUntil
        && room.guestResumeTokenHash
        && crypto.timingSafeEqual(room.guestResumeTokenHash, suppliedHash)
    );
    if (!canResumeCreator && !canResumeGuest) {
        sendError(websocket, 'resume_denied');
        return;
    }

    clearTimeout(client.initialRequestTimer);
    client.roomId = roomId;
    client.role = canResumeCreator ? 'creator' : 'guest';
    const peerRole = client.role === 'creator' ? 'guest' : 'creator';
    const reconnectUntilField = client.role === 'creator'
        ? 'creatorReconnectUntil'
        : 'guestReconnectUntil';
    room[client.role] = websocket;
    room[reconnectUntilField] = null;

    const peer = room[peerRole];
    const peerClient = peer ? clients.get(peer) : null;
    client.peer = peerClient && !peerClient.cleaned ? peer : null;
    if (client.peer) {
        peerClient.peer = websocket;
    }

    sendJson(websocket, {
        type: 'resumed',
        roomState: room.status,
        peerPresent: Boolean(client.peer)
    });
    if (client.peer) {
        sendJson(peer, { type: 'peer_returned' });
    }
    log('info', 'room.participant_resumed', {
        ...clientContext(websocket)
    });
}

async function joinRoom(websocket, message) {
    const client = clients.get(websocket);
    const roomId = message.roomId;
    const publicKey = message.publicKey;
    const resumeToken = message.resumeToken;
    if (
        client.roomId !== null
        || typeof roomId !== 'string'
        || !ROOM_ID_PATTERN.test(roomId)
        || typeof publicKey !== 'string'
        || !PUBLIC_KEY_PATTERN.test(publicKey)
        || typeof resumeToken !== 'string'
        || !RESUME_TOKEN_PATTERN.test(resumeToken)
    ) {
        sendError(websocket, 'invalid_request');
        return;
    }

    const room = rooms.get(roomId);
    if (!room) {
        sendError(websocket, 'room_not_found');
        return;
    }
    if (room.status !== 'waiting') {
        sendError(websocket, 'room_locked');
        return;
    }
    if (!room.creator || room.creator.readyState !== WebSocket.OPEN) {
        sendError(websocket, 'creator_away');
        return;
    }
    if (room.guest !== null) {
        sendError(websocket, 'room_locked');
        return;
    }
    if (!await lockRoomRecord(roomId)) {
        sendError(websocket, 'room_locked');
        return;
    }

    clearTimeout(client.initialRequestTimer);
    const creatorClient = clients.get(room.creator);
    if (
        client.cleaned
        || websocket.readyState !== WebSocket.OPEN
        || !creatorClient
        || creatorClient.cleaned
    ) {
        rooms.delete(roomId);
        await deleteRoomRecord(roomId);
        sendError(websocket, 'room_not_found');
        return;
    }

    room.guest = websocket;
    room.status = 'active';
    room.guestResumeTokenHash = resumeTokenHash(resumeToken);
    room.creatorReconnectUntil = null;
    room.guestReconnectUntil = null;
    client.roomId = roomId;
    client.role = 'guest';
    client.peer = room.creator;
    creatorClient.peer = websocket;

    sendJson(room.creator, {
        type: 'peer_joined',
        publicKey
    });
    sendJson(websocket, {
        type: 'joined',
        publicKey: room.creatorPublicKey
    });
    log('info', 'room.locked', {
        ...clientContext(websocket),
        creatorConnection: creatorClient.traceId
    });
}

function validEncryptedPayload(payload) {
    if (!isRecord(payload)) {
        return false;
    }
    const keys = Object.keys(payload);
    return keys.length === 3
        && keys.includes('v')
        && keys.includes('iv')
        && keys.includes('ciphertext')
        && payload.v === 1
        && typeof payload.iv === 'string'
        && IV_PATTERN.test(payload.iv)
        && typeof payload.ciphertext === 'string'
        && CIPHERTEXT_PATTERN.test(payload.ciphertext);
}

function relayMessage(websocket, message) {
    const client = clients.get(websocket);
    const peer = client.peer;
    const room = client.roomId ? rooms.get(client.roomId) : null;
    if (
        client.roomId !== null
        && room?.status === 'active'
        && (!peer || peer.readyState !== WebSocket.OPEN)
        && validEncryptedPayload(message.payload)
    ) {
        sendJson(websocket, {
            type: 'peer_away',
            reconnectGraceMs: config.reconnectGraceMs
        });
        return;
    }
    if (
        client.roomId === null
        || !peer
        || peer.readyState !== WebSocket.OPEN
        || !validEncryptedPayload(message.payload)
    ) {
        sendError(websocket, 'invalid_request');
        return;
    }

    sendJson(peer, {
        type: 'relay',
        payload: message.payload
    });
    log('debug', 'relay.forwarded', {
        ...clientContext(websocket),
        ciphertextCharacters: message.payload.ciphertext.length
    });
}

async function handleMessage(websocket, data, isBinary) {
    const client = clients.get(websocket);
    if (!client || client.cleaned) {
        return;
    }
    if (isBinary || data.length > config.maxFrameBytes) {
        sendError(websocket, 'invalid_request');
        return;
    }
    if (!withinRateLimit(client)) {
        sendError(websocket, 'rate_limited');
        return;
    }

    let message;
    try {
        message = JSON.parse(data.toString('utf8'));
    } catch {
        sendError(websocket, 'invalid_request');
        return;
    }
    if (!isRecord(message) || typeof message.type !== 'string') {
        sendError(websocket, 'invalid_request');
        return;
    }

    switch (message.type) {
        case 'create':
            await createRoom(websocket, message);
            break;
        case 'resume':
            resumeRoom(websocket, message);
            break;
        case 'join':
            await joinRoom(websocket, message);
            break;
        case 'ping':
            sendJson(websocket, { type: 'pong' });
            break;
        case 'relay':
            relayMessage(websocket, message);
            break;
        case 'leave':
            destroyClient(websocket, true, 'client_leave');
            websocket.close(1000, 'session ended');
            break;
        default:
            sendError(websocket, 'invalid_request');
    }
}

websocketServer.on('connection', (websocket) => {
    const traceId = crypto.randomBytes(6).toString('hex');
    const client = {
        traceId,
        roomId: null,
        role: null,
        peer: null,
        rateWindowAt: Date.now(),
        rateCount: 0,
        isAlive: true,
        cleaned: false,
        resumeAllowed: true,
        processing: Promise.resolve(),
        initialRequestTimer: null
    };
    clients.set(websocket, client);

    client.initialRequestTimer = setTimeout(() => {
        if (clients.has(websocket) && client.roomId === null) {
            log('warning', 'client.initial_request_timeout', { connection: traceId });
            websocket.close(1008, 'timeout');
        }
    }, config.initialRequestTimeoutMs);
    client.initialRequestTimer.unref();

    websocket.on('pong', () => {
        client.isAlive = true;
    });
    websocket.on('message', (data, isBinary) => {
        client.processing = client.processing
            .then(() => handleMessage(websocket, data, isBinary))
            .catch((error) => {
                log('error', 'protocol.handler_failed', {
                    ...clientContext(websocket),
                    error: error.message
                });
                sendError(websocket, 'server_error');
            });
    });
    websocket.on('close', () => {
        destroyClient(websocket, true, 'socket_closed');
    });
    websocket.on('error', (error) => {
        log('warning', 'websocket.client_error', {
            ...clientContext(websocket),
            error: error.message
        });
    });

    log('info', 'websocket.connected', {
        connection: traceId,
        activeConnections: clients.size
    });
});

const maintenanceTimer = setInterval(() => {
    if (database) {
        void database.ping().catch(handleDatabaseFailure);
    }

    const now = Date.now();
    for (const [roomId, room] of rooms) {
        const waitingCreatorReconnectExpired = (
            room.status === 'waiting'
            && room.guest === null
            && room.creator === null
            && Number.isFinite(room.creatorReconnectUntil)
            && now > room.creatorReconnectUntil
        );
        const activeCreatorReconnectExpired = (
            room.status === 'active'
            && room.creator === null
            && Number.isFinite(room.creatorReconnectUntil)
            && now > room.creatorReconnectUntil
        );
        const activeGuestReconnectExpired = (
            room.status === 'active'
            && room.guest === null
            && Number.isFinite(room.guestReconnectUntil)
            && now > room.guestReconnectUntil
        );
        const waitingExpired = (
            room.status === 'waiting'
            && now - room.createdAt > config.waitingTtlMs
        );
        if (
            waitingCreatorReconnectExpired
            || activeCreatorReconnectExpired
            || activeGuestReconnectExpired
            || waitingExpired
        ) {
            rooms.delete(roomId);
            void deleteRoomRecord(roomId);
            for (const participant of [room.creator, room.guest]) {
                const participantClient = participant ? clients.get(participant) : null;
                if (!participantClient) {
                    continue;
                }
                participantClient.roomId = null;
                participantClient.peer = null;
                const finish = closeAfterSend(participant, 1000, 'room expired');
                sendJson(participant, { type: 'force_close' }, finish);
            }
            const reason = waitingExpired
                ? 'waiting_ttl'
                : waitingCreatorReconnectExpired
                    ? 'creator_reconnect_timeout'
                    : activeCreatorReconnectExpired
                        ? 'active_creator_reconnect_timeout'
                        : 'active_guest_reconnect_timeout';
            log('info', 'room.expired', {
                room: roomTag(roomId),
                reason,
                roomsInMemory: rooms.size
            });
        }
    }

    for (const [websocket, client] of clients) {
        if (!client.isAlive) {
            websocket.terminate();
            continue;
        }
        client.isAlive = false;
        if (websocket.readyState === WebSocket.OPEN) {
            websocket.ping();
        }
    }
}, 30_000);
maintenanceTimer.unref();

function shutdown(signal) {
    log('info', 'server.stopping', { signal });
    clearInterval(maintenanceTimer);
    for (const websocket of clients.keys()) {
        websocket.close(1001, 'server restart');
    }
    server.close(async () => {
        if (database) {
            try {
                if (databaseLockName) {
                    await database.execute('SELECT RELEASE_LOCK(?)', [databaseLockName]);
                }
                await database.end();
            } catch (error) {
                log('error', 'database.shutdown_failed', { error: error.message });
            }
        }
        process.exit(0);
    });
    const forcedExit = setTimeout(() => process.exit(1), 3_000);
    forcedExit.unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

server.on('error', (error) => {
    log('error', 'server.error', { error: error.message });
});

async function start() {
    // LiteSpeed sprawdza podczas require(app.cjs), czy aplikacja wywołała
    // listen(). Gniazdo musi więc zostać związane przed pierwszym await.
    server.listen(config.port, () => {
        log('info', 'server.bound', {
            port: config.port,
            websocketPath: config.websocketPath,
            runtime: config.runsUnderLiteSpeed ? 'litespeed' : 'standalone'
        });
    });

    await initializeDatabase();
    serviceReady = true;
    log('info', 'server.ready', {
        port: config.port,
        websocketPath: config.websocketPath,
        allowedOrigins: [...config.allowedOrigins],
        nodeEnv: process.env.NODE_ENV || 'development',
        runtime: config.runsUnderLiteSpeed ? 'litespeed' : 'standalone',
        databaseEnabled: Boolean(database)
    });
}

start().catch(async (error) => {
    serviceReady = false;
    log('error', 'server.start_failed', { error: error.message });
    try {
        server.close();
    } catch (closeError) {
        if (closeError.code !== 'ERR_SERVER_NOT_RUNNING') {
            log('error', 'server.startup_close_failed', {
                error: closeError.message
            });
        }
    }
    if (database) {
        try {
            if (databaseLockName) {
                await database.execute('SELECT RELEASE_LOCK(?)', [databaseLockName]);
            }
            await database.end();
        } catch (cleanupError) {
            log('error', 'database.startup_cleanup_failed', {
                error: cleanupError.message
            });
        }
    }
    process.exit(1);
});
