<?php

declare(strict_types=1);

$env = static function (string $name, string $default = ''): string {
    $value = getenv($name);
    return $value === false ? $default : $value;
};

return [
    'listen_host' => $env('SAFECHAT_LISTEN_HOST', '127.0.0.1'),
    'listen_port' => (int) $env('SAFECHAT_LISTEN_PORT', '8080'),
    'websocket_path' => $env('SAFECHAT_WS_PATH', '/ws'),
    'allowed_origins' => array_values(array_filter(array_map(
        'trim',
        explode(',', $env(
            'SAFECHAT_ALLOWED_ORIGINS',
            'http://localhost,http://127.0.0.1,http://safechat.test'
        ))
    ))),
    'db_dsn' => $env('SAFECHAT_DB_DSN', 'mysql:host=127.0.0.1;port=3306;dbname=safechat;charset=utf8mb4'),
    'db_user' => $env('SAFECHAT_DB_USER', 'root'),
    'db_password' => $env('SAFECHAT_DB_PASSWORD'),
    'waiting_ttl_seconds' => max(60, (int) $env('SAFECHAT_WAITING_TTL', '900')),
    'handshake_timeout_seconds' => max(5, (int) $env('SAFECHAT_HANDSHAKE_TIMEOUT', '20')),
    'max_frame_bytes' => min(262144, max(4096, (int) $env('SAFECHAT_MAX_FRAME_BYTES', '70000'))),
    'rate_limit_messages' => max(10, (int) $env('SAFECHAT_RATE_LIMIT_MESSAGES', '60')),
    'rate_limit_window_seconds' => max(1, (int) $env('SAFECHAT_RATE_LIMIT_WINDOW', '10')),
    'log_level' => strtolower($env('SAFECHAT_LOG_LEVEL', 'debug')),
    // Logi zawierają wyłącznie zdarzenia techniczne, nigdy klucze, treść ani szyfrogram.
    'log_file' => $env(
        'SAFECHAT_LOG_FILE',
        dirname(__DIR__) . DIRECTORY_SEPARATOR . 'logs' . DIRECTORY_SEPARATOR . 'relay.log'
    ),
];
