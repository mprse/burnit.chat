import {
    deriveSessionKeys,
    generateEphemeralKeyPair,
    roomIdFromPublicKey
} from './crypto.js';
import { language, t, translateError } from './i18n.js';

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{87}$/u;
const MAX_MESSAGE_LENGTH = 4000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const SESSION_RESUME_WINDOW_MS = 120_000;
const RESUME_RETRY_MAX_DELAY_MS = 5_000;
const GUEST_JOIN_RETRY_INTERVAL_MS = 3_000;
const GUEST_JOIN_RETRY_WINDOW_MS = 120_000;
const DEBUG_ENABLED = window.SAFECHAT_CONFIG?.debug === true;

const views = {
    welcome: document.querySelector('#welcome-view'),
    invite: document.querySelector('#invite-view'),
    joining: document.querySelector('#joining-view'),
    chat: document.querySelector('#chat-view'),
    closed: document.querySelector('#closed-view')
};
const elements = {
    status: document.querySelector('#connection-status'),
    createRoom: document.querySelector('#create-room'),
    inviteLink: document.querySelector('#invite-link'),
    copyLink: document.querySelector('#copy-link'),
    cancelRoom: document.querySelector('#cancel-room'),
    joiningTitle: document.querySelector('#joining-title'),
    joiningMessage: document.querySelector('#joining-message'),
    endChat: document.querySelector('#end-chat'),
    sendButton: document.querySelector('.send-button'),
    form: document.querySelector('#message-form'),
    input: document.querySelector('#message-input'),
    messages: document.querySelector('#messages'),
    peerLabel: document.querySelector('#peer-label'),
    closedTitle: document.querySelector('#closed-title'),
    closedMessage: document.querySelector('#closed-message')
};

const state = {
    socket: null,
    roomId: '',
    role: '',
    localKeys: null,
    creatorPublicKey: '',
    guestPublicKey: '',
    channel: null,
    phase: 'idle',
    intentionalClose: false,
    handshakeTimer: null,
    resumeToken: '',
    resumeDeadline: 0,
    resumeTimer: null,
    resumeAttempt: 0,
    resumePending: false,
    guestJoinDeadline: 0,
    guestJoinTimer: null,
    guestJoinPending: false,
    inboundProcessing: Promise.resolve(),
    wakeLock: null,
    wakeLockPending: false
};

function clientLog(level, event, context = {}) {
    if (!DEBUG_ENABLED && level === 'debug') {
        return;
    }

    const method = ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'log';
    console[method](`[burnit.chat] ${event}`, {
        time: new Date().toISOString(),
        phase: state.phase,
        role: state.role || null,
        ...context
    });
}

function showView(name) {
    Object.entries(views).forEach(([viewName, element]) => {
        element.classList.toggle('hidden', viewName !== name);
    });
    document.body.classList.toggle('chat-active', name === 'chat');
}

function setStatus(kind, label) {
    elements.status.className = `status status--${kind}`;
    elements.status.querySelector('span').textContent = label;
}

function setPhase(phase) {
    clientLog('debug', 'session.phase_changed', { from: state.phase, to: phase });
    state.phase = phase;
    document.body.classList.toggle('session-active', !['idle', 'closed'].includes(phase));
    if (['idle', 'closed'].includes(phase)) {
        void releaseWakeLock();
    } else {
        void requestWakeLock();
    }
}

function sessionNeedsWakeLock() {
    return !['idle', 'closed'].includes(state.phase);
}

async function requestWakeLock() {
    if (
        !('wakeLock' in navigator)
        || document.visibilityState !== 'visible'
        || !sessionNeedsWakeLock()
        || state.wakeLock
        || state.wakeLockPending
    ) {
        return;
    }

    state.wakeLockPending = true;
    try {
        const wakeLock = await navigator.wakeLock.request('screen');
        if (!sessionNeedsWakeLock()) {
            await wakeLock.release();
            return;
        }
        state.wakeLock = wakeLock;
        wakeLock.addEventListener('release', () => {
            if (state.wakeLock === wakeLock) {
                state.wakeLock = null;
            }
            clientLog('debug', 'screen_wake_lock.released');
        });
        clientLog('debug', 'screen_wake_lock.acquired');
    } catch (error) {
        clientLog('warn', 'screen_wake_lock.unavailable', {
            error: error.name || 'unknown'
        });
    } finally {
        state.wakeLockPending = false;
    }
}

