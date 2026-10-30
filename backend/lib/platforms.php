<?php
declare(strict_types=1);

/** One registration source for dispatch, runtime catalog and the prerender snapshot. */
function snapPlatforms(): array
{
    static $platforms;
    if ($platforms === null) {
        $rows = json_decode(file_get_contents(__DIR__ . '/../config/platforms.json'), true, 32, JSON_THROW_ON_ERROR);
        $platforms = [];
        foreach ($rows as $row) {
            if (!preg_match('/^[a-z][a-z0-9_-]*$/D', $row['id']) || isset($platforms[$row['id']])
                || !preg_match('~^[a-zA-Z0-9_/-]+\.php$~D', $row['file']) || str_contains($row['file'], '..')) {
                throw new RuntimeException('Invalid platform registration');
            }
            $platforms[$row['id']] = $row;
        }
    }
    return $platforms;
}

function snapPlatformCatalog(): array
{
    return ['schema_version' => '1.0', 'code' => 'OK', 'data' => ['platforms' => array_values(array_map(
        static fn (array $row): array => array_intersect_key($row, array_flip(['id', 'name', 'site_url', 'icon', 'capabilities'])), snapPlatforms()))]];
}
