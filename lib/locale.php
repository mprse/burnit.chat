<?php

declare(strict_types=1);

const BURNIT_LANGUAGE_COOKIE = 'burnit_lang';
const BURNIT_SUPPORTED_LANGUAGES = ['pl', 'en'];

function burnit_manual_language(): ?string
{
    $language = $_COOKIE[BURNIT_LANGUAGE_COOKIE] ?? null;
    return is_string($language) && in_array($language, BURNIT_SUPPORTED_LANGUAGES, true)
        ? $language
        : null;
}

function burnit_client_ip(): string
{
    $ip = $_SERVER['REMOTE_ADDR'] ?? '';
    return is_string($ip) && filter_var($ip, FILTER_VALIDATE_IP) ? $ip : '';
}

function burnit_is_private_ip(string $ip): bool
{
    return $ip !== '' && filter_var(
        $ip,
        FILTER_VALIDATE_IP,
        FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE
    ) === false;
}

function burnit_ipv4_in_ranges(string $ip, array $ranges): bool
{
    $packed = inet_pton($ip);
    if ($packed === false || strlen($packed) !== 4) {
        return false;
    }

    $value = unpack('N', $packed)[1];
    $low = 0;
    $high = count($ranges) - 1;

    while ($low <= $high) {
        $middle = intdiv($low + $high, 2);
        [$start, $end] = $ranges[$middle];
        if ($value < $start) {
            $high = $middle - 1;
        } elseif ($value > $end) {
            $low = $middle + 1;
        } else {
            return true;
        }
    }

    return false;
}

function burnit_ipv6_in_network(string $ip, string $cidr): bool
{
    [$network, $prefixText] = explode('/', $cidr, 2);
    $ipBytes = inet_pton($ip);
    $networkBytes = inet_pton($network);
    $prefix = (int) $prefixText;

    if ($ipBytes === false || $networkBytes === false || strlen($ipBytes) !== 16) {
        return false;
    }

    $fullBytes = intdiv($prefix, 8);
    $remainingBits = $prefix % 8;
    if ($fullBytes > 0 && substr($ipBytes, 0, $fullBytes) !== substr($networkBytes, 0, $fullBytes)) {
        return false;
    }
    if ($remainingBits === 0) {
        return true;
    }

    $mask = (0xff << (8 - $remainingBits)) & 0xff;
    return (ord($ipBytes[$fullBytes]) & $mask) === (ord($networkBytes[$fullBytes]) & $mask);
}

function burnit_ip_is_polish(string $ip): bool
{
    static $ranges = null;
    if ($ranges === null) {
        $path = dirname(__DIR__) . '/data/pl-ip-ranges.json';
        $decoded = json_decode((string) file_get_contents($path), true);
        $ranges = is_array($decoded) ? $decoded : ['ipv4' => [], 'ipv6' => []];
    }

    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
        return burnit_ipv4_in_ranges($ip, $ranges['ipv4'] ?? []);
    }
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6)) {
        foreach ($ranges['ipv6'] ?? [] as $network) {
            if (is_string($network) && burnit_ipv6_in_network($ip, $network)) {
                return true;
            }
        }
    }

    return false;
}

function burnit_browser_language(): string
{
    $header = strtolower((string) ($_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? ''));
    return preg_match('/(^|,|\s)pl(?:-|;|,|$)/', $header) === 1 ? 'pl' : 'en';
}

function burnit_language(): string
{
    $manual = burnit_manual_language();
    if ($manual !== null) {
        return $manual;
    }

    $ip = burnit_client_ip();
    if (burnit_is_private_ip($ip)) {
        return burnit_browser_language();
    }

    return burnit_ip_is_polish($ip) ? 'pl' : 'en';
}

function burnit_set_language_cookie(string $language): void
{
    setcookie(BURNIT_LANGUAGE_COOKIE, $language, [
        'expires' => time() + 31_536_000,
        'path' => '/',
        'secure' => isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}
