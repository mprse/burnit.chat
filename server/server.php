<?php

declare(strict_types=1);

final class WebSocketProtocolException extends RuntimeException
{
}

final class SafeChatServer
{
    private const ROOM_ID_PATTERN = '/\A[A-Za-z0-9_-]{22}\z/D';
    private const PUBLIC_KEY_PATTERN = '/\A[A-Za-z0-9_-]{87}\z/D';
    private const HANDSHAKE_MAX_BYTES = 8192;
    private const MAX_OUTPUT_BUFFER_BYTES = 262144;
    private const LOG_PRIORITIES = [
        'debug' => 10,
        'info' => 20,
        'warning' => 30,
        'error' => 40,
        'off' => 100,
    ];

    /** @var array<int, array<string, mixed>> */
    private array $clients = [];

    /** @var array<string, array{creator: int, guest: ?int, createdAt: int}> */
    private array $rooms = [];

    /** @var resource|null */
    private $serverSocket = null;

    private PDO $database;
    private int $lastCleanupAt;
    private string $logFilePath = '';

    /** @param array<string, mixed> $config */
    public function __construct(private readonly array $config)
    {
        $this->initializeLogging();
        $this->log('info', 'runtime.starting', [
            'phpVersion' => PHP_VERSION,
            'pid' => getmypid(),
        ]);

        $this->database = new PDO(
            $config['db_dsn'],
            $config['db_user'],
            $config['db_password'],
            [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => false,
            ]
        );
        $this->log('info', 'database.connected', [
            'driver' => $this->database->getAttribute(PDO::ATTR_DRIVER_NAME),
        ]);

        $lockResult = $this->database->query(
            "SELECT GET_LOCK('safechat_ws_server_singleton', 0)"
        )->fetchColumn();
        if ((int) $lockResult !== 1) {
            $this->log('error', 'database.singleton_lock_rejected');
            throw new RuntimeException('Inna instancja serwera SafeChat już korzysta z tej bazy.');
        }
        $this->log('debug', 'database.singleton_lock_acquired');

        // Po restarcie procesu nie istnieją żadne odpowiadające rekordom gniazda.
        $purgedRows = $this->database->exec('DELETE FROM rooms');
        $this->log('info', 'database.orphaned_rooms_purged', ['rows' => $purgedRows]);
        $this->lastCleanupAt = time();
    }

    public function run(): void
    {
        $address = sprintf(
            'tcp://%s:%d',
            $this->config['listen_host'],
            $this->config['listen_port']
        );
        $errorCode = 0;
        $errorMessage = '';
        $this->serverSocket = @stream_socket_server(
            $address,
            $errorCode,
            $errorMessage,
            STREAM_SERVER_BIND | STREAM_SERVER_LISTEN
        );
        if ($this->serverSocket === false) {
            throw new RuntimeException(
                sprintf('Nie można uruchomić serwera na %s: %s (%d)', $address, $errorMessage, $errorCode)
            );
        }
        stream_set_blocking($this->serverSocket, false);

        $this->log('info', 'server.listening', [
            'address' => $address,
            'path' => $this->config['websocket_path'],
            'allowedOrigins' => $this->config['allowed_origins'],
            'waitingTtlSeconds' => $this->config['waiting_ttl_seconds'],
        ]);

        while (true) {
            $read = [$this->serverSocket];
            $write = [];

            foreach ($this->clients as $client) {
                $read[] = $client['socket'];
                if ($client['output'] !== '') {
                    $write[] = $client['socket'];
                }
            }

            $except = null;
            $selected = @stream_select($read, $write, $except, 1);
            if ($selected === false) {
                $this->log('warning', 'server.select_failed');
                continue;
            }

            foreach ($read as $socket) {
                if ($socket === $this->serverSocket) {
                    $this->acceptClient();
                    continue;
                }

                $clientId = (int) $socket;
                if (isset($this->clients[$clientId])) {
                    $this->readClient($clientId);
                }
            }

            foreach ($write as $socket) {
                $clientId = (int) $socket;
                if (isset($this->clients[$clientId])) {
                    $this->flushClient($clientId);
                }
            }

            $this->enforceTimeouts();
            if (time() - $this->lastCleanupAt >= 60) {
                $this->cleanupStaleRooms();
                $this->lastCleanupAt = time();
            }
        }
    }

