# Security model

For a detailed walkthrough of key generation, the handshake, and encryption,
see [key-exchange.md](key-exchange.md).

## Protected data

- Private ECDH keys and AES keys are never exported or transmitted.
- Messages leave the browser only after AES-256-GCM encryption.
- The two transmission directions use separate HKDF-derived keys.
- `Room ID` is a 128-bit commitment,
  `Trunc128(SHA-256(Public A))`; the guest verifies the key received from the
  worker before performing ECDH.
- AAD binds the envelope to the protocol version, room, and sender's role.
- An increasing sequence number rejects replay and reordering.
- MySQL stores only `id`, `status`, and `created_at`.
- Explicitly ending the conversation or exceeding the 2-minute reconnection
  window deletes the record, sends `force_close`, and closes the peer's socket.
- The creator and guest have separate 256-bit resume tokens stored only in
  memory; the worker stores only their SHA-256 hashes.

## Metadata visible to the server

The relay knows IP addresses, the room ID, frame timing and size, room status,
and both public keys. It does not know message contents, private keys, or AES
keys. TLS alone does not hide this metadata from the relay operator.

## Limitations

1. **Invitation theft before use.** `Room ID` is sufficient to join and acts
   as a single-use bearer invitation. Anyone with the link can try to become
   the first guest and derive a key with their own ECDH key pair as a valid
   participant. The claim that stealing a link can never allow someone to read
   messages cannot be met without a second secret or identity approval.

2. **Actively malicious relay.** `Room ID` pins `Public A`: the guest rejects
   a key whose hash does not match the link. However, the creator has no
   previously pinned `Public B`, so a malicious relay can try to impersonate
   the guest to the creator. Comparing the nine-digit security code through
   another channel detects this substitution.

3. **Malicious frontend or device.** XSS, modified JavaScript files, browser
   extensions, malware, the clipboard, and screenshots are outside the
   protection provided by E2EE. Static files must be delivered over trusted
   HTTPS.

4. **Browser memory.** The code removes references to `CryptoKey`, but
   JavaScript cannot guarantee immediate physical memory zeroing by the
   garbage collector. The application does not use localStorage,
   sessionStorage, IndexedDB, or a Service Worker.

5. **No forward secrecy within a session.** One ECDH key pair serves the
   entire short conversation. The project does not implement Double Ratchet
   or per-message key rotation.

## Hardening for high-risk use

To prevent access using a stolen link alone, add a separate random secret
shared through a second channel, or require the creator to approve the guest
manually. For long conversations, the appropriate next step is a protocol
review and a proven X3DH/Double Ratchet implementation rather than designing
an original protocol.
