<?php
declare(strict_types=1);
require_once __DIR__ . '/media-contract.php';

function snapSameFrameRate(float $a, float $b): bool
{
    return abs($a - $b) / max($a, $b) <= 0.01;
}

/** Only the policy's geometry and four protected capabilities affect coverage. */
function snapPolicyMetadata(array $variant, array $resource, array $fields): array
{
    $merged = array_replace($resource, $variant);
    $conflict = (bool)array_intersect($fields, array_keys($variant['field_conflicts'] ?? []));
    $conflict = $conflict || (bool)array_intersect($fields, array_keys($resource['field_conflicts'] ?? []));
    foreach ($fields as $field) {
        if (!isset($variant[$field], $resource[$field])) continue;
        $equal = $field === 'fps' ? snapSameFrameRate((float)$variant[$field], (float)$resource[$field]) : $variant[$field] === $resource[$field];
        if (!$equal) $conflict = true;
    }
    return [$merged, $conflict];
}

/** No candidate is removed unless one currently usable complete file covers it. */
function snapFilterItemVariants(array $item, int $now): array
{
    if (($item['state'] ?? 'ready') !== 'ready' || $item['type'] !== 'video') return $item;
    $completeFiles = array_values(array_filter($item['variants'], static fn ($variant) => ($variant['state'] ?? 'ready') === 'ready'
        && $variant['delivery']['kind'] === 'file' && ($variant['metadata']['has_audio'] ?? null) !== false));
    $files = array_values(array_filter($completeFiles, static fn ($variant) => snapDeliveryUsable($variant['delivery'], $now)));
    if (!$files) return $item;
    $mainLanguages = [];
    // Delivery expiry removes replacement eligibility, not confirmed media facts.
    foreach ($completeFiles as $file) {
        $metadata = $file['metadata'] ?? [];
        if (isset($metadata['audio_language'])) $mainLanguages[] = strtolower($metadata['audio_language']);
        foreach ($metadata['field_conflicts']['audio_language'] ?? [] as $fact) $mainLanguages[] = strtolower($fact['value']);
    }
    foreach ($item['variants'] as $variant) foreach ($variant['delivery']['resources'] ?? [] as $resource) {
        $metadata = $resource['metadata'] ?? [];
        $main = ($metadata['audio_language_role'] ?? '') === 'main'
            || in_array('main', array_column($metadata['field_conflicts']['audio_language_role'] ?? [], 'value'), true);
        if ($resource['role'] !== 'audio' || !$main) continue;
        if (isset($metadata['audio_language'])) $mainLanguages[] = strtolower($metadata['audio_language']);
        foreach ($metadata['field_conflicts']['audio_language'] ?? [] as $fact) $mainLanguages[] = strtolower($fact['value']);
    }
    $item['variants'] = array_values(array_filter($item['variants'], static function ($mux) use ($files, $mainLanguages) {
        if (($mux['state'] ?? 'ready') !== 'ready' || $mux['delivery']['kind'] !== 'mux') return true;
        $videoResources = array_values(array_filter($mux['delivery']['resources'], static fn ($resource) => $resource['role'] === 'video'));
        $audioResources = array_values(array_filter($mux['delivery']['resources'], static fn ($resource) => $resource['role'] === 'audio'));
        if (count($videoResources) !== 1 || !$audioResources) return true;
        [$video, $conflict] = snapPolicyMetadata($mux['metadata'] ?? [], $videoResources[0]['metadata'] ?? [], ['width', 'height', 'fps', 'hdr_type']);
        $audio = []; $audioFields = ['audio_language', 'audio_language_role', 'audio_channels'];
        foreach ($audioResources as $resource) {
            if (count($audioResources) > 1 && array_intersect($audioFields, array_keys($mux['metadata'] ?? []))) return true;
            [$metadata, $audioConflict] = snapPolicyMetadata($mux['metadata'] ?? [], $resource['metadata'] ?? [], $audioFields);
            $conflict = $conflict || $audioConflict; $audio[] = $metadata;
        }
        if ($conflict) return true;
        foreach ($files as $file) {
            // Conflicting facts cannot establish that this file covers a mux.
            if (array_intersect(['width', 'height', 'fps', 'hdr_type', 'audio_language', 'audio_language_role', 'audio_channels', 'has_audio'], array_keys($file['metadata']['field_conflicts'] ?? []))) continue;
            if (!in_array(snapQualityCompare($file, ['metadata' => $video]), [0, 1], true)) continue;
            $complete = $file['metadata'] ?? [];
            $fps = $video['fps'] ?? null;
            if ($fps !== null && $fps > 30 && !snapSameFrameRate((float)$fps, 30.0)
                && (!isset($complete['fps']) || ($complete['fps'] < $fps && !snapSameFrameRate((float)$fps, (float)$complete['fps'])))) continue;
            $hdr = $video['hdr_type'] ?? null;
            if ($hdr !== null && $hdr !== 'sdr' && ($hdr === 'hdr_unknown' || ($complete['hdr_type'] ?? null) !== $hdr)) continue;
            $covered = true;
            foreach ($audio as $track) {
                if (($track['audio_channels'] ?? 0) > 2 && ($complete['audio_channels'] ?? 0) < $track['audio_channels']) { $covered = false; break; }
                $language = isset($track['audio_language']) ? strtolower($track['audio_language']) : null;
                $differentLanguage = $language !== null && (($track['audio_language_role'] ?? '') === 'alternate'
                    || array_filter($mainLanguages, static fn ($main) => $main !== $language));
                if ($differentLanguage && strtolower($complete['audio_language'] ?? '') !== $language) { $covered = false; break; }
            }
            if ($covered) return false;
        }
        return true;
    }));
    return $item;
}

/** Only generated API navigation links inherit this view, not platform/CDN URLs. */
function snapViewUrl(string $url, bool $debug): string
{
    $parts = explode('?', $url, 2);
    $query = array_values(array_filter(explode('&', $parts[1] ?? ''), static fn ($entry) => $entry !== '' && rawurldecode(explode('=', $entry, 2)[0]) !== 'debug'));
    if ($debug) $query[] = 'debug=1';
    return $parts[0] . ($query ? '?' . implode('&', $query) : '');
}

function snapPublicMediaView(array $payload, bool $debug = false, ?int $now = null): array
{
    if (($payload['code'] ?? '') !== 'OK') return $payload;
    $now ??= time(); $data = $payload['data'];
    if (isset($data['refresh_url'])) $data['refresh_url'] = snapViewUrl($data['refresh_url'], $debug);
    foreach ($data['items'] as &$item) {
        if (!$debug) $item = snapFilterItemVariants($item, $now);
        if (isset($item['resolve_url'])) $item['resolve_url'] = snapViewUrl($item['resolve_url'], $debug);
    }
    unset($item);
    return snapFinalizeData($data, $now);
}