    private function acceptClient(): void
    {
        $peerName = '';
        $socket = @stream_socket_accept($this->serverSocket, 0, $peerName);
        if ($socket === false) {
            return;
        }

        stream_set_blocking($socket, false);
        $clientId = (int) $socket;
        $this->clients[$clientId] = [
            'socket' => $socket,
            'peer' => $peerName,
            'input' => '',
            'output' => '',
            'handshaken' => false,
            'roomId' => null,
            'role' => null,
            'peerId' => null,
            'connectedAt' => time(),
            'rateWindowAt' => microtime(true),
            'rateCount' => 0,
            'closeAfterWrite' => false,
            'traceId' => bin2hex(random_bytes(4)),
        ];
        $this->log('info', 'client.accepted', [
            'connection' => $this->clients[$clientId]['traceId'],
            'activeConnections' => count($this->clients),
        ]);
    }

    private function readClient(int $clientId): void
    {
        $chunk = @fread($this->clients[$clientId]['socket'], 8192);
        if ($chunk === false || ($chunk === '' && feof($this->clients[$clientId]['socket']))) {
            $this->disconnectClient($clientId, true, 'socket_eof');
            return;
        }
        if ($chunk === '') {
            return;
        }

        $this->clients[$clientId]['input'] .= $chunk;
        $this->log('debug', 'socket.bytes_received', [
            ...$this->clientContext($clientId),
            'bytes' => strlen($chunk),
        ]);

        try {
            if (!$this->clients[$clientId]['handshaken']) {
                $this->performHandshake($clientId);
                if (!isset($this->clients[$clientId]) || !$this->clients[$clientId]['handshaken']) {
                    return;
                }
            }

            foreach ($this->decodeFrames($this->clients[$clientId]['input']) as $frame) {
                $this->handleFrame($clientId, $frame['opcode'], $frame['payload']);
                if (!isset($this->clients[$clientId])) {
                    break;
                }
            }
        } catch (WebSocketProtocolException $exception) {
            $this->log('warning', 'protocol.websocket_violation', [
                ...$this->clientContext($clientId),
                'error' => $exception->getMessage(),
            ]);
            $this->queueClose($clientId, 1002, $exception->getMessage());
        } catch (Throwable $exception) {
            $this->log('error', 'client.handler_failed', [
                ...$this->clientContext($clientId),
                'exception' => $exception::class,
                'error' => $exception->getMessage(),
            ]);
            $this->sendError($clientId, 'server_error', true);
        }
    }

