<?php

declare(strict_types=1);

require __DIR__ . '/lib/locale.php';

$language = $_GET['lang'] ?? '';
if (!is_string($language) || !in_array($language, BURNIT_SUPPORTED_LANGUAGES, true)) {
    http_response_code(400);
    exit('Unsupported language.');
}

$returnTargets = [
    'chat' => '/',
    'info' => '/jak-to-dziala.html',
];
$returnKey = $_GET['return'] ?? 'chat';
$returnPath = is_string($returnKey) && isset($returnTargets[$returnKey])
    ? $returnTargets[$returnKey]
    : '/';

burnit_set_language_cookie($language);
header('Cache-Control: no-store');
header('Location: ' . $returnPath, true, 303);
