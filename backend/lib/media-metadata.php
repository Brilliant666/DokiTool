<?php
declare(strict_types=1);

/** Only explicit numeric frame-rate fields, including the DASH fraction form. */
function snapFrameRate($raw): ?float
{
    if (is_string($raw) && preg_match('~^(\d+(?:\.\d+)?)/(\d+(?:\.\d+)?)$~D', $raw, $match)) {
        if ((float)$match[2] <= 0) return null;
        $raw = (float)$match[1] / (float)$match[2];
    }
    return is_numeric($raw) && is_finite((float)$raw) && $raw > 0 ? (float)$raw : null;
}

function snapHdrType($raw): ?string
{
    if (!is_string($raw)) return null;
    return match (strtolower(trim($raw))) {
        'sdr' => 'sdr', 'hdr10' => 'hdr10', 'hdr10+', 'hdr10_plus' => 'hdr10_plus',
        'hlg' => 'hlg', 'dolby vision', 'dolby_vision', 'dovi' => 'dolby_vision',
        'hdr', 'hdr_unknown' => 'hdr_unknown', default => null,
    };
}

function snapVideoFacts(array $raw): array
{
    $facts = [];
    foreach (['width', 'height'] as $field) if (is_numeric($raw[$field] ?? null) && $raw[$field] > 0) $facts[$field] = (int)$raw[$field];
    foreach (['fps', 'frameRate', 'frame_rate', 'video_fps'] as $field) if (($fps = snapFrameRate($raw[$field] ?? null)) !== null) { $facts['fps'] = $fps; break; }
    if (($hdr = snapHdrType($raw['hdr_type'] ?? $raw['dynamic_range'] ?? null)) !== null) $facts['hdr_type'] = $hdr;
    elseif (($raw['is_hdr'] ?? null) === true || ($raw['is_hdr'] ?? null) === 1) $facts['hdr_type'] = 'hdr_unknown';
    return $facts;
}

/** Language tags/roles must describe this audio stream, never its ID or codec. */
function snapAudioFacts(array $raw): array
{
    $facts = [];
    foreach (['audio_channels', 'channels', 'channel_count'] as $field) if (is_numeric($raw[$field] ?? null) && $raw[$field] > 0) { $facts['audio_channels'] = (int)$raw[$field]; break; }
    $language = $raw['audio_language'] ?? $raw['language'] ?? $raw['lang'] ?? null;
    if (is_string($language)) {
        $language = strtolower(str_replace('_', '-', trim($language)));
        if (preg_match('/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/D', $language) && !in_array($language, ['und', 'mul', 'zxx'], true)) {
            $facts['audio_language'] = $language;
            $role = $raw['audio_language_role'] ?? $raw['language_role'] ?? null;
            if (in_array($role, ['main', 'alternate'], true)) $facts['audio_language_role'] = $role;
            elseif (($raw['is_alternate_language'] ?? null) === true) $facts['audio_language_role'] = 'alternate';
        }
    }
    if (is_bool($raw['has_audio'] ?? null)) $facts['has_audio'] = $raw['has_audio'];
    return $facts;
}