    private function performHandshake(int $clientId): void
    {
        $buffer = $this->clients[$clientId]['input'];
        $headerEnd = strpos($buffer, "\r\n\r\n");
        if ($headerEnd === false) {
            if (strlen($buffer) > self::HANDSHAKE_MAX_BYTES) {
                $this->log('warning', 'handshake.headers_too_large', $this->clientContext($clientId));
                $this->dropClient($clientId);
            }
            return;
        }

        $rawHeaders = substr($buffer, 0, $headerEnd + 4);
        $this->clients[$clientId]['input'] = substr($buffer, $headerEnd + 4);
        $lines = explode("\r\n", trim($rawHeaders));
        $requestLine = array_shift($lines);

        if (!is_string($requestLine) || !preg_match('/\AGET\s+(\S+)\s+HTTP\/1\.[01]\z/', $requestLine, $match)) {
            $this->log('warning', 'handshake.invalid_request_line', $this->clientContext($clientId));
            $this->rejectHttpClient($clientId, 400, 'Bad Request');
            return;
        }

        $path = parse_url($match[1], PHP_URL_PATH);
        if ($path !== $this->config['websocket_path']) {
            $this->log('warning', 'handshake.invalid_path', [
                ...$this->clientContext($clientId),
                'path' => $path,
            ]);
            $this->rejectHttpClient($clientId, 404, 'Not Found');
            return;
        }

        $headers = [];
        foreach ($lines as $line) {
            if (!str_contains($line, ':')) {
                continue;
            }
            [$name, $value] = explode(':', $line, 2);
            $headers[strtolower(trim($name))] = trim($value);
        }

        $upgrade = strtolower($headers['upgrade'] ?? '');
        $connection = strtolower($headers['connection'] ?? '');
        $version = $headers['sec-websocket-version'] ?? '';
        $key = $headers['sec-websocket-key'] ?? '';
        $origin = $headers['origin'] ?? '';

        if (
            $upgrade !== 'websocket'
            || !str_contains($connection, 'upgrade')
            || $version !== '13'
            || base64_decode($key, true) === false
            || strlen((string) base64_decode($key, true)) !== 16
        ) {
            $this->log('warning', 'handshake.invalid_headers', $this->clientContext($clientId));
            $this->rejectHttpClient($clientId, 400, 'Bad Request');
            return;
        }

        if (!$this->originAllowed($origin)) {
            $this->log('warning', 'handshake.origin_rejected', [
                ...$this->clientContext($clientId),
                'origin' => $origin,
            ]);
            $this->rejectHttpClient($clientId, 403, 'Forbidden');
            return;
        }

        $accept = base64_encode(sha1(
            $key . '258EAFA5-E914-47DA-95CA-C5AB0DC85B11',
            true
        ));
        $response = "HTTP/1.1 101 Switching Protocols\r\n"
            . "Upgrade: websocket\r\n"
            . "Connection: Upgrade\r\n"
            . "Sec-WebSocket-Accept: {$accept}\r\n\r\n";

        $this->clients[$clientId]['output'] .= $response;
        $this->clients[$clientId]['handshaken'] = true;
        $this->log('info', 'handshake.completed', [
            ...$this->clientContext($clientId),
            'origin' => $origin,
            'path' => $path,
        ]);
    }

    private function originAllowed(string $origin): bool
    {
        return in_array('*', $this->config['allowed_origins'], true)
            || in_array($origin, $this->config['allowed_origins'], true);
    }

    private function rejectHttpClient(int $clientId, int $status, string $reason): void
    {
        $body = $reason . "\n";
        $this->clients[$clientId]['output'] .= sprintf(
            "HTTP/1.1 %d %s\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: %d\r\n\r\n%s",
            $status,
            $reason,
            strlen($body),
            $body
        );
        $this->clients[$clientId]['closeAfterWrite'] = true;
        $this->log('debug', 'handshake.http_rejection_queued', [
            ...$this->clientContext($clientId),
            'status' => $status,
        ]);
    }

    /**
     * @return list<array{opcode: int, payload: string}>
     */
    private function decodeFrames(string &$buffer): array
    {
        $frames = [];

        while (strlen($buffer) >= 2) {
            $first = ord($buffer[0]);
            $second = ord($buffer[1]);
            $finished = ($first & 0x80) !== 0;
            $opcode = $first & 0x0f;
            $masked = ($second & 0x80) !== 0;
            $length = $second & 0x7f;
            $offset = 2;

            if (!$finished || !$masked) {
                throw new WebSocketProtocolException('Fragmentowane lub niemaskowane ramki są niedozwolone.');
            }

            if ($length === 126) {
                if (strlen($buffer) < 4) {
                    break;
                }
                $length = unpack('nlength', substr($buffer, 2, 2))['length'];
                $offset = 4;
            } elseif ($length === 127) {
                if (strlen($buffer) < 10) {
                    break;
                }
                $parts = unpack('Nhigh/Nlow', substr($buffer, 2, 8));
                if ($parts['high'] !== 0) {
                    throw new WebSocketProtocolException('Ramka jest zbyt duża.');
                }
                $length = $parts['low'];
                $offset = 10;
            }

            if ($length > $this->config['max_frame_bytes']) {
                throw new WebSocketProtocolException('Ramka przekracza dozwolony rozmiar.');
            }
            if ($opcode >= 0x08 && $length > 125) {
                throw new WebSocketProtocolException('Nieprawidłowa ramka sterująca.');
            }

            $frameBytes = $offset + 4 + $length;
            if (strlen($buffer) < $frameBytes) {
                break;
            }

            $mask = substr($buffer, $offset, 4);
            $payload = substr($buffer, $offset + 4, $length);
            $unmasked = '';
            for ($index = 0; $index < $length; $index++) {
                $unmasked .= $payload[$index] ^ $mask[$index % 4];
            }

            $frames[] = ['opcode' => $opcode, 'payload' => $unmasked];
            $buffer = substr($buffer, $frameBytes);
        }

        return $frames;
    }

