<?php
declare(strict_types=1);

const SNAP_SCHEMA_VERSION = '1.0';

function snapContractError(string $code, string $message, bool $retryable = false): array
{
    $error = ['code' => $code, 'message' => $message];
    if ($retryable) $error['retryable'] = true;
    return ['schema_version' => SNAP_SCHEMA_VERSION, 'code' => $code, 'error' => $error];
}

function snapAssert(bool $condition, string $message): void
{
    if (!$condition) throw new UnexpectedValueException($message);
}

function snapRfc3339(string $value): bool
{
    if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/D', $value, $parts)) return false;
    return checkdate((int)$parts[2], (int)$parts[3], (int)$parts[1])
        && (int)$parts[4] <= 23 && (int)$parts[5] <= 59 && (int)$parts[6] <= 59
        && (!isset($parts[7]) || ((int)$parts[7] <= 23 && (int)$parts[8] <= 59));
}

/** This small runtime validator implements the keywords used by the checked-in schema.
 * Independent Draft 2020-12 validation runs in the test suite, not this implementation.
 */
function snapValidateStructure($value, array $node, array $schema, string $path = '$'): void
{
    if (isset($node['$ref'])) {
        $name = substr($node['$ref'], strlen('#/$defs/'));
        snapAssert(isset($schema['$defs'][$name]), 'Unknown schema reference');
        snapValidateStructure($value, $schema['$defs'][$name], $schema, $path);
        return;
    }
    if (isset($node['anyOf']) || isset($node['oneOf'])) {
        $matches = 0; $errors = [];
        foreach ($node['anyOf'] ?? $node['oneOf'] as $alternative) {
            try { snapValidateStructure($value, $alternative, $schema, $path); $matches++; }
            catch (UnexpectedValueException $error) { $errors[] = $error->getMessage(); }
        }
        snapAssert(isset($node['oneOf']) ? $matches === 1 : $matches > 0, $path . ': invalid schema branch (' . implode('; ', $errors) . ')');
        return;
    }
    if (array_key_exists('const', $node)) snapAssert($value === $node['const'], $path . ': invalid constant');
    if (isset($node['enum'])) snapAssert(in_array($value, $node['enum'], true), $path . ': invalid enum');
    $type = $node['type'] ?? null;
    $valid = match ($type) {
        'object' => is_array($value) && (!$value || !array_is_list($value)),
        'array' => is_array($value) && array_is_list($value),
        'string' => is_string($value), 'integer' => is_int($value),
        'number' => (is_int($value) || is_float($value)) && is_finite((float)$value),
        'boolean' => is_bool($value), 'null' => $value === null, null => true,
        default => false,
    };
    snapAssert($valid, $path . ': invalid type');
    if ($type === 'object') {
        snapAssert(count($value) >= ($node['minProperties'] ?? 0), $path . ': too few properties');
        foreach ($node['required'] ?? [] as $key) snapAssert(array_key_exists($key, $value), $path . ': missing ' . $key);
        foreach ($value as $key => $child) {
            if (isset($node['properties'][$key])) snapValidateStructure($child, $node['properties'][$key], $schema, $path . '.' . $key);
            elseif (($node['additionalProperties'] ?? true) === false) throw new UnexpectedValueException($path . ': unknown ' . $key);
            elseif (is_array($node['additionalProperties'] ?? null)) snapValidateStructure($child, $node['additionalProperties'], $schema, $path . '.' . $key);
        }
    }
    if ($type === 'array') {
        snapAssert(count($value) >= ($node['minItems'] ?? 0), $path . ': empty list');
        if (isset($node['maxItems'])) snapAssert(count($value) <= $node['maxItems'], $path . ': too many items');
        foreach ($value as $index => $child) snapValidateStructure($child, $node['items'] ?? [], $schema, $path . '[' . $index . ']');
    }
    if ($type === 'string') {
        snapAssert(preg_match('//u', $value) === 1, $path . ': invalid UTF-8');
        $length = preg_match_all('/./us', $value);
        snapAssert($length >= ($node['minLength'] ?? 0), $path . ': empty text');
        if (isset($node['maxLength'])) snapAssert($length <= $node['maxLength'], $path . ': long text');
        if (isset($node['pattern'])) snapAssert(preg_match('~' . str_replace('~', '\\~', $node['pattern']) . '~u', $value) === 1, $path . ': invalid pattern');
        if (($node['format'] ?? '') === 'date-time') snapAssert(snapRfc3339($value), $path . ': invalid RFC3339 timestamp');
        if (($node['format'] ?? '') === 'uri') snapAssert(filter_var($value, FILTER_VALIDATE_URL) !== false, $path . ': invalid absolute URI');
    }
    if (is_int($value) || is_float($value)) {
        if (isset($node['minimum'])) snapAssert($value >= $node['minimum'], $path . ': below minimum');
        if (isset($node['exclusiveMinimum'])) snapAssert($value > $node['exclusiveMinimum'], $path . ': below exclusive minimum');
        if (isset($node['maximum'])) snapAssert($value <= $node['maximum'], $path . ': above maximum');
    }
}