async function releaseWakeLock() {
    const wakeLock = state.wakeLock;
    state.wakeLock = null;
    if (!wakeLock || wakeLock.released) {
        return;
    }
    try {
        await wakeLock.release();
    } catch {
        // Przeglądarka mogła już automatycznie zwolnić blokadę.
    }
}

function getRoomIdFromPath() {
    const segments = location.pathname.split('/').filter(Boolean);
    const candidate = segments.at(-1) ?? '';
    return ROOM_ID_PATTERN.test(candidate) ? candidate : '';
}

function applicationBaseUrl() {
    const url = new URL(location.href);
    url.hash = '';
    url.search = '';
    if (getRoomIdFromPath()) {
        url.pathname = url.pathname.replace(/\/[A-Za-z0-9_-]{22}\/?$/u, '/');
    } else if (!url.pathname.endsWith('/')) {
        url.pathname += '/';
    }
    return url;
}

function invitationBaseUrl() {
    const configured = window.SAFECHAT_CONFIG?.publicBaseUrl;
    if (typeof configured !== 'string') {
        throw new Error('Brak publicznego adresu aplikacji w config.js.');
    }

    const url = new URL(configured);
    if (!url.pathname.endsWith('/')) {
        url.pathname += '/';
    }
    url.hash = '';
    url.search = '';
    return url;
}

function websocketUrl() {
    const configured = window.SAFECHAT_CONFIG?.websocketUrl;
    if (typeof configured !== 'string' || !/^wss?:\/\//u.test(configured)) {
        throw new Error('Brak poprawnego adresu serwera WebSocket w config.js.');
    }
    if (location.protocol === 'https:' && !configured.startsWith('wss://')) {
        throw new Error('Strona HTTPS wymaga bezpiecznego połączenia wss://.');
    }
    return configured;
}

function randomResumeToken() {
    const bytes = new Uint8Array(32);
    window.crypto.getRandomValues(bytes);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary)
        .replace(/\+/gu, '-')
        .replace(/\//gu, '_')
        .replace(/=+$/gu, '');
}

function clearResumeState(removeToken = false) {
    clearTimeout(state.resumeTimer);
    state.resumeTimer = null;
    state.resumeDeadline = 0;
    state.resumeAttempt = 0;
    state.resumePending = false;
    if (removeToken) {
        state.resumeToken = '';
    }
}

function clearGuestJoinRetry() {
    clearTimeout(state.guestJoinTimer);
    state.guestJoinTimer = null;
    state.guestJoinDeadline = 0;
    state.guestJoinPending = false;
}

function scheduleGuestJoinRetry(delay = GUEST_JOIN_RETRY_INTERVAL_MS) {
    if (
        state.intentionalClose
        || state.role !== 'guest'
        || state.phase !== 'joining'
        || !state.localKeys
        || !state.guestPublicKey
    ) {
        return;
    }

    if (!state.guestJoinDeadline) {
        state.guestJoinDeadline = Date.now() + GUEST_JOIN_RETRY_WINDOW_MS;
    }
    if (Date.now() >= state.guestJoinDeadline) {
        closeSession(
            t('Twórca jest niedostępny'),
            t('Przez 2 minuty nie udało się połączyć z twórcą pokoju. Poproś o nowe zaproszenie.'),
            false
        );
        return;
    }

    clearTimeout(state.guestJoinTimer);
    elements.joiningTitle.textContent = t('Twórca chwilowo niedostępny');
    elements.joiningMessage.textContent = t('Ponawiamy połączenie co 3 sekundy przez maksymalnie 2 minuty. Nie odświeżaj strony.');
    setStatus('busy', t('Oczekiwanie na twórcę'));
    state.guestJoinTimer = setTimeout(() => {
        state.guestJoinTimer = null;
        void retryGuestJoin();
    }, delay);
}