    private function handleFrame(int $clientId, int $opcode, string $payload): void
    {
        $this->log('debug', 'websocket.frame_received', [
            ...$this->clientContext($clientId),
            'opcode' => $opcode,
            'bytes' => strlen($payload),
        ]);

        if ($opcode === 0x08) {
            $this->disconnectClient($clientId, true, 'client_close_frame');
            return;
        }
        if ($opcode === 0x09) {
            $this->queueFrame($clientId, $payload, 0x0a);
            return;
        }
        if ($opcode === 0x0a) {
            return;
        }
        if ($opcode !== 0x01) {
            throw new WebSocketProtocolException('Akceptowane są wyłącznie ramki tekstowe.');
        }

        if (!$this->withinRateLimit($clientId)) {
            $this->log('warning', 'protocol.rate_limit_exceeded', $this->clientContext($clientId));
            $this->sendError($clientId, 'rate_limited', true);
            return;
        }

        try {
            $message = json_decode($payload, true, 16, JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            $this->log('warning', 'protocol.invalid_json', [
                ...$this->clientContext($clientId),
                'bytes' => strlen($payload),
            ]);
            $this->sendError($clientId, 'invalid_request', true);
            return;
        }
        if (!is_array($message) || !is_string($message['type'] ?? null)) {
            $this->log('warning', 'protocol.missing_message_type', $this->clientContext($clientId));
            $this->sendError($clientId, 'invalid_request', true);
            return;
        }
        $this->log('debug', 'protocol.message_received', [
            ...$this->clientContext($clientId),
            'type' => $message['type'],
            'bytes' => strlen($payload),
        ]);

        match ($message['type']) {
            'create' => $this->createRoom($clientId, $message),
            'join' => $this->joinRoom($clientId, $message),
            'relay' => $this->relayMessage($clientId, $message),
            'leave' => $this->disconnectClient($clientId, true, 'client_leave'),
            default => $this->sendError($clientId, 'invalid_request', true),
        };
    }

    /** @param array<string, mixed> $message */
    private function createRoom(int $clientId, array $message): void
    {
        $roomId = $message['roomId'] ?? null;
        $this->log('info', 'room.create_requested', [
            ...$this->clientContext($clientId),
            'room' => is_string($roomId) ? $this->roomTag($roomId) : null,
        ]);
        if (
            $this->clients[$clientId]['roomId'] !== null
            || !is_string($roomId)
            || preg_match(self::ROOM_ID_PATTERN, $roomId) !== 1
        ) {
            $this->log('warning', 'room.create_rejected_invalid', $this->clientContext($clientId));
            $this->sendError($clientId, 'invalid_request', true);
            return;
        }

        try {
            $statement = $this->database->prepare(
                "INSERT INTO rooms (id, status) VALUES (:id, 'waiting')"
            );
            $statement->execute(['id' => $roomId]);
        } catch (PDOException $exception) {
            if ((string) $exception->getCode() === '23000') {
                $this->log('warning', 'room.create_collision', [
                    ...$this->clientContext($clientId),
                    'room' => $this->roomTag($roomId),
                ]);
                $this->sendError($clientId, 'room_exists', true);
                return;
            }
            throw $exception;
        }

        $this->clients[$clientId]['roomId'] = $roomId;
        $this->clients[$clientId]['role'] = 'creator';
        $this->rooms[$roomId] = [
            'creator' => $clientId,
            'guest' => null,
            'createdAt' => time(),
        ];
        $this->sendJson($clientId, ['type' => 'created']);
        $this->log('info', 'room.created', [
            ...$this->clientContext($clientId),
            'room' => $this->roomTag($roomId),
            'roomsInMemory' => count($this->rooms),
        ]);
    }

    /** @param array<string, mixed> $message */
    private function joinRoom(int $clientId, array $message): void
    {
        $roomId = $message['roomId'] ?? null;
        $publicKey = $message['publicKey'] ?? null;
        $this->log('info', 'room.join_requested', [
            ...$this->clientContext($clientId),
            'room' => is_string($roomId) ? $this->roomTag($roomId) : null,
        ]);
        if (
            $this->clients[$clientId]['roomId'] !== null
            || !is_string($roomId)
            || preg_match(self::ROOM_ID_PATTERN, $roomId) !== 1
            || !is_string($publicKey)
            || preg_match(self::PUBLIC_KEY_PATTERN, $publicKey) !== 1
        ) {
            $this->log('warning', 'room.join_rejected_invalid', $this->clientContext($clientId));
            $this->sendError($clientId, 'invalid_request', true);
            return;
        }

        $room = $this->rooms[$roomId] ?? null;
        if ($room === null || !isset($this->clients[$room['creator']])) {
            $this->log('warning', 'room.join_rejected_not_found', [
                ...$this->clientContext($clientId),
                'room' => $this->roomTag($roomId),
            ]);
            $this->sendError($clientId, 'room_not_found', true);
            return;
        }
        if ($room['guest'] !== null) {
            $this->log('warning', 'room.join_rejected_locked', [
                ...$this->clientContext($clientId),
                'room' => $this->roomTag($roomId),
            ]);
            $this->sendError($clientId, 'room_locked', true);
            return;
        }

        $this->database->beginTransaction();
        try {
            $select = $this->database->prepare(
                'SELECT status FROM rooms WHERE id = :id FOR UPDATE'
            );
            $select->execute(['id' => $roomId]);
            $status = $select->fetchColumn();

            if ($status === false) {
                $this->database->rollBack();
                $this->sendError($clientId, 'room_not_found', true);
                return;
            }
            if ($status !== 'waiting') {
                $this->database->rollBack();
                $this->sendError($clientId, 'room_locked', true);
                return;
            }

            $update = $this->database->prepare(
                "UPDATE rooms SET status = 'active' WHERE id = :id AND status = 'waiting'"
            );
            $update->execute(['id' => $roomId]);
            if ($update->rowCount() !== 1) {
                $this->database->rollBack();
                $this->sendError($clientId, 'room_locked', true);
                return;
            }
            $this->database->commit();
        } catch (Throwable $exception) {
            if ($this->database->inTransaction()) {
                $this->database->rollBack();
            }
            throw $exception;
        }

        $creatorId = $room['creator'];
        $this->clients[$clientId]['roomId'] = $roomId;
        $this->clients[$clientId]['role'] = 'guest';
        $this->clients[$clientId]['peerId'] = $creatorId;
        $this->clients[$creatorId]['peerId'] = $clientId;
        $this->rooms[$roomId]['guest'] = $clientId;

        // Kolejność ma znaczenie: twórca najpierw wyprowadza klucze, potem dostaje relay.
        $this->sendJson($creatorId, [
            'type' => 'peer_joined',
            'publicKey' => $publicKey,
        ]);
        $this->sendJson($clientId, ['type' => 'joined']);
        $this->log('info', 'room.locked', [
            ...$this->clientContext($clientId),
            'room' => $this->roomTag($roomId),
            'creatorConnection' => $this->clients[$creatorId]['traceId'],
        ]);
    }

    /** @param array<string, mixed> $message */
    private function relayMessage(int $clientId, array $message): void
    {
        $client = $this->clients[$clientId];
        $peerId = $client['peerId'];
        $payload = $message['payload'] ?? null;
        if (
            $client['roomId'] === null
            || !is_int($peerId)
            || !isset($this->clients[$peerId])
            || !is_array($payload)
            || array_keys($payload) !== ['v', 'iv', 'ciphertext']
            || $payload['v'] !== 1
            || !is_string($payload['iv'])
            || preg_match('/\A[A-Za-z0-9_-]{16}\z/D', $payload['iv']) !== 1
            || !is_string($payload['ciphertext'])
            || strlen($payload['ciphertext']) < 22
            || strlen($payload['ciphertext']) > 87382
            || preg_match('/\A[A-Za-z0-9_-]+\z/D', $payload['ciphertext']) !== 1
        ) {
            $this->log('warning', 'relay.rejected_invalid', $this->clientContext($clientId));
            $this->sendError($clientId, 'invalid_request', true);
            return;
        }

        $this->sendJson($peerId, [
            'type' => 'relay',
            'payload' => $payload,
        ]);
        $this->log('debug', 'relay.forwarded', [
            ...$this->clientContext($clientId),
            'peerConnection' => $this->clients[$peerId]['traceId'] ?? null,
            'ciphertextCharacters' => strlen($payload['ciphertext']),
        ]);
    }

    private function withinRateLimit(int $clientId): bool
    {
        $now = microtime(true);
        $window = $this->config['rate_limit_window_seconds'];
        if ($now - $this->clients[$clientId]['rateWindowAt'] >= $window) {
            $this->clients[$clientId]['rateWindowAt'] = $now;
            $this->clients[$clientId]['rateCount'] = 0;
        }

        $this->clients[$clientId]['rateCount']++;
        return $this->clients[$clientId]['rateCount'] <= $this->config['rate_limit_messages'];
    }

    /** @param array<string, mixed> $payload */
    private function sendJson(int $clientId, array $payload): void
    {
        $json = json_encode(
            $payload,
            JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
        );
        $this->queueFrame($clientId, $json, 0x01);
        $this->log('debug', 'protocol.message_queued', [
            ...$this->clientContext($clientId),
            'type' => $payload['type'] ?? 'unknown',
            'bytes' => strlen($json),
        ]);
    }

    private function sendError(int $clientId, string $code, bool $close): void
    {
        if (!isset($this->clients[$clientId])) {
            return;
        }
        $this->log('warning', 'protocol.error_sent', [
            ...$this->clientContext($clientId),
            'code' => $code,
            'willClose' => $close,
        ]);
        $this->sendJson($clientId, ['type' => 'error', 'code' => $code]);
        if ($close) {
            $this->clients[$clientId]['closeAfterWrite'] = true;
        }
    }

    private function queueClose(int $clientId, int $code, string $reason): void
    {
        if (!isset($this->clients[$clientId])) {
            return;
        }
        $safeReason = substr($reason, 0, 100);
        $this->log('debug', 'websocket.close_queued', [
            ...$this->clientContext($clientId),
            'code' => $code,
            'reason' => $safeReason,
        ]);
        $this->queueFrame($clientId, pack('n', $code) . $safeReason, 0x08);
        $this->clients[$clientId]['closeAfterWrite'] = true;
    }

    private function queueFrame(int $clientId, string $payload, int $opcode): void
    {
        if (!isset($this->clients[$clientId])) {
            return;
        }

        $length = strlen($payload);
        $header = chr(0x80 | $opcode);
        if ($length <= 125) {
            $header .= chr($length);
        } elseif ($length <= 65535) {
            $header .= chr(126) . pack('n', $length);
        } else {
            $header .= chr(127) . pack('NN', 0, $length);
        }
        $frame = $header . $payload;
        if (
            strlen($this->clients[$clientId]['output']) + strlen($frame)
            > self::MAX_OUTPUT_BUFFER_BYTES
        ) {
            // Wolny odbiorca nie może powodować nieograniczonego wzrostu pamięci relay.
            $this->log('warning', 'socket.output_buffer_exceeded', [
                ...$this->clientContext($clientId),
                'queuedBytes' => strlen($this->clients[$clientId]['output']),
                'nextFrameBytes' => strlen($frame),
            ]);
            $this->disconnectClient($clientId, true, 'slow_receiver');
            return;
        }
        $this->clients[$clientId]['output'] .= $frame;
    }

    private function flushClient(int $clientId): void
    {
        $output = $this->clients[$clientId]['output'];
        if ($output === '') {
            return;
        }

        $written = @fwrite($this->clients[$clientId]['socket'], $output);
        if ($written === false) {
            $this->disconnectClient($clientId, true, 'socket_write_failed');
            return;
        }
        if ($written > 0) {
            $this->clients[$clientId]['output'] = substr($output, $written);
            $this->log('debug', 'socket.bytes_sent', [
                ...$this->clientContext($clientId),
                'bytes' => $written,
                'remainingBytes' => strlen($this->clients[$clientId]['output']),
            ]);
        }

        if (
            isset($this->clients[$clientId])
            && $this->clients[$clientId]['output'] === ''
            && $this->clients[$clientId]['closeAfterWrite']
        ) {
            $this->disconnectClient($clientId, true, 'close_after_write');
        }
    }

    private function disconnectClient(
        int $clientId,
        bool $notifyPeer,
        string $reason = 'server_disconnect'
    ): void
    {
        if (!isset($this->clients[$clientId])) {
            return;
        }

        $roomId = $this->clients[$clientId]['roomId'];
        $peerId = $this->clients[$clientId]['peerId'];
        $context = $this->clientContext($clientId);
        $this->log('info', 'client.disconnecting', [
            ...$context,
            'reason' => $reason,
            'notifyPeer' => $notifyPeer,
        ]);
        $this->dropClient($clientId);

        if (!is_string($roomId)) {
            $this->log('debug', 'client.disconnected', [
                ...$context,
                'activeConnections' => count($this->clients),
            ]);
            return;
        }

        $this->deleteRoomRecord($roomId);
        unset($this->rooms[$roomId]);
        $this->log('info', 'room.destroyed', [
            ...$context,
            'room' => $this->roomTag($roomId),
            'reason' => $reason,
            'roomsInMemory' => count($this->rooms),
        ]);

        if ($notifyPeer && is_int($peerId) && isset($this->clients[$peerId])) {
            $this->clients[$peerId]['roomId'] = null;
            $this->clients[$peerId]['peerId'] = null;
            $this->sendJson($peerId, ['type' => 'force_close']);
            $this->clients[$peerId]['closeAfterWrite'] = true;
            $this->log('info', 'room.force_close_queued', [
                'room' => $this->roomTag($roomId),
                'peerConnection' => $this->clients[$peerId]['traceId'],
            ]);
        }
    }

    private function dropClient(int $clientId): void
    {
        if (!isset($this->clients[$clientId])) {
            return;
        }
        @fclose($this->clients[$clientId]['socket']);
        unset($this->clients[$clientId]);
    }

    private function deleteRoomRecord(string $roomId): void
    {
        try {
            $statement = $this->database->prepare('DELETE FROM rooms WHERE id = :id');
            $statement->execute(['id' => $roomId]);
            $this->log('debug', 'database.room_deleted', [
                'room' => $this->roomTag($roomId),
                'rows' => $statement->rowCount(),
            ]);
        } catch (Throwable $exception) {
            $this->log('error', 'database.room_delete_failed', [
                'room' => $this->roomTag($roomId),
                'exception' => $exception::class,
                'error' => $exception->getMessage(),
            ]);
        }
    }

    private function enforceTimeouts(): void
    {
        $now = time();
        foreach (array_keys($this->clients) as $clientId) {
            if (!isset($this->clients[$clientId])) {
                continue;
            }
            $client = $this->clients[$clientId];
            if (
                $client['roomId'] === null
                && $now - $client['connectedAt'] > $this->config['handshake_timeout_seconds']
            ) {
                $this->log('warning', 'client.initial_request_timeout', $this->clientContext($clientId));
                $this->queueClose($clientId, 1008, 'timeout');
            }
        }
    }

    private function cleanupStaleRooms(): void
    {
        $expiredInMemory = 0;
        $cutoff = time() - $this->config['waiting_ttl_seconds'];
        foreach ($this->rooms as $roomId => $room) {
            if ($room['guest'] === null && $room['createdAt'] < $cutoff) {
                $expiredInMemory++;
                $creatorId = $room['creator'];
                $this->deleteRoomRecord($roomId);
                unset($this->rooms[$roomId]);
                if (isset($this->clients[$creatorId])) {
                    $this->clients[$creatorId]['roomId'] = null;
                    $this->sendJson($creatorId, ['type' => 'force_close']);
                    $this->clients[$creatorId]['closeAfterWrite'] = true;
                }
            }
        }

        $statement = $this->database->prepare(
            "DELETE FROM rooms WHERE status = 'waiting' AND created_at < FROM_UNIXTIME(:cutoff)"
        );
        $statement->bindValue('cutoff', $cutoff, PDO::PARAM_INT);
        $statement->execute();
        $this->log('debug', 'cleanup.completed', [
            'expiredInMemory' => $expiredInMemory,
            'deletedDatabaseRows' => $statement->rowCount(),
            'activeConnections' => count($this->clients),
            'roomsInMemory' => count($this->rooms),
        ]);
    }

    /** @return array<string, mixed> */
    private function clientContext(int $clientId): array
    {
        if (!isset($this->clients[$clientId])) {
            return ['connection' => 'disconnected'];
        }

        return [
            'connection' => $this->clients[$clientId]['traceId'],
            'role' => $this->clients[$clientId]['role'],
        ];
    }

    private function roomTag(string $roomId): string
    {
        return substr(hash('sha256', $roomId), 0, 10);
    }

    private function initializeLogging(): void
    {
        $configuredPath = trim((string) ($this->config['log_file'] ?? ''));
        if ($configuredPath === '') {
            return;
        }

        $directory = dirname($configuredPath);
        if (!is_dir($directory) && !@mkdir($directory, 0700, true) && !is_dir($directory)) {
            fwrite(STDERR, "Nie można utworzyć katalogu logów: {$directory}\n");
            return;
        }
        if (is_file($configuredPath) && filesize($configuredPath) >= 5 * 1024 * 1024) {
            @rename($configuredPath, $configuredPath . '.1');
        }
        $this->logFilePath = $configuredPath;
    }

    /** @param array<string, mixed> $context */
    private function log(string $level, string $event, array $context = []): void
    {
        $configuredLevel = self::LOG_PRIORITIES[$this->config['log_level']] ?? self::LOG_PRIORITIES['info'];
        $messageLevel = self::LOG_PRIORITIES[$level] ?? self::LOG_PRIORITIES['info'];
        if ($messageLevel < $configuredLevel) {
            return;
        }

        $record = [
            'time' => date(DATE_ATOM),
            'level' => $level,
            'event' => $event,
            ...$context,
        ];
        $line = json_encode(
            $record,
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
        ) . PHP_EOL;
        fwrite($level === 'error' ? STDERR : STDOUT, $line);
        if ($this->logFilePath !== '') {
            @file_put_contents($this->logFilePath, $line, FILE_APPEND | LOCK_EX);
        }
    }
}

$config = require __DIR__ . '/config.php';

try {
    (new SafeChatServer($config))->run();
} catch (Throwable $exception) {
    fwrite(STDERR, sprintf("SafeChat nie został uruchomiony: %s\n", $exception->getMessage()));
    exit(1);
}
