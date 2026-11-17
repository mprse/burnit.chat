<?php

declare(strict_types=1);

require __DIR__ . '/lib/locale.php';

$language = burnit_language();
$template = $language === 'pl' ? 'jak-to-dziala.html' : 'how-it-works.html';

header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');
readfile(__DIR__ . '/' . $template);