function sendGuestJoinRequest() {
    sendToServer({
        type: 'join',
        roomId: state.roomId,
        publicKey: state.guestPublicKey,
        resumeToken: state.resumeToken
    });
    startHandshakeTimer();
}

async function retryGuestJoin() {
    if (
        state.guestJoinPending
        || state.intentionalClose
        || state.role !== 'guest'
        || state.phase !== 'joining'
        || !state.localKeys
        || !state.guestPublicKey
    ) {
        return;
    }
    if (Date.now() >= state.guestJoinDeadline) {
        scheduleGuestJoinRetry();
        return;
    }

    state.guestJoinPending = true;
    setStatus('busy', t('Ponawianie połączenia'));
    clientLog('info', 'room.guest_join_retry_started');
    try {
        await connectSocket();
        sendGuestJoinRequest();
    } catch (error) {
        clientLog('warn', 'room.guest_join_retry_failed', {
            error: error.message
        });
        state.guestJoinPending = false;
        scheduleGuestJoinRetry();
    }
}

function sessionCanResume() {
    return Boolean(
        state.resumeToken
        && (
            (state.role === 'creator' && state.phase === 'waiting')
            || ['paused', 'reconnecting'].includes(state.phase)
        )
    );
}

function scheduleSessionResume(delay = 0) {
    if (
        state.intentionalClose
        || !sessionCanResume()
    ) {
        return;
    }

    if (!state.resumeDeadline) {
        state.resumeDeadline = Date.now() + SESSION_RESUME_WINDOW_MS;
    }
    if (Date.now() >= state.resumeDeadline) {
        closeSession(
            t(state.phase === 'waiting' ? 'Pokój wygasł' : 'Rozmowa wygasła'),
            t('Nie udało się wznowić połączenia w ciągu 2 minut.'),
            false
        );
        return;
    }

    clearTimeout(state.resumeTimer);
    setStatus('busy', t('Wznawianie'));
    state.resumeTimer = setTimeout(() => {
        state.resumeTimer = null;
        if (document.visibilityState !== 'visible') {
            scheduleSessionResume(1_000);
            return;
        }
        void resumeSession();
    }, delay);
}

async function resumeSession() {
    if (
        state.resumePending
        || state.intentionalClose
        || !sessionCanResume()
    ) {
        return;
    }
    if (Date.now() >= state.resumeDeadline) {
        scheduleSessionResume();
        return;
    }

    state.resumePending = true;
    state.resumeAttempt += 1;
    try {
        await connectSocket();
        sendToServer({
            type: 'resume',
            roomId: state.roomId,
            resumeToken: state.resumeToken
        });
    } catch (error) {
        clientLog('warn', 'room.resume_connection_failed', {
            attempt: state.resumeAttempt,
            error: error.message
        });
        state.resumePending = false;
        const delay = Math.min(
            RESUME_RETRY_MAX_DELAY_MS,
            500 * (2 ** Math.min(state.resumeAttempt, 4))
        );
        scheduleSessionResume(delay);
    }
}