function snapSourceUsable(array $source, int $now): bool
{
    return ($source['availability'] ?? 'unknown') !== 'unavailable'
        && (!isset($source['expires_at']) || strtotime($source['expires_at']) > $now);
}

function snapDeliverySources(array $delivery): array
{
    return match ($delivery['kind']) {
        'file', 'hls', 'dash' => [$delivery['sources']],
        'segments' => array_merge(isset($delivery['init']) ? [$delivery['init']['sources']] : [], array_column($delivery['pieces'], 'sources')),
        'mux', 'pair' => array_merge(...array_map(static fn ($r) => snapDeliverySources($r['delivery']), $delivery['resources'])),
    };
}

function snapDeliveryUsable(array $delivery, int $now): bool
{
    foreach (snapDeliverySources($delivery) as $sources) {
        if (!array_filter($sources, static fn ($s) => snapSourceUsable($s, $now))) return false;
    }
    return true;
}

function snapDeliveryRequires(array $delivery): array
{
    $requires = match ($delivery['kind']) {
        'file' => [], 'hls', 'dash' => [$delivery['kind']],
        'segments' => [$delivery['join'] === 'byte_concat' ? 'segment_byte_concat' : 'segment_remux'],
        'mux', 'pair' => array_merge([$delivery['kind']], ...array_map(static fn ($r) => snapDeliveryRequires($r['delivery']), $delivery['resources'])),
    };
    $requires = array_values(array_unique($requires)); sort($requires); return $requires;
}

/** Conservative spatial dominance; labels, original URLs and cross-codec bitrate are not evidence. */
function snapQualityCompare(array $left, array $right): ?int
{
    $a = $left['metadata'] ?? []; $b = $right['metadata'] ?? [];
    if (!isset($a['width'], $a['height'], $b['width'], $b['height'])) return null;
    $ad = [$a['width'], $a['height']]; sort($ad);
    $bd = [$b['width'], $b['height']]; sort($bd);
    if (abs(($ad[1] / $ad[0]) / ($bd[1] / $bd[0]) - 1) > 0.01) return null;
    if ($ad === $bd) return 0;
    if ($ad[0] >= $bd[0] && $ad[1] >= $bd[1]) return 1;
    if ($ad[0] <= $bd[0] && $ad[1] <= $bd[1]) return -1;
    return null;
}

/** Tie policy is independent of display order: known geometry, original endpoint, stable ID.
 * Original provenance breaks same/unknown quality ties; it never proves higher quality.
 */
function snapVariantTieKey(array $v): array
{
    return [isset($v['metadata']['width'], $v['metadata']['height']) ? 0 : 1,
        ($v['provenance'] ?? '') === 'original_endpoint' ? 0 : 1, $v['id']];
}

