const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function bytesToBase64Url(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function base64UrlToBytes(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) {
        throw new Error('Nieprawidłowe kodowanie base64url.');
    }

    const padding = '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + padding);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function importPublicKey(encodedKey) {
    const raw = base64UrlToBytes(encodedKey);
    if (raw.byteLength !== 65 || raw[0] !== 0x04) {
        throw new Error('Nieprawidłowy klucz publiczny P-256.');
    }

    return crypto.subtle.importKey(
        'raw',
        raw,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        []
    );
}

async function deriveAesKey(hkdfKey, salt, info) {
    return crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt,
            info: encoder.encode(info)
        },
        hkdfKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

function concatenateBytes(...parts) {
    const byteParts = parts.map((part) => new Uint8Array(part));
    const result = new Uint8Array(byteParts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    for (const part of byteParts) {
        result.set(part, offset);
        offset += part.byteLength;
    }
    return result;
}

export async function generateEphemeralKeyPair() {
    const keyPair = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveBits']
    );
    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));

    return {
        privateKey: keyPair.privateKey,
        publicKey: bytesToBase64Url(publicKey)
    };
}

export async function roomIdFromPublicKey(encodedKey) {
    const raw = base64UrlToBytes(encodedKey);
    if (raw.byteLength !== 65 || raw[0] !== 0x04) {
        throw new Error('Nieprawidłowy klucz publiczny P-256.');
    }

    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
    return bytesToBase64Url(digest.subarray(0, 16));
}

export async function deriveSessionKeys({
    privateKey,
    peerPublicKey,
    creatorPublicKey,
    guestPublicKey,
    roomId,
    role
}) {
    const importedPeerKey = await importPublicKey(peerPublicKey);
    const sharedSecret = await crypto.subtle.deriveBits(
        { name: 'ECDH', public: importedPeerKey },
        privateKey,
        256
    );
    const hkdfKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
    const saltMaterial = encoder.encode(
        `safechat:v1:${roomId}:${creatorPublicKey}:${guestPublicKey}`
    );
    const salt = await crypto.subtle.digest('SHA-256', saltMaterial);
    const creatorToGuest = await deriveAesKey(hkdfKey, salt, 'safechat:v1:creator-to-guest');
    const guestToCreator = await deriveAesKey(hkdfKey, salt, 'safechat:v1:guest-to-creator');
    const verificationDigest = new Uint8Array(await crypto.subtle.digest(
        'SHA-256',
        concatenateBytes(sharedSecret, salt)
    ));
    const verificationNumber = new DataView(
        verificationDigest.buffer,
        verificationDigest.byteOffset,
        4
    ).getUint32(0) % 1_000_000_000;
    const verificationCode = verificationNumber
        .toString()
        .padStart(9, '0')
        .match(/.{3}/gu)
        .join(' ');

    return role === 'creator'
        ? new SecureChannel(creatorToGuest, guestToCreator, roomId, 'creator', 'guest', verificationCode)
        : new SecureChannel(guestToCreator, creatorToGuest, roomId, 'guest', 'creator', verificationCode);
}

export class SecureChannel {
    #sendKey;
    #receiveKey;
    #roomId;
    #localRole;
    #peerRole;
    #sendSequence = 0;
    #receiveSequence = 0;

    constructor(sendKey, receiveKey, roomId, localRole, peerRole, verificationCode) {
        this.#sendKey = sendKey;
        this.#receiveKey = receiveKey;
        this.#roomId = roomId;
        this.#localRole = localRole;
        this.#peerRole = peerRole;
        this.verificationCode = verificationCode;
    }

    async encrypt(kind, data = {}) {
        if (!this.#sendKey) {
            throw new Error('Kanał kryptograficzny został zamknięty.');
        }

        const iv = crypto.getRandomValues(new Uint8Array(12));
        const payload = encoder.encode(JSON.stringify({
            kind,
            seq: ++this.#sendSequence,
            sentAt: Date.now(),
            ...data
        }));
        const ciphertext = await crypto.subtle.encrypt(
            {
                name: 'AES-GCM',
                iv,
                additionalData: this.#aad(this.#localRole),
                tagLength: 128
            },
            this.#sendKey,
            payload
        );

        return {
            v: 1,
            iv: bytesToBase64Url(iv),
            ciphertext: bytesToBase64Url(new Uint8Array(ciphertext))
        };
    }

    async decrypt(envelope) {
        if (!this.#receiveKey) {
            throw new Error('Kanał kryptograficzny został zamknięty.');
        }
        if (!envelope || envelope.v !== 1) {
            throw new Error('Nieobsługiwana wersja zaszyfrowanej wiadomości.');
        }

        const iv = base64UrlToBytes(envelope.iv);
        const ciphertext = base64UrlToBytes(envelope.ciphertext);
        if (iv.byteLength !== 12 || ciphertext.byteLength < 16 || ciphertext.byteLength > 64 * 1024) {
            throw new Error('Nieprawidłowa zaszyfrowana wiadomość.');
        }

        const plaintext = await crypto.subtle.decrypt(
            {
                name: 'AES-GCM',
                iv,
                additionalData: this.#aad(this.#peerRole),
                tagLength: 128
            },
            this.#receiveKey,
            ciphertext
        );
        const decoded = JSON.parse(decoder.decode(plaintext));

        if (!Number.isSafeInteger(decoded.seq) || decoded.seq !== this.#receiveSequence + 1) {
            throw new Error('Odrzucono powtórzoną lub nieuporządkowaną wiadomość.');
        }
        this.#receiveSequence = decoded.seq;

        return decoded;
    }

    destroy() {
        this.#sendKey = null;
        this.#receiveKey = null;
        this.#roomId = '';
        this.#sendSequence = 0;
        this.#receiveSequence = 0;
        this.verificationCode = '';
    }

    #aad(senderRole) {
        return encoder.encode(`safechat:v1:${this.#roomId}:${senderRole}`);
    }
}