function connectSocket() {
    return new Promise((resolve, reject) => {
        let settled = false;
        const endpoint = websocketUrl();
        clientLog('info', 'websocket.connecting', { endpoint });
        const socket = new WebSocket(endpoint);
        state.socket = socket;
        state.inboundProcessing = Promise.resolve();

        socket.addEventListener('open', () => {
            settled = true;
            clientLog('info', 'websocket.opened', { endpoint });
            setStatus('busy', t('Negocjowanie'));
            resolve(socket);
        }, { once: true });

        socket.addEventListener('message', (event) => {
            if (state.socket !== socket) {
                return;
            }
            state.inboundProcessing = state.inboundProcessing
                .then(() => handleServerMessage(event.data));
        });

        socket.addEventListener('error', () => {
            clientLog('error', 'websocket.error', {
                endpoint,
                readyState: socket.readyState
            });
            if (!settled) {
                settled = true;
                reject(new Error(t(
                    'Serwer nie odpowiada pod {endpoint}. Sprawdź, czy usługa WebSocket jest uruchomiona.',
                    { endpoint }
                )));
            }
        });

        socket.addEventListener('close', (event) => {
            clientLog(event.wasClean ? 'info' : 'warn', 'websocket.closed', {
                code: event.code,
                reason: event.reason || null,
                wasClean: event.wasClean
            });
            if (!settled) {
                settled = true;
                reject(new Error(t('Serwer zamknął połączenie przed utworzeniem pokoju.')));
                return;
            }
            if (state.socket !== socket) {
                return;
            }
            state.socket = null;
            if (
                !state.intentionalClose
                && state.role === 'guest'
                && state.phase === 'joining'
                && state.guestJoinDeadline
            ) {
                state.guestJoinPending = false;
                if (!state.guestJoinTimer) {
                    scheduleGuestJoinRetry();
                }
                return;
            }
            if (
                !state.intentionalClose
                && state.resumeToken
                && (
                    (state.role === 'creator' && state.phase === 'waiting')
                    || ['active', 'paused', 'reconnecting'].includes(state.phase)
                )
            ) {
                state.resumePending = false;
                if (state.phase !== 'waiting') {
                    pauseActiveChat(
                        'reconnecting',
                        t('Połączenie przerwane — próbujemy wrócić przez 2 minuty.')
                    );
                }
                scheduleSessionResume();
                return;
            }
            if (!state.intentionalClose && !['closed', 'idle'].includes(state.phase)) {
                closeSession(
                    t('Połączenie zostało przerwane'),
                    t('Pokój został unieważniony. Klucze zwolniono z pamięci tej karty.'),
                    false
                );
            }
        });
    });
}

function sendToServer(message) {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
        throw new Error(t('Brak aktywnego połączenia z serwerem.'));
    }
    const serialized = JSON.stringify(message);
    clientLog('debug', 'protocol.outbound', {
        type: message.type,
        bytes: new Blob([serialized]).size
    });
    state.socket.send(serialized);
}

async function createRoom() {
    if (!window.isSecureContext || !window.crypto?.subtle) {
        closeSession(
            t('Ta strona nie ma bezpiecznego kontekstu'),
            t('Szyfrowanie w przeglądarce wymaga otwarcia strony przez HTTPS.'),
            false
        );
        return;
    }

    elements.createRoom.disabled = true;
    setStatus('busy', t('Tworzenie'));
    setPhase('creating');
    clientLog('info', 'room.create_started');
    try {
        state.role = 'creator';
        state.resumeToken = randomResumeToken();
        state.localKeys = await generateEphemeralKeyPair();
        state.creatorPublicKey = state.localKeys.publicKey;
        state.roomId = await roomIdFromPublicKey(state.creatorPublicKey);
        await connectSocket();
        sendToServer({
            type: 'create',
            roomId: state.roomId,
            publicKey: state.creatorPublicKey,
            resumeToken: state.resumeToken
        });
    } catch (error) {
        clientLog('error', 'room.create_failed', { error: error.message });
        closeSession(t('Nie udało się utworzyć pokoju'), translateError(error), true);
    } finally {
        elements.createRoom.disabled = false;
    }
}

async function joinRoom(roomId) {
    showView('joining');
    setStatus('busy', t('Łączenie'));
    setPhase('joining');
    clearGuestJoinRetry();
    elements.joiningTitle.textContent = t('Łączenie…');
    elements.joiningMessage.textContent = t('Przygotowujemy bezpieczny kanał.');
    clientLog('info', 'room.join_started');

    if (!window.isSecureContext || !window.crypto?.subtle) {
        closeSession(
            t('Ta strona nie ma bezpiecznego kontekstu'),
            t('Szyfrowanie w przeglądarce wymaga otwarcia strony przez HTTPS.'),
            false
        );
        return;
    }

    try {
        state.roomId = roomId;
        state.role = 'guest';
        state.resumeToken = randomResumeToken();
        state.localKeys = await generateEphemeralKeyPair();
        state.guestPublicKey = state.localKeys.publicKey;
        await connectSocket();
        sendGuestJoinRequest();
    } catch (error) {
        clientLog('error', 'room.join_failed', { error: error.message });
        closeSession(t('Nie udało się wejść do pokoju'), translateError(error), true);
    }
}