function snapSelectDefault(array $item, int $now): array
{
    unset($item['default_unavailable_reason'], $item['higher_quality_variants']);
    $item['default'] = null;
    if (($item['state'] ?? 'ready') !== 'ready') {
        $item['default_unavailable_reason'] = $item['state'] === 'deferred' ? 'needs_resolve' : 'unavailable';
        return $item;
    }
    $eligible = array_values(array_filter($item['variants'], static fn ($v) => ($v['state'] ?? 'ready') === 'ready' && $v['delivery']['kind'] === 'file' && snapDeliveryUsable($v['delivery'], $now)));
    // Remove every dominated candidate, then use a documented stable tie-break.
    $highest = array_values(array_filter($eligible, static fn ($v) => !array_filter($eligible, static fn ($other) => snapQualityCompare($other, $v) === 1)));
    usort($highest, static fn ($a, $b) => snapVariantTieKey($a) <=> snapVariantTieKey($b));
    if ($highest) {
        $selected = $highest[0]; $sources = $selected['delivery']['sources'];
        $source = array_values(array_filter($sources, static fn ($s) => snapSourceUsable($s, $now)))[0];
        $item['default'] = ['variant_id' => $selected['id'], 'url' => $source['url']];
        foreach (['id' => 'source_id', 'access' => 'access', 'expires_at' => 'expires_at'] as $from => $to) {
            if (isset($source[$from])) $item['default'][$to] = $source[$from];
        }
        $higher = [];
        foreach ($item['variants'] as $v) {
            if (snapQualityCompare($v, $selected) === 1 && snapDeliveryUsable($v['delivery'], $now) && ($required = snapDeliveryRequires($v['delivery']))) {
                $higher[] = ['variant_id' => $v['id'], 'requires' => $required];
            }
        }
        if ($higher) $item['higher_quality_variants'] = $higher;
    } else {
        $reason = array_filter($item['variants'], static fn ($v) => ($v['state'] ?? 'ready') === 'deferred') ? 'needs_resolve' : 'unavailable';
        foreach ($item['variants'] as $v) {
            if (($v['state'] ?? 'ready') === 'deferred') continue;
            if (snapDeliveryUsable($v['delivery'], $now)) { $reason = 'processing_required'; break; }
            foreach (snapDeliverySources($v['delivery']) as $sources) {
                foreach ($sources as $s) if ($reason !== 'needs_resolve' && isset($s['expires_at']) && strtotime($s['expires_at']) <= $now) $reason = 'needs_refresh';
            }
        }
        $item['default_unavailable_reason'] = $reason;
    }
    return $item;
}

function snapFinalizeData(array $data, ?int $now = null): array
{
    $now ??= time();
    $data['generated_at'] = gmdate('Y-m-d\TH:i:s\Z', $now);
    $data['items'] = array_map(static fn ($item) => snapSelectDefault($item, $now), $data['items']);
    return ['schema_version' => SNAP_SCHEMA_VERSION, 'code' => 'OK', 'data' => $data];
}

function snapValidateSource(array $s, ?int $generatedAt): void
{
    $url = $s['url'];
    snapAssert(!preg_match('/[\\\\\x00-\x20\x7f]/', $url), 'Unsafe source URL');
    $p = parse_url($url); snapAssert(is_array($p) && !isset($p['user']) && !isset($p['pass']), 'Unsafe source URL authority');
    if (($s['access'] ?? 'direct') === 'relay') {
        $path = rawurldecode($p['path'] ?? '');
        snapAssert(str_starts_with($url, '/api/') && !isset($p['host']) && !str_contains($path, '\\')
            && !preg_match('~(?:^|/)\.{1,2}(?:/|$)|[\x00-\x20\x7f]|%[0-9a-f]{2}~i', $path), 'Unsafe relay URL');
    } else snapAssert(in_array(strtolower($p['scheme'] ?? ''), ['http', 'https'], true) && !empty($p['host']) && !isset($p['user']) && !isset($p['pass']), 'Absolute direct URL required');
    if (isset($s['expires_at'])) snapAssert($generatedAt !== null && strtotime($s['expires_at']) !== false, 'Expiry needs valid generation time');
}

function snapValidateMetadata(array $m, ?string $role = null): void
{
    $technical = array_diff(array_keys($m), ['container', 'extension', 'mime_type', 'evidence', 'field_evidence']);
    if ($technical) snapAssert(in_array($m['evidence'] ?? '', ['probe', 'upstream', 'mixed'], true), 'Technical metadata needs evidence');
    if (($m['evidence'] ?? '') === 'mixed') {
        foreach ($technical as $field) snapAssert(in_array($m['field_evidence'][$field] ?? '', ['probe', 'upstream'], true), 'Mixed metadata evidence incomplete');
    }
    if (($m['has_audio'] ?? null) === false || in_array($role, ['video', 'image', 'subtitle'], true)) {
        foreach (['audio_codec', 'audio_language', 'audio_channels', 'sample_rate_hz', 'audio_bitrate_bps'] as $field) snapAssert(!isset($m[$field]), 'Contradictory audio metadata');
        if ($role !== null) snapAssert(($m['has_audio'] ?? false) === false, 'Track cannot claim embedded audio');
    }
    if ($role === 'audio') foreach (['width', 'height', 'fps', 'video_codec', 'video_bitrate_bps'] as $field) snapAssert(!isset($m[$field]), 'Audio cannot carry video metadata');
}

