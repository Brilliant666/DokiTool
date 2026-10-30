<?php
declare(strict_types=1);
require_once __DIR__ . '/../lib/platforms.php';
echo json_encode(snapPlatformCatalog(), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR) . PHP_EOL;