async function handleServerMessage(rawMessage) {
    let message;
    try {
        if (typeof rawMessage !== 'string' || rawMessage.length > 70_000) {
            throw new Error('Nieprawidłowa odpowiedź serwera.');
        }
        message = JSON.parse(rawMessage);
        clientLog('debug', 'protocol.inbound', {
            type: message?.type ?? null,
            bytes: new Blob([rawMessage]).size
        });
    } catch {
        clientLog('error', 'protocol.invalid_server_message');
        closeSession(t('Błąd protokołu'), t('Serwer wysłał nieprawidłową odpowiedź.'), true);
        return;
    }

    try {
        switch (message.type) {
            case 'created':
                handleRoomCreated();
                break;
            case 'resumed':
                handleRoomResumed(message);
                break;
            case 'pong':
                break;
            case 'peer_joined':
                await handlePeerJoined(message);
                break;
            case 'joined':
                await handleJoined(message);
                break;
            case 'relay':
                await handleEncryptedPayload(message.payload);
                break;
            case 'peer_away':
                handlePeerAway();
                break;
            case 'peer_returned':
                handlePeerReturned();
                break;
            case 'force_close':
                closeSession(
                    t('Druga osoba opuściła rozmowę'),
                    t('Pokój został natychmiast zniszczony i nie można do niego wrócić.'),
                    true
                );
                break;
            case 'error':
                handleProtocolError(message);
                break;
            default:
                throw new Error('Nieznany typ odpowiedzi serwera.');
        }
    } catch (error) {
        clientLog('error', 'protocol.handler_failed', {
            type: message?.type ?? null,
            error: error.message
        });
        closeSession(t('Błąd bezpiecznego kanału'), translateError(error), true);
    }
}

function handleRoomCreated() {
    if (state.role !== 'creator' || state.phase !== 'creating') {
        throw new Error('Nieoczekiwane potwierdzenie pokoju.');
    }

    const localRoomUrl = applicationBaseUrl();
    localRoomUrl.pathname += state.roomId;
    history.replaceState(null, '', localRoomUrl);

    const inviteUrl = invitationBaseUrl();
    inviteUrl.pathname += state.roomId;
    elements.inviteLink.value = inviteUrl.href;
    showView('invite');
    setStatus('busy', t('Oczekiwanie'));
    setPhase('waiting');
    clientLog('info', 'room.created');
}

function handleRoomResumed(message) {
    if (
        !['creator', 'guest'].includes(state.role)
        || !state.resumePending
        || !['waiting', 'reconnecting', 'paused'].includes(state.phase)
    ) {
        throw new Error('Nieoczekiwane potwierdzenie wznowienia pokoju.');
    }
    clearResumeState();
    if (message.roomState === 'waiting' && state.role === 'creator') {
        setPhase('waiting');
        showView('invite');
        setStatus('busy', t('Oczekiwanie'));
    } else if (message.roomState === 'active' && message.peerPresent === true) {
        restoreActiveChat();
    } else if (message.roomState === 'active' && message.peerPresent === false) {
        pauseActiveChat(
            'paused',
            t('Połączenie wznowione. Czekamy do 2 minut na drugą osobę.')
        );
    } else {
        throw new Error('Nieprawidłowy stan wznowionego pokoju.');
    }
    clientLog('info', 'room.resumed');
}

function handlePeerAway() {
    if (!state.channel || !['active', 'paused'].includes(state.phase)) {
        throw new Error('Nieoczekiwana informacja o rozłączeniu drugiej osoby.');
    }
    pauseActiveChat(
        'paused',
        t('Druga osoba zmieniła aplikację lub straciła połączenie. Czekamy do 2 minut.')
    );
    clientLog('info', 'room.peer_temporarily_away');
}