function snapValidateDelivery(array $delivery, ?int $generatedAt, bool $leaf = false): void
{
    $kind = $delivery['kind'];
    snapAssert(!$leaf || !in_array($kind, ['mux', 'pair'], true), 'Nested composition is unsupported');
    foreach (snapDeliverySources($delivery) as $sources) {
        $ids = [];
        foreach ($sources as $s) {
            snapValidateSource($s, $generatedAt);
            snapAssert(count($sources) === 1 || isset($s['id']), 'Multiple sources require IDs');
            if (isset($s['id'])) { snapAssert(!isset($ids[$s['id']]), 'Duplicate source ID'); $ids[$s['id']] = true; }
        }
    }
    if ($kind === 'segments') {
        foreach ($delivery['pieces'] as $i => $piece) snapAssert($piece['index'] === $i + 1, 'Segments must preserve contiguous time order');
        if ($delivery['join'] === 'byte_concat') snapAssert(($delivery['join_evidence'] ?? '') === 'validated_fragment_layout', 'Byte concat requires layout evidence');
        foreach (array_merge(isset($delivery['init']) ? [$delivery['init']] : [], $delivery['pieces']) as $chunk) {
            if (isset($chunk['byte_range'])) snapAssert($chunk['byte_range']['end_inclusive'] >= $chunk['byte_range']['start'], 'Invalid byte range');
        }
    }
    if (in_array($kind, ['hls', 'dash'], true) && isset($delivery['selection'])) snapAssert(count($delivery['selection']) > 0, 'Empty manifest selection');
    if (in_array($kind, ['mux', 'pair'], true)) {
        $ids = []; $roles = [];
        foreach ($delivery['resources'] as $r) {
            snapAssert(!isset($ids[$r['id']]), 'Duplicate resource ID'); $ids[$r['id']] = true; $roles[] = $r['role'];
            snapValidateMetadata($r['metadata'] ?? [], $r['role']); snapValidateDelivery($r['delivery'], $generatedAt, true);
        }
        $counts = array_count_values($roles);
        if ($kind === 'pair') snapAssert(count($roles) === 2 && ($counts['image'] ?? 0) === 1 && ($counts['motion'] ?? 0) === 1, 'Invalid live pair');
        else snapAssert(($counts['video'] ?? 0) === 1 && ($counts['audio'] ?? 0) >= 1 && count(array_diff($roles, ['video', 'audio'])) === 0, 'Invalid mux roles');
    }
}

