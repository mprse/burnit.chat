import test from 'node:test';
import assert from 'node:assert/strict';

import {
    deriveSessionKeys,
    generateEphemeralKeyPair,
    roomIdFromPublicKey
} from '../assets/crypto.js';

test('obie strony wyprowadzają zgodne, kierunkowe klucze', async () => {
    const creator = await generateEphemeralKeyPair();
    const roomId = await roomIdFromPublicKey(creator.publicKey);
    const guest = await generateEphemeralKeyPair();

    const creatorChannel = await deriveSessionKeys({
        privateKey: creator.privateKey,
        peerPublicKey: guest.publicKey,
        creatorPublicKey: creator.publicKey,
        guestPublicKey: guest.publicKey,
        roomId,
        role: 'creator'
    });
    const guestChannel = await deriveSessionKeys({
        privateKey: guest.privateKey,
        peerPublicKey: creator.publicKey,
        creatorPublicKey: creator.publicKey,
        guestPublicKey: guest.publicKey,
        roomId,
        role: 'guest'
    });
    assert.equal(creatorChannel.verificationCode, guestChannel.verificationCode);
    assert.match(creatorChannel.verificationCode, /^\d{3} \d{3} \d{3}$/u);

    const creatorPayload = await creatorChannel.encrypt('message', { text: 'cześć' });
    const decodedCreatorPayload = await guestChannel.decrypt(creatorPayload);
    assert.equal(decodedCreatorPayload.kind, 'message');
    assert.equal(decodedCreatorPayload.seq, 1);
    assert.equal(typeof decodedCreatorPayload.sentAt, 'number');
    assert.equal(decodedCreatorPayload.text, 'cześć');

    const guestPayload = await guestChannel.encrypt('message', { text: 'hej' });
    assert.equal((await creatorChannel.decrypt(guestPayload)).text, 'hej');
});

test('powtórzona zaszyfrowana ramka jest odrzucana', async () => {
    const creator = await generateEphemeralKeyPair();
    const roomId = await roomIdFromPublicKey(creator.publicKey);
    const guest = await generateEphemeralKeyPair();
    const creatorChannel = await deriveSessionKeys({
        privateKey: creator.privateKey,
        peerPublicKey: guest.publicKey,
        creatorPublicKey: creator.publicKey,
        guestPublicKey: guest.publicKey,
        roomId,
        role: 'creator'
    });
    const guestChannel = await deriveSessionKeys({
        privateKey: guest.privateKey,
        peerPublicKey: creator.publicKey,
        creatorPublicKey: creator.publicKey,
        guestPublicKey: guest.publicKey,
        roomId,
        role: 'guest'
    });

    const payload = await creatorChannel.encrypt('message', { text: 'tylko raz' });
    await guestChannel.decrypt(payload);
    await assert.rejects(() => guestChannel.decrypt(payload), /powtórzoną|nieuporządkowaną/u);
});

test('klucza z innego pokoju nie można użyć do odszyfrowania', async () => {
    const creator = await generateEphemeralKeyPair();
    const guest = await generateEphemeralKeyPair();
    const otherCreator = await generateEphemeralKeyPair();
    const firstRoom = await roomIdFromPublicKey(creator.publicKey);
    const otherRoom = await roomIdFromPublicKey(otherCreator.publicKey);
    const sender = await deriveSessionKeys({
        privateKey: creator.privateKey,
        peerPublicKey: guest.publicKey,
        creatorPublicKey: creator.publicKey,
        guestPublicKey: guest.publicKey,
        roomId: firstRoom,
        role: 'creator'
    });
    const wrongReceiver = await deriveSessionKeys({
        privateKey: guest.privateKey,
        peerPublicKey: creator.publicKey,
        creatorPublicKey: creator.publicKey,
        guestPublicKey: guest.publicKey,
        roomId: otherRoom,
        role: 'guest'
    });

    const payload = await sender.encrypt('message', { text: 'sekret' });
    await assert.rejects(() => wrongReceiver.decrypt(payload));
});

test('przerwa transportu nie zmienia kluczy ani liczników kanału', async () => {
    const creator = await generateEphemeralKeyPair();
    const roomId = await roomIdFromPublicKey(creator.publicKey);
    const guest = await generateEphemeralKeyPair();
    const creatorChannel = await deriveSessionKeys({
        privateKey: creator.privateKey,
        peerPublicKey: guest.publicKey,
        creatorPublicKey: creator.publicKey,
        guestPublicKey: guest.publicKey,
        roomId,
        role: 'creator'
    });
    const guestChannel = await deriveSessionKeys({
        privateKey: guest.privateKey,
        peerPublicKey: creator.publicKey,
        creatorPublicKey: creator.publicKey,
        guestPublicKey: guest.publicKey,
        roomId,
        role: 'guest'
    });

    const beforePause = await creatorChannel.encrypt('message', { text: 'przed' });
    assert.equal((await guestChannel.decrypt(beforePause)).seq, 1);

    // Reconnect wymienia wyłącznie transport WebSocket. SecureChannel pozostaje ten sam.
    const afterResume = await creatorChannel.encrypt('message', { text: 'po' });
    const decoded = await guestChannel.decrypt(afterResume);
    assert.equal(decoded.seq, 2);
    assert.equal(decoded.text, 'po');
});

test('Room ID jest deterministycznym 128-bitowym zobowiązaniem do Public A', async () => {
    const creator = await generateEphemeralKeyPair();
    const otherCreator = await generateEphemeralKeyPair();

    const roomId = await roomIdFromPublicKey(creator.publicKey);
    assert.match(roomId, /^[A-Za-z0-9_-]{22}$/u);
    assert.equal(await roomIdFromPublicKey(creator.publicKey), roomId);
    assert.notEqual(await roomIdFromPublicKey(otherCreator.publicKey), roomId);
});