function handlePeerReturned() {
    if (!state.channel || state.phase !== 'paused') {
        throw new Error('Nieoczekiwana informacja o powrocie drugiej osoby.');
    }
    restoreActiveChat();
    clientLog('info', 'room.peer_returned');
}

async function handlePeerJoined(message) {
    if (
        state.role !== 'creator'
        || state.phase !== 'waiting'
        || !PUBLIC_KEY_PATTERN.test(message.publicKey ?? '')
    ) {
        throw new Error('Nieprawidłowe dane drugiego uczestnika.');
    }

    state.guestPublicKey = message.publicKey;
    clearResumeState();
    state.channel = await deriveSessionKeys({
        privateKey: state.localKeys.privateKey,
        peerPublicKey: state.guestPublicKey,
        creatorPublicKey: state.creatorPublicKey,
        guestPublicKey: state.guestPublicKey,
        roomId: state.roomId,
        role: state.role
    });
    setPhase('handshake');
    clientLog('info', 'room.peer_joined');
    startHandshakeTimer();
}

async function handleJoined(message) {
    if (
        state.role !== 'guest'
        || state.phase !== 'joining'
        || !state.localKeys
        || state.channel
        || !PUBLIC_KEY_PATTERN.test(message.publicKey ?? '')
    ) {
        throw new Error('Nieoczekiwane potwierdzenie dołączenia.');
    }
    const committedRoomId = await roomIdFromPublicKey(message.publicKey);
    if (committedRoomId !== state.roomId) {
        throw new Error('Klucz publiczny twórcy nie pasuje do identyfikatora zaproszenia.');
    }

    state.creatorPublicKey = message.publicKey;
    state.channel = await deriveSessionKeys({
        privateKey: state.localKeys.privateKey,
        peerPublicKey: state.creatorPublicKey,
        creatorPublicKey: state.creatorPublicKey,
        guestPublicKey: state.guestPublicKey,
        roomId: state.roomId,
        role: state.role
    });
    clearGuestJoinRetry();
    setPhase('handshake');
    clientLog('info', 'room.join_accepted');
    startHandshakeTimer();
    await relayEncrypted('key_confirm', { proof: 'safechat-v1' });
}

async function handleEncryptedPayload(payload) {
    if (
        !state.channel
        || !['handshake', 'active', 'paused', 'reconnecting'].includes(state.phase)
    ) {
        throw new Error('Odebrano dane przed utworzeniem klucza.');
    }

    const decoded = await state.channel.decrypt(payload);

    if (decoded.kind === 'key_confirm' && state.role === 'creator' && state.phase === 'handshake') {
        if (decoded.proof !== 'safechat-v1') {
            throw new Error('Nie udało się potwierdzić klucza.');
        }
        await relayEncrypted('key_ack', { proof: 'safechat-v1' });
        activateChat();
        return;
    }

    if (decoded.kind === 'key_ack' && state.role === 'guest' && state.phase === 'handshake') {
        if (decoded.proof !== 'safechat-v1') {
            throw new Error('Nie udało się potwierdzić klucza.');
        }
        activateChat();
        return;
    }

    if (
        decoded.kind === 'message'
        && ['active', 'paused', 'reconnecting'].includes(state.phase)
    ) {
        if (typeof decoded.text !== 'string' || decoded.text.length > MAX_MESSAGE_LENGTH) {
            throw new Error('Odrzucono nieprawidłową wiadomość.');
        }
        appendMessage(decoded.text, false, decoded.sentAt);
        return;
    }

    throw new Error('Odrzucono wiadomość niezgodną ze stanem sesji.');
}

async function relayEncrypted(kind, data) {
    const payload = await state.channel.encrypt(kind, data);
    sendToServer({ type: 'relay', payload });
}

function activateChat() {
    clearTimeout(state.handshakeTimer);
    state.handshakeTimer = null;
    // Prywatny klucz nie jest już potrzebny po ECDH; zwalniamy referencję.
    state.localKeys = null;
    restoreActiveChat();
    clientLog('info', 'crypto.channel_active', {
        verificationCodeAvailable: Boolean(state.channel.verificationCode)
    });
}