function snapValidateEnvelope(array $payload): void
{
    static $schema;
    $schema ??= json_decode(file_get_contents(__DIR__ . '/../../docs/schema/unified-v1/unified-v1.schema.json'), true, 128, JSON_THROW_ON_ERROR);
    snapValidateStructure($payload, $schema, $schema);
    if ($payload['code'] !== 'OK') { snapAssert($payload['error']['code'] === $payload['code'], 'Error code mismatch'); return; }
    $data = $payload['data']; $time = isset($data['generated_at']) ? strtotime($data['generated_at']) : null;
    snapAssert($time !== false, 'Invalid generation time');
    $ids = [];
    foreach ($data['items'] as $item) {
        snapAssert(!isset($ids[$item['id']]), 'Duplicate item ID'); $ids[$item['id']] = true;
        if (isset($item['cover'])) snapValidateSource($item['cover'], $time);
        $variantIds = [];
        foreach ($item['variants'] ?? [] as $variant) {
            snapAssert(!isset($variantIds[$variant['id']]), 'Duplicate variant ID'); $variantIds[$variant['id']] = true;
            if (($variant['state'] ?? 'ready') === 'deferred') continue;
            snapValidateMetadata($variant['metadata'] ?? []); snapValidateDelivery($variant['delivery'], $time);
            if (in_array($variant['delivery']['kind'], ['hls', 'dash'], true) && $variant['delivery']['scope'] === 'adaptive' && !isset($variant['delivery']['selection'])) {
                snapAssert(!isset($variant['metadata']['width']) && !isset($variant['metadata']['height']), 'Adaptive manifest has no fixed resolution');
            }
            if ($variant['delivery']['kind'] === 'mux') {
                foreach ($variant['delivery']['resources'] as $r) if ($r['role'] === 'video') {
                    foreach (['width', 'height', 'fps', 'video_codec', 'video_bitrate_bps'] as $key) {
                        if (isset($variant['metadata'][$key], $r['metadata'][$key])) snapAssert($variant['metadata'][$key] === $r['metadata'][$key], 'Mux video metadata conflict');
                    }
                }
            }
        }
        // Validate references independently of array order. Selection itself runs once,
        // when the backend creates the response, not again in public consumers.
        $expected = snapSelectDefault($item, $time ?? time());
        if ($item['default'] !== null) {
            snapAssert($expected['default'] !== null, 'No eligible complete file');
            $selected = null;
            foreach ($item['variants'] as $variant) if ($variant['id'] === $item['default']['variant_id']) $selected = $variant;
            snapAssert($selected !== null && ($selected['state'] ?? 'ready') === 'ready' && $selected['delivery']['kind'] === 'file', 'Default must reference complete file');
            $sources = $selected['delivery']['sources']; $source = null;
            snapAssert(count($sources) === 1 || isset($item['default']['source_id']), 'Default requires source ID');
            foreach ($sources as $entry) {
                if (isset($item['default']['source_id']) ? ($entry['id'] ?? null) === $item['default']['source_id'] : count($sources) === 1) $source = $entry;
            }
            snapAssert($source !== null && snapSourceUsable($source, $time ?? time()), 'Default source is unavailable');
            snapAssert($source['url'] === $item['default']['url'] && ($source['access'] ?? 'direct') === ($item['default']['access'] ?? 'direct') && ($source['expires_at'] ?? null) === ($item['default']['expires_at'] ?? null), 'Default source projection mismatch');
            $expected['higher_quality_variants'] = [];
            foreach ($item['variants'] as $variant) {
                if (snapQualityCompare($variant, $selected) !== 1 || !snapDeliveryUsable($variant['delivery'], $time ?? time())) continue;
                snapAssert($variant['delivery']['kind'] !== 'file', 'Higher complete file omitted from default');
                $expected['higher_quality_variants'][] = ['variant_id' => $variant['id'], 'requires' => snapDeliveryRequires($variant['delivery'])];
            }
        } else snapAssert($expected['default'] === null, 'Eligible complete file has null default');
        snapAssert(($expected['default_unavailable_reason'] ?? null) === ($item['default_unavailable_reason'] ?? null), 'Invalid null-default reason');
        $normalHigher = static function (array $h): array { foreach ($h as &$entry) sort($entry['requires']); unset($entry); usort($h, static fn ($a, $b) => $a['variant_id'] <=> $b['variant_id']); return $h; };
        snapAssert($normalHigher($expected['higher_quality_variants'] ?? []) === $normalHigher($item['higher_quality_variants'] ?? []), 'Higher-quality projection mismatch');
    }
    snapAssert(count($ids) === 1 || isset($data['default_item_id']), 'Multiple items need explicit entry');
    if (isset($data['default_item_id'])) snapAssert(isset($ids[$data['default_item_id']]), 'Unknown default item');
    $groupIds = [];
    foreach ($data['groups'] ?? [] as $group) {
        snapAssert(!isset($groupIds[$group['id']]), 'Duplicate group'); $groupIds[$group['id']] = true;
        snapAssert(count($group['item_ids']) === count(array_unique($group['item_ids'])), 'Duplicate group member');
        foreach ($group['item_ids'] as $id) snapAssert(isset($ids[$id]), 'Unknown group item');
    }
    foreach ($payload['warnings'] ?? [] as $warning) if (isset($warning['item_id'])) snapAssert(isset($ids[$warning['item_id']]), 'Unknown warning item');
    foreach ([$data['cover'] ?? null, $data['author']['avatar'] ?? null] as $s) if ($s) snapValidateSource($s, $time);
    $attachmentIds = [];
    foreach ($data['attachments'] ?? [] as $attachment) {
        snapAssert(!isset($attachmentIds[$attachment['id']]), 'Duplicate attachment'); $attachmentIds[$attachment['id']] = true;
        snapValidateMetadata($attachment['resource']['metadata'] ?? [], $attachment['resource']['role']);
        snapValidateDelivery($attachment['resource']['delivery'], $time, true);
        if (isset($attachment['cover'])) snapValidateSource($attachment['cover'], $time);
    }
}