function restoreActiveChat() {
    setPhase('active');
    elements.peerLabel.textContent = t(
        'Kod bezpieczeństwa: {code} · porównaj innym kanałem',
        { code: state.channel.verificationCode }
    );
    showView('chat');
    setStatus('online', t('Szyfrowany'));
    elements.input.disabled = false;
    elements.sendButton.disabled = false;
    elements.input.focus();
    scrollToNewestMessage('auto');
}

function pauseActiveChat(phase, message) {
    setPhase(phase);
    showView('chat');
    setStatus('busy', t(phase === 'reconnecting' ? 'Wznawianie' : 'Druga osoba jest offline'));
    elements.peerLabel.textContent = message;
    elements.input.disabled = true;
    elements.sendButton.disabled = true;
}

function startHandshakeTimer() {
    clearTimeout(state.handshakeTimer);
    state.handshakeTimer = setTimeout(() => {
        closeSession(
            t('Nie udało się potwierdzić kluczy'),
            t('Druga strona nie ukończyła negocjacji bezpiecznego kanału.'),
            true
        );
    }, HANDSHAKE_TIMEOUT_MS);
}

function handleProtocolError(message) {
    if (
        message.code === 'creator_away'
        && state.role === 'guest'
        && state.phase === 'joining'
        && state.localKeys
        && state.guestPublicKey
    ) {
        clearTimeout(state.handshakeTimer);
        state.handshakeTimer = null;
        state.guestJoinPending = false;
        clientLog('info', 'room.creator_away_retry_scheduled');
        scheduleGuestJoinRetry();
        return;
    }

    const errors = {
        room_not_found: ['Pokój nie istnieje', 'Zaproszenie wygasło albo rozmowa już się zakończyła.'],
        creator_away: ['Twórca chwilowo niedostępny', 'Wróć do zaproszenia za moment. Twórca pokoju może właśnie wracać do przeglądarki.'],
        resume_denied: ['Rozmowa wygasła', 'Nie udało się bezpiecznie wznowić połączenia w ciągu 2 minut.'],
        room_locked: ['Pokój jest już zajęty', 'Pierwszy gość zatrzasnął pokój. To zaproszenie nie może być użyte ponownie.'],
        room_exists: ['Nie udało się utworzyć pokoju', 'Wystąpiła kolizja identyfikatora. Spróbuj ponownie.'],
        invalid_request: ['Nieprawidłowe żądanie', 'Serwer odrzucił dane połączenia.'],
        rate_limited: ['Zbyt wiele wiadomości', 'Serwer zakończył połączenie z powodu przekroczenia limitu.'],
        server_error: ['Błąd serwera', 'Pokój został zamknięty bez zachowania danych.']
    };
    const [titleSource, descriptionSource] = errors[message.code] ?? ['Połączenie odrzucone', 'Nie udało się kontynuować rozmowy.'];
    clientLog('warn', 'protocol.server_error', { code: message.code ?? 'unknown' });
    closeSession(t(titleSource), t(descriptionSource), true);
}

function scrollToNewestMessage(behavior = 'smooth') {
    requestAnimationFrame(() => {
        elements.messages.scrollTo({
            top: elements.messages.scrollHeight,
            behavior
        });
    });
}

function appendMessage(text, mine, timestamp = Date.now()) {
    const article = document.createElement('article');
    article.className = `message message--${mine ? 'mine' : 'theirs'}`;
    article.textContent = text;

    const time = document.createElement('time');
    const safeTimestamp = Number.isFinite(timestamp) ? timestamp : Date.now();
    time.dateTime = new Date(safeTimestamp).toISOString();
    time.textContent = new Intl.DateTimeFormat(language, {
        hour: '2-digit',
        minute: '2-digit'
    }).format(safeTimestamp);
    article.append(time);
    elements.messages.append(article);
    scrollToNewestMessage();
}

function closeSession(title, message, notifyServer) {
    if (state.phase === 'closed') {
        return;
    }

    clearTimeout(state.handshakeTimer);
    state.handshakeTimer = null;
    clearResumeState(true);
    clearGuestJoinRetry();
    clientLog('info', 'session.closing', { title, notifyServer });
    setPhase('closed');

    if (notifyServer && state.socket?.readyState === WebSocket.OPEN) {
        try {
            sendToServer({ type: 'leave' });
        } catch {
            // Zamknięcie gniazda i tak unieważnia pokój po stronie serwera.
        }
    }

    state.intentionalClose = true;
    state.socket?.close(1000, 'session ended');
    state.channel?.destroy();
    state.channel = null;
    state.localKeys = null;
    state.creatorPublicKey = '';
    state.guestPublicKey = '';
    state.roomId = '';

    elements.input.value = '';
    elements.messages.replaceChildren();
    elements.closedTitle.textContent = title;
    elements.closedMessage.textContent = message;
    showView('closed');
    setStatus('error', t('Zamknięty'));
    history.replaceState(null, '', applicationBaseUrl());
}

async function sendMessage(event) {
    event.preventDefault();
    const text = elements.input.value.trim();
    if (!text || state.phase !== 'active') {
        return;
    }
    if (text.length > MAX_MESSAGE_LENGTH) {
        return;
    }

    elements.input.value = '';
    resizeComposer();
    try {
        await relayEncrypted('message', { text });
        clientLog('debug', 'message.sent', { characters: text.length });
        appendMessage(text, true);
        elements.input.focus({ preventScroll: true });
    } catch (error) {
        clientLog('error', 'message.send_failed', { error: error.message });
        closeSession(t('Nie udało się wysłać wiadomości'), translateError(error), true);
    }
}

function resizeComposer() {
    elements.input.style.height = 'auto';
    elements.input.style.height = `${Math.min(elements.input.scrollHeight, 120)}px`;
    scrollToNewestMessage('auto');
}

function updateViewportHeight() {
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    document.documentElement.style.setProperty('--app-height', `${Math.round(viewportHeight)}px`);
    if (state.phase === 'active') {
        scrollToNewestMessage('auto');
    }
}

elements.createRoom.addEventListener('click', () => void createRoom());
elements.copyLink.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(elements.inviteLink.value);
        elements.copyLink.textContent = t('Skopiowano');
        setTimeout(() => { elements.copyLink.textContent = t('Kopiuj'); }, 1800);
    } catch {
        elements.inviteLink.select();
        document.execCommand('copy');
    }
});
elements.cancelRoom.addEventListener('click', () => {
    closeSession(t('Pokój anulowany'), t('Zaproszenie zostało unieważnione.'), true);
});
elements.endChat.addEventListener('click', () => {
    closeSession(
        t('Rozmowa zakończona'),
        t('Pokój został zniszczony, a klucze zwolniono z pamięci tej karty.'),
        true
    );
});
elements.form.addEventListener('submit', (event) => void sendMessage(event));
elements.input.addEventListener('input', resizeComposer);
elements.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        elements.form.requestSubmit();
    }
});
window.visualViewport?.addEventListener('resize', updateViewportHeight);
window.visualViewport?.addEventListener('scroll', updateViewportHeight);
window.addEventListener('resize', updateViewportHeight);
window.addEventListener('pagehide', () => {
    void releaseWakeLock();
});
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && sessionNeedsWakeLock()) {
        void requestWakeLock();
    }
    if (
        document.visibilityState === 'visible'
        && sessionCanResume()
        && state.socket?.readyState !== WebSocket.OPEN
    ) {
        scheduleSessionResume();
    }
});

const roomId = getRoomIdFromPath();
updateViewportHeight();
clientLog('info', 'app.initialized', {
    secureContext: window.isSecureContext,
    route: roomId ? 'invite' : 'home',
    websocketEndpoint: window.SAFECHAT_CONFIG?.websocketUrl ?? null
});
if (roomId) {
    if (location.hash) {
        history.replaceState(null, '', `${location.pathname}${location.search}`);
    }
    void joinRoom(roomId);
} else {
    showView('welcome');
}
