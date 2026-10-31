<?php
declare(strict_types=1);
require_once __DIR__ . '/runtime.php';
require_once __DIR__ . '/platforms.php';
require_once __DIR__ . '/media-contract.php';
require_once __DIR__ . '/media-metadata.php';

/** Upstream/private parser fields end here. Public consumers only receive unified-v1. */
function snapAdaptParser(string $platform, array $payload, string $url): array
{
    if (!is_numeric($payload['code'] ?? null)) return snapContractError('UPSTREAM_INVALID_RESPONSE', '解析器返回格式异常');
    if ((int)$payload['code'] !== 200 || !is_array($payload['data'] ?? null)) {
        $code = match ((int)$payload['code']) {
            -1, 0, 201, 400 => 'INVALID_INPUT', 401, 403, 412 => 'UPSTREAM_BLOCKED',
            404 => 'CONTENT_UNAVAILABLE', 429 => 'RATE_LIMITED', 408, 504 => 'UPSTREAM_TIMEOUT',
            502 => 'UPSTREAM_INVALID_RESPONSE', default => 'UPSTREAM_UNAVAILABLE',
        };
        return snapContractError($code, is_string($payload['msg'] ?? null) ? $payload['msg'] : '上游解析暂时不可用', in_array($code, ['RATE_LIMITED', 'UPSTREAM_TIMEOUT', 'UPSTREAM_UNAVAILABLE'], true));
    }
    $adapter = snapPlatforms()[$platform]['adapter'];
    $data = $adapter($payload['data'], $url);
    if (!$data['items']) return snapContractError('NO_MEDIA', '作品未提供可用媒体');
    return snapFinalizeData($data);
}

function snapText($value): ?string
{
    return (is_string($value) || is_int($value)) && trim((string)$value) !== '' ? (string)$value : null;
}

function snapSource($raw): ?array
{
    $raw = is_string($raw) ? ['url' => $raw] : $raw;
    if (!is_array($raw) || !($url = snapMediaUrl($raw['url'] ?? null))) return null;
    $source = ['url' => $url];
    if (is_numeric($raw['size'] ?? null) && $raw['size'] > 0) $source['size_bytes'] = (int)$raw['size'];
    if (is_numeric($raw['size_bytes'] ?? null) && $raw['size_bytes'] > 0) $source['size_bytes'] = (int)$raw['size_bytes'];
    foreach (['expires_at', 'availability', 'browser_fetch'] as $field) if (isset($raw[$field])) $source[$field] = $raw[$field];
    return $source;
}

/** Identity only: retain the original URL for transport. Authentication parameters
 * are excluded only on these known provider endpoints. In particular file_id,
 * video_id, line, template and every unrecognized query parameter stay significant.
 */
function snapSourceIdentity(string $url): string
{
    $parts = parse_url($url); $host = strtolower($parts['host'] ?? ''); $path = $parts['path'] ?? '';
    // Observed official CDN paths prefix the resource with a 32-hex signature
    // and an 8-hex expiry. Preserve the route host, full resource path and every
    // query field; neither filename similarity nor an arbitrary CDN path suffices.
    if (($parts['scheme'] ?? '') === 'https' && !isset($parts['user']) && !isset($parts['pass'])
        && in_array($host, ['v3-web.douyinvod.com', 'v26-web.douyinvod.com', 'v26-luna.douyinvod.com', 'v11-weba.douyinvod.com'], true)
        && preg_match('~^/[a-f0-9]{32}/[a-f0-9]{8}(/video/tos/cn/tos-cn-[a-z0-9-]+/[A-Za-z0-9_-]+(?:/media-video-(?:hvc1|avc1))?/?)$~D', $path, $matches)) {
        return json_encode(['douyin-cdn', $host, $parts['port'] ?? null, $matches[1], $parts['query'] ?? null, $parts['fragment'] ?? null], JSON_UNESCAPED_SLASHES);
    }
    $credentials = [];
    if (in_array($host, ['www.douyin.com', 'aweme.snssdk.com', 'api.amemv.com'], true)
        && in_array(rtrim($path, '/'), ['/aweme/v1/play', '/aweme/v1/play/dash'], true)) $credentials = ['sign', 'biz_sign'];
    elseif ($host === 'f.video.weibocdn.com') $credentials = ['Expires', 'ssig', 'KID'];
    elseif ($host === 'bilivideo.com' || str_ends_with($host, '.bilivideo.com')) $credentials = ['deadline', 'upsig'];
    if (!$credentials || !isset($parts['query'])) return $url;
    // Keep duplicate parameters, their order and exact values; sorting duplicates
    // or using parse_str could identify different last-value-wins resources as one.
    $query = array_values(array_filter(explode('&', $parts['query']), static fn ($pair) => !in_array(rawurldecode(explode('=', $pair, 2)[0]), $credentials, true)));
    $base = explode('?', $url, 2)[0];
    return $base . ($query ? '?' . implode('&', $query) : '') . (isset($parts['fragment']) ? '#' . $parts['fragment'] : '');
}

function snapSources(array $raw): array
{
    $sources = [];
    foreach ($raw as $entry) {
        $source = snapSource($entry); if (!$source) continue;
        $identity = is_array($entry) ? snapText($entry['private_source_identity'] ?? null) : null;
        $identity ??= snapSourceIdentity($source['url']);
        $source['id'] = 's-' . substr(hash('sha256', $identity), 0, 24); $sources[] = $source;
    }
    return snapMergeSources([], $sources);
}

/** Select one actual credential for a proven source, never extend its expiry or
 * combine the URL from one response with metadata from another response.
 */
function snapMergeSources(array $existing, array $additional): array
{
    $merged = []; $now = time();
    $rank = static fn ($source) => [snapSourceUsable($source, $now) ? 1 : 0,
        ($source['availability'] ?? '') === 'available' ? 1 : 0,
        isset($source['expires_at']) ? strtotime($source['expires_at']) : 0];
    foreach (array_merge($existing, $additional) as $source) {
        $id = $source['id'];
        if (!isset($merged[$id]) || $rank($source) > $rank($merged[$id])) $merged[$id] = $source;
    }
    return array_values($merged);
}

/** A file track's source identities, without time-dependent URLs or metadata. */
function snapResourceIdentity(array $resource): array
{
    $delivery = $resource['delivery'];
    $sources = array_column($delivery['sources'], 'id'); sort($sources, SORT_STRING);
    return [$resource['role'], $delivery['kind'], $sources];
}

function snapCandidateMetadata(array $raw): array
{
    $metadata = snapVideoFacts($raw) + snapAudioFacts($raw);
    foreach (['width' => 'width', 'height' => 'height', 'bitrate_bps' => 'bitrate_bps', 'video_bitrate_bps' => 'video_bitrate_bps',
        'audio_bitrate_bps' => 'audio_bitrate_bps', 'sample_rate_hz' => 'sample_rate_hz', 'audio_channels' => 'audio_channels'] as $from => $to) {
        if (is_numeric($raw[$from] ?? null) && $raw[$from] > 0) $metadata[$to] = (int)round($raw[$from]);
    }
    if (is_numeric($raw['bit_rate'] ?? null) && $raw['bit_rate'] > 0) {
        $trackBitrate = in_array($raw['metadata_source'] ?? '', ['mp4', 'probe'], true) || ($raw['private_delivery_kind'] ?? '') === 'video_track';
        $metadata[$trackBitrate ? 'video_bitrate_bps' : 'bitrate_bps'] = (int)round($raw['bit_rate']);
    }
    if (is_numeric($raw['fps'] ?? null) && $raw['fps'] > 0) $metadata['fps'] = (float)$raw['fps'];
    if (is_numeric($raw['duration_ms'] ?? null) && $raw['duration_ms'] > 0) $metadata['duration_ms'] = (int)round($raw['duration_ms']);
    elseif (is_numeric($raw['duration'] ?? null) && $raw['duration'] > 0) $metadata['duration_ms'] = (int)round($raw['duration'] * 1000);
    foreach (['codec' => 'video_codec', 'video_codec' => 'video_codec', 'audio_codec' => 'audio_codec', 'container' => 'container', 'extension' => 'extension', 'mime_type' => 'mime_type'] as $from => $to) {
        if ($value = snapText($raw[$from] ?? null)) $metadata[$to] = $value;
    }
    if (is_bool($raw['has_audio'] ?? null)) $metadata['has_audio'] = $raw['has_audio'];
    if (!isset($metadata['extension']) && isset($metadata['container']) && in_array($metadata['container'], ['mp4', 'mov', 'webm', 'mkv', 'mp3', 'm4a', 'aac', 'flac'], true)) $metadata['extension'] = $metadata['container'];
    if ($metadata) $metadata['evidence'] = in_array($raw['metadata_source'] ?? '', ['mp4', 'probe'], true) ? 'probe' : 'upstream';
    return $metadata;
}

/** A proven media identity shares facts, not input order. Missing facts can be
 * filled, but contradictory observations must remain visible and non-authoritative.
 */
function snapMergeMetadata(array $existing, array $additional): array
{
    $observations = [];
    foreach ([$existing, $additional] as $metadata) {
        foreach ($metadata as $field => $value) {
            if (in_array($field, ['evidence', 'field_evidence', 'field_conflicts'], true)) continue;
            $evidence = $metadata['field_evidence'][$field] ?? $metadata['evidence'] ?? 'upstream';
            $observations[$field][] = ['value' => $value, 'evidence' => $evidence];
        }
        foreach ($metadata['field_conflicts'] ?? [] as $field => $facts) $observations[$field] = array_merge($observations[$field] ?? [], $facts);
    }
    ksort($observations, SORT_STRING);
    $merged = []; $conflicts = []; $fieldEvidence = [];
    foreach ($observations as $field => $facts) {
        $unique = [];
        foreach ($facts as $fact) {
            $key = json_encode($fact['value'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            // Agreement with a probe strengthens the same fact. It never erases
            // a different upstream observation about this identity.
            if (!isset($unique[$key]) || $fact['evidence'] === 'probe') $unique[$key] = $fact;
        }
        ksort($unique, SORT_STRING);
        if (count($unique) > 1) { $conflicts[$field] = array_values($unique); continue; }
        $fact = reset($unique); $merged[$field] = $fact['value'];
        $fieldEvidence[$field] = $fact['evidence'];
    }
    if ($conflicts) $merged['field_conflicts'] = $conflicts;
    if ($fieldEvidence) {
        $evidence = array_values(array_unique($fieldEvidence));
        $merged['evidence'] = count($evidence) === 1 ? $evidence[0] : 'mixed';
        if (count($evidence) > 1) $merged['field_evidence'] = $fieldEvidence;
    }
    return $merged;
}

/** Only an upstream representation identity can join flattened CDN alternatives.
 * Similar geometry/codec/bitrate does not establish byte-equivalent media.
 */
function snapFileVariants(array $candidates): array
{
    $variants = []; $keys = []; $stableIdentities = []; $trackAudio = [];
    foreach ($candidates as $index => $candidate) {
        $candidate = is_string($candidate) ? ['url' => $candidate] : $candidate;
        if (!is_array($candidate)) continue;
        $sources = snapSources(is_array($candidate['sources'] ?? null) ? $candidate['sources'] : [$candidate]);
        if (!$sources) continue;
        // Explicit sources represent this same file, so its measured byte length
        // applies to each CDN alternative even when the upstream lists it once.
        $size = $candidate['size_bytes'] ?? $candidate['size'] ?? null;
        if (is_numeric($size) && $size > 0) foreach ($sources as &$source) $source['size_bytes'] ??= (int)$size;
        unset($source);
        $metadata = snapCandidateMetadata($candidate);
        $original = !empty($candidate['is_original']);
        $extension = strtolower(pathinfo((string)parse_url($sources[0]['url'], PHP_URL_PATH), PATHINFO_EXTENSION));
        $kind = $candidate['protocol'] ?? match ($extension) { 'm3u8' => 'hls', 'mpd' => 'dash', default => 'file' };
        if (!in_array($kind, ['file', 'hls', 'dash'], true)) continue;
        $mediaIdentity = snapText($candidate['private_media_identity'] ?? null);
        $representation = $mediaIdentity ?? snapText($candidate['private_representation_id'] ?? null);
        $track = ($candidate['private_delivery_kind'] ?? '') === 'video_track';
        $signature = $representation === null ? null : json_encode([$kind, $track, $representation]);
        if ($signature !== null && isset($keys[$signature])) {
            $n = $keys[$signature];
            $variants[$n]['delivery']['sources'] = snapMergeSources($variants[$n]['delivery']['sources'], $sources);
            $merged = snapMergeMetadata($variants[$n]['metadata'] ?? [], $metadata);
            if ($merged) $variants[$n]['metadata'] = $merged;
            // Each entry was already matched to its explicit audio_file_id by
            // the platform adapter; merge those options, never global audio.
            if ($track) $trackAudio[$n] = array_merge($trackAudio[$n], $candidate['private_audio_candidates'] ?? []);
            continue;
        }
        $variant = ['delivery' => ['kind' => $kind, 'sources' => $sources]];
        if ($kind !== 'file') $variant['delivery']['scope'] = $candidate['scope'] ?? 'single';
        if ($original) $variant['provenance'] = 'original_endpoint';
        if ($metadata) $variant['metadata'] = $metadata;
        if ($label = snapText($candidate['label'] ?? $candidate['quality'] ?? null)) $variant['label'] = $label;
        if ($signature !== null) $keys[$signature] = count($variants);
        $stableIdentities[count($variants)] = $mediaIdentity;
        if ($track) $trackAudio[count($variants)] = $candidate['private_audio_candidates'] ?? [];
        $variants[] = $variant;
    }
    $identified = []; $audioByVariant = [];
    foreach ($variants as $index => $variant) {
        $sourceIds = array_column($variant['delivery']['sources'], 'id'); sort($sourceIds, SORT_STRING);
        $identity = [$variant['delivery']['kind'], array_key_exists($index, $trackAudio), $stableIdentities[$index] ?? $sourceIds];
        $id = $variant['id'] = 'v-' . substr(hash('sha256', json_encode($identity)), 0, 24);
        if (isset($identified[$id])) {
            $identified[$id]['delivery']['sources'] = snapMergeSources($identified[$id]['delivery']['sources'], $variant['delivery']['sources']);
            $merged = snapMergeMetadata($identified[$id]['metadata'] ?? [], $variant['metadata'] ?? []);
            if ($merged) $identified[$id]['metadata'] = $merged;
        }
        else $identified[$id] = $variant;
        if (array_key_exists($index, $trackAudio)) $audioByVariant[$id] = array_merge($audioByVariant[$id] ?? [], $trackAudio[$index]);
    }
    $complete = [];
    foreach ($identified as $id => $variant) {
        if (!array_key_exists($id, $audioByVariant)) { $complete[] = $variant; continue; }
        $video = ['id' => 'video', 'role' => 'video', 'delivery' => $variant['delivery']];
        if (isset($variant['metadata'])) $video['metadata'] = $variant['metadata'];
        $audioOptions = snapFileVariants($audioByVariant[$id]);
        if (!$audioOptions) {
            $complete[] = ['id' => $variant['id'], 'state' => 'deferred', 'reason' => ['code' => 'MISSING_AUDIO_TRACK', 'message' => '未取得可确认的完整音视频组合，暂不可下载']];
            continue;
        }
        foreach ($audioOptions as $audio) {
            $resource = ['id' => 'audio', 'role' => 'audio', 'delivery' => $audio['delivery']];
            if (isset($audio['metadata'])) $resource['metadata'] = $audio['metadata'];
            $combined = $variant; $combined['id'] .= '-' . $audio['id'];
            $combined['delivery'] = ['kind' => 'mux', 'resources' => [$video, $resource], 'output' => ['container' => 'mp4', 'extension' => 'mp4', 'mime_type' => 'video/mp4']];
            $complete[] = $combined;
        }
    }
    return $complete;
}

function snapResolveUrl(string $url, string $itemId): string
{
    return '/api/resolve?' . http_build_query(['schema_version' => '1.0', 'url' => $url, 'item_id' => $itemId], '', '&', PHP_QUERY_RFC3986);
}

function snapWorkMetadata(string $platform, array $raw, string $url): array
{
    $data = ['platform' => $platform, 'source_url' => $url, 'items' => [],
        'refresh_url' => '/api/parse?' . http_build_query(['schema_version' => '1.0', 'url' => $url], '', '&', PHP_QUERY_RFC3986)];
    foreach (['id' => 'content_id', 'title' => 'title', 'desc' => 'description', 'description' => 'description'] as $from => $to) {
        if ($value = snapText($raw[$from] ?? null)) $data[$to] = $value;
    }
    if ($cover = snapSource($raw['cover'] ?? null)) $data['cover'] = $cover;
    $author = is_array($raw['author'] ?? null) ? $raw['author'] : ['name' => $raw['author'] ?? '', 'avatar' => $raw['avatar'] ?? ''];
    $authorOut = [];
    foreach (['id', 'name', 'description'] as $key) if (($value = snapText($author[$key] ?? null)) !== null) $authorOut[$key] = $value;
    if ($avatar = snapSource($author['avatar'] ?? null)) $authorOut['avatar'] = $avatar;
    if ($profile = snapMediaUrl($author['url'] ?? null)) $authorOut['url'] = $profile;
    if ($authorOut) $data['author'] = $authorOut;
    $timestamp = $raw['create_time'] ?? $raw['time'] ?? null;
    if (is_numeric($timestamp) && $timestamp > 0) {
        if ($timestamp > 100000000000) $timestamp /= 1000;
        $data['published_at'] = gmdate('Y-m-d\TH:i:s\Z', (int)$timestamp);
    }
    $stats = $raw['extra']['statistics'] ?? [];
    if (array_key_exists('like', $raw)) $stats['digg_count'] = $raw['like'];
    foreach (['play_count' => 'plays', 'view_count' => 'views', 'digg_count' => 'likes', 'comment_count' => 'comments', 'share_count' => 'shares', 'collect_count' => 'saves'] as $from => $to) {
        if (is_numeric($stats[$from] ?? null) && $stats[$from] >= 0) {
            $data['statistics'][$to] = ['value' => (int)$stats[$from]];
            if ($platform === 'douyin' && $to === 'plays' && (int)$stats[$from] === 0) $data['statistics'][$to]['state'] = 'unverified';
        }
    }
    $tags = array_merge(is_array($raw['extra']['hashtags'] ?? null) ? $raw['extra']['hashtags'] : [], is_array($raw['extra']['video_tags'] ?? null) ? $raw['extra']['video_tags'] : []);
    $tags = array_values(array_unique(array_filter(array_map('snapText', $tags), static fn ($s) => $s !== null)));
    if ($tags) $data['tags'] = $tags;
    $music = is_string($raw['music'] ?? null) ? ['url' => $raw['music']] : ($raw['music'] ?? []);
    if (is_array($music) && ($source = snapSource($music['url'] ?? null))) {
        $attachment = ['id' => 'background-audio', 'role' => 'background_audio', 'resource' => ['id' => 'audio', 'role' => 'audio', 'delivery' => ['kind' => 'file', 'sources' => [$source]]]];
        if ($title = snapText($music['title'] ?? $music['name'] ?? null)) $attachment['title'] = $title;
        if ($name = snapText($music['author'] ?? $music['artist'] ?? null)) $attachment['author'] = ['name' => $name];
        if ($cover = snapSource($music['cover'] ?? null)) $attachment['cover'] = $cover;
        $data['attachments'] = [$attachment];
    }
    return $data;
}

function snapSimpleAdapter(string $platform, array $raw, string $url): array
{
    $data = snapWorkMetadata($platform, $raw, $url);
    $pairs = [];
    foreach (is_array($raw['live_photo'] ?? null) ? $raw['live_photo'] : [] as $live) {
        if (!is_array($live)) continue;
        $image = snapSource($live['image'] ?? null);
        $motions = snapFileVariants($live['video_candidates'] ?? [['url' => $live['video'] ?? '']]);
        if ($image && $motions) $pairs[$image['url']] = [$image, $motions];
    }
    $images = is_array($raw['images'] ?? null) ? $raw['images'] : [];
    // The adapter receives a known image response; a cover is never made an album item.
    if (!$images && ($raw['type'] ?? '') === 'image' && snapMediaUrl($raw['url'] ?? null)) $images = [$raw['url']];
    $imageUrls = [];
    foreach (array_merge($images, array_keys($pairs)) as $i => $picture) {
        $source = snapSource($picture); if (!$source || isset($imageUrls[$source['url']])) continue;
        $imageUrls[$source['url']] = true;
        $id = 'image-' . (count($imageUrls));
        $item = ['id' => $id, 'type' => 'image', 'index' => count($imageUrls), 'default' => null,
            'variants' => [['id' => 'main', 'delivery' => ['kind' => 'file', 'sources' => [$source]]]]];
        if (isset($pairs[$source['url']])) {
            [$still, $motions] = $pairs[$source['url']]; $item['id'] = 'live-' . count($imageUrls); $item['type'] = 'live_photo';
            $item['variants'] = [];
            foreach ($motions as $motion) {
                $resource = ['id' => 'motion', 'role' => 'motion', 'delivery' => $motion['delivery']];
                if (isset($motion['metadata'])) $resource['metadata'] = $motion['metadata'];
                $variant = ['id' => 'pair-' . $motion['id'], 'delivery' => ['kind' => 'pair', 'resources' => [
                    ['id' => 'image', 'role' => 'image', 'delivery' => ['kind' => 'file', 'sources' => [$still]]], $resource,
                ]]];
                foreach (['metadata', 'provenance', 'label'] as $key) if (isset($motion[$key])) $variant[$key] = $motion[$key];
                $item['variants'][] = $variant;
            }
            $item['cover'] = $still;
        }
        $item['resolve_url'] = snapResolveUrl($url, $item['id']); $data['items'][] = $item;
    }
    if (($raw['type'] ?? '') !== 'image' && (snapMediaUrl($raw['url'] ?? null) || !empty($raw['video_candidates']))) {
        $candidates = is_array($raw['video_candidates'] ?? null) ? $raw['video_candidates'] : array_merge([$raw], is_array($raw['video_backup'] ?? null) ? $raw['video_backup'] : []);
        $variants = snapFileVariants($candidates);
        if ($variants) {
            $item = ['id' => 'video', 'type' => 'video', 'default' => null, 'variants' => $variants, 'resolve_url' => snapResolveUrl($url, 'video')];
            if (isset($data['cover'])) $item['cover'] = $data['cover'];
            if (is_numeric($raw['duration'] ?? null) && $raw['duration'] > 0) $item['duration_ms'] = (int)round($raw['duration'] * 1000);
            array_unshift($data['items'], $item);
        }
    }
    if (count($data['items']) > 1) {
        $data['default_item_id'] = $data['items'][0]['id'];
        $album = array_column(array_filter($data['items'], static fn ($i) => $i['type'] !== 'video'), 'id');
        if ($album) $data['groups'] = [['id' => 'album', 'kind' => 'album', 'item_ids' => array_values($album), 'complete' => true]];
    }
    return $data;
}

function snapAdaptDouyin(array $raw, string $url): array {
    if (snapMediaUrl($raw['url'] ?? null)) {
        $raw['video_candidates'] = array_merge([$raw], $raw['video_backup'] ?? []);
        foreach ($raw['video_candidates'] as &$candidate) {
            if (($candidate['private_delivery_kind'] ?? '') !== 'video_track') continue;
            $audioId = $candidate['private_audio_id'] ?? '';
            $candidate['private_audio_candidates'] = array_values(array_filter($raw['private_audio_candidates'] ?? [], static fn ($a) => $audioId !== '' && ($a['private_audio_id'] ?? null) === $audioId));
        }
        unset($candidate);
    }
    return snapSimpleAdapter('douyin', $raw, $url);
}
function snapAdaptKuaishou(array $raw, string $url): array { return snapSimpleAdapter('kuaishou', $raw, $url); }
function snapAdaptXiaohongshu(array $raw, string $url): array {
    foreach (['like_count' => 'digg_count', 'comment_count' => 'comment_count', 'share_count' => 'share_count', 'collect_count' => 'collect_count'] as $from => $to) {
        if (array_key_exists($from, $raw['statistics'] ?? [])) $raw['extra']['statistics'][$to] = $raw['statistics'][$from];
    }
    return snapSimpleAdapter('xiaohongshu', $raw, $url);
}
function snapAdaptToutiao(array $raw, string $url): array {
    $raw['id'] = $raw['itemId'] ?? null;
    $raw['author'] = ['name' => $raw['author'] ?? '', 'id' => $raw['userID'] ?? '', 'avatar' => $raw['avatar'] ?? '', 'description' => $raw['author_description'] ?? ''];
    return snapSimpleAdapter('toutiao', $raw, $url);
}
function snapAdaptWeibo(array $raw, string $url): array {
    // This parser's candidate list already includes its selected main source.
    if (!empty($raw['video_backup'])) $raw['video_candidates'] = $raw['video_backup'];
    return snapSimpleAdapter('weibo', $raw, $url);
}
function snapAdaptPipixia(array $raw, string $url): array { return snapSimpleAdapter('pipixia', $raw, $url); }
function snapAdaptPipigx(array $raw, string $url): array { return snapAdaptMultiVideo('pipigx', $raw, $url); }
function snapAdaptZuiyou(array $raw, string $url): array { return snapAdaptMultiVideo('zuiyou', $raw, $url); }

function snapAdaptMultiVideo(string $platform, array $raw, string $url): array
{
    $data = snapSimpleAdapter($platform, $raw, $url);
    if (empty($raw['private_videos'])) return $data;
    $items = [];
    foreach ($raw['private_videos'] as $index => $video) {
        $variants = snapFileVariants([$video]); if (!$variants) continue;
        $upstreamId = is_array($video) ? snapText($video['private_video_id'] ?? null) : null;
        $id = 'video-' . ($upstreamId !== null ? substr(hash('sha256', $upstreamId), 0, 24) : $index + 1);
        $items[] = ['id' => $id, 'type' => 'video', 'default' => null, 'variants' => $variants, 'resolve_url' => snapResolveUrl($url, $id)];
    }
    if (!$items) return $data;
    $data['items'] = array_merge($items, array_values(array_filter($data['items'], static fn ($item) => $item['type'] !== 'video')));
    $data['default_item_id'] = $items[0]['id'];
    return $data;
}

function snapAdaptBilibili(array $raw, string $url): array
{
    $raw['author'] = $raw['user'] ?? [];
    $data = snapWorkMetadata('bilibili', $raw, $url);
    $bvid = $raw['extra']['bvid']; $current = (int)($raw['extra']['current_page'] ?? 1);
    $data['content_id'] = $bvid;
    foreach ($raw['extra']['pages'] as $n => $page) {
        $number = (int)($page['page'] ?? $n + 1); $id = $bvid . '-p' . $number;
        $pageUrl = 'https://www.bilibili.com/video/' . rawurlencode($bvid) . '/?p=' . $number;
        $item = ['id' => $id, 'type' => 'video', 'index' => $number, 'default' => null, 'source_url' => $pageUrl, 'resolve_url' => snapResolveUrl($pageUrl, $id)];
        if ($title = snapText($page['part'] ?? null)) $item['title'] = $title;
        if (is_numeric($page['duration'] ?? null) && $page['duration'] > 0) $item['duration_ms'] = (int)round($page['duration'] * 1000);
        if ($number === $current) {
            $item['variants'] = snapBilibiliVariants($raw);
            if (!$item['variants']) {
                unset($item['variants'], $item['resolve_url']); $item['state'] = 'unavailable';
                $item['error'] = ['code' => 'CONTENT_UNAVAILABLE', 'message' => '当前分P未提供完整媒体描述'];
            }
        } else $item['state'] = 'deferred';
        $data['items'][] = $item;
    }
    $data['default_item_id'] = $bvid . '-p' . $current;
    $data['groups'] = [['id' => 'parts', 'kind' => 'multipart', 'item_ids' => array_column($data['items'], 'id'), 'complete' => true, 'total_count' => count($data['items'])]];
    $known = array_fill_keys(array_column($data['items'], 'id'), true);
    foreach ($raw['private_collection']['sections'] ?? [] as $sectionIndex => $section) {
        $members = [];
        foreach ($section['episodes'] ?? [] as $episode) {
            $episodeBvid = $episode['bvid'] ?? $episode['arc']['bvid'] ?? '';
            if (!is_string($episodeBvid) || !preg_match('/^BV[a-zA-Z0-9]{10}$/D', $episodeBvid)) continue;
            $id = $episodeBvid . '-p1'; $members[] = $id;
            if (isset($known[$id])) continue;
            $known[$id] = true;
            $pageUrl = 'https://www.bilibili.com/video/' . $episodeBvid . '/?p=1';
            $item = ['id' => $id, 'type' => 'video', 'state' => 'deferred', 'default' => null, 'source_url' => $pageUrl, 'resolve_url' => snapResolveUrl($pageUrl, $id)];
            if ($title = snapText($episode['title'] ?? $episode['arc']['title'] ?? null)) $item['title'] = $title;
            if ($cover = snapSource($episode['arc']['pic'] ?? null)) $item['cover'] = $cover;
            $data['items'][] = $item;
        }
        if ($members) {
            $group = ['id' => 'collection-' . $sectionIndex, 'kind' => 'collection', 'item_ids' => array_values(array_unique($members)), 'complete' => false];
            if ($title = snapText($section['title'] ?? null)) $group['title'] = $title;
            $data['groups'][] = $group;
        }
    }
    return $data;
}

function snapBilibiliVariants(array $raw): array
{
    if (isset($raw['private_error'])) return [];
    $play = $raw['private_play'] ?? [];
    $durl = $play['durl'] ?? [];
    if (!$play) return snapFileVariants([['url' => $raw['url'], 'sources' => array_merge([['url' => $raw['url']]], $raw['video_backup'] ?? []), 'label' => $raw['quality'] ?? '规格未知']]);
    $variants = [];
    if (count($durl) === 1) {
        $part = $durl[0];
        $variants = snapFileVariants([['sources' => array_merge([['url' => $part['url'], 'size' => $part['size'] ?? null]], $part['backup_url'] ?? []), 'label' => $raw['quality'] ?? '规格未知']
            + snapVideoFacts($part) + snapVideoFacts($play) + snapAudioFacts($part) + snapAudioFacts($play)]);
    } elseif (count($durl) > 1) {
        $pieces = [];
        foreach ($durl as $i => $part) {
            $piece = ['index' => $i + 1, 'sources' => snapSources(array_merge([['url' => $part['url'], 'size' => $part['size'] ?? null]], $part['backup_url'] ?? []))];
            if (is_numeric($part['length'] ?? null) && $part['length'] > 0) $piece['duration_ms'] = (int)$part['length']; $pieces[] = $piece;
        }
        $variants[] = ['id' => 'segments', 'delivery' => ['kind' => 'segments', 'pieces' => $pieces, 'join' => 'remux', 'output' => ['container' => 'mp4', 'extension' => 'mp4', 'mime_type' => 'video/mp4']]];
    }
    $audio = $play['dash']['audio'] ?? [];
    foreach ($play['dash']['video'] ?? [] as $i => $track) {
        $video = snapBilibiliTrack($track, 'video', 'video'); if (!$video) continue;
        $audioOptions = [];
        foreach ($audio as $a) if ($resource = snapBilibiliTrack($a, 'audio', 'audio')) $audioOptions[] = $resource;
        $variantId = 'mux-' . substr(hash('sha256', json_encode(snapResourceIdentity($video))), 0, 24);
        // Absence of an audio response is not proof that the work is silent.
        if (!$audioOptions) {
            $variants[] = ['id' => $variantId, 'state' => 'deferred', 'reason' => ['code' => 'MISSING_AUDIO_TRACK', 'message' => '未取得可确认的完整音视频组合，暂不可下载']];
            continue;
        }
        // Audio encodings are alternatives, not simultaneous language tracks.
        // Each complete pairing is independently usable even if another expires.
        foreach ($audioOptions as $audioOption) {
            $id = $variantId . '-' . substr(hash('sha256', json_encode(snapResourceIdentity($audioOption))), 0, 24);
            $variant = ['id' => $id, 'delivery' => ['kind' => 'mux', 'resources' => [$video, $audioOption], 'output' => ['container' => 'mp4', 'extension' => 'mp4', 'mime_type' => 'video/mp4']]];
            if (isset($video['metadata'])) $variant['metadata'] = $video['metadata'];
            $variants[] = $variant;
        }
    }
    return $variants;
}

function snapBilibiliTrack(array $track, string $role, string $id): ?array
{
    $sources = snapSources(array_merge([$track['baseUrl'] ?? $track['base_url'] ?? ''], $track['backupUrl'] ?? $track['backup_url'] ?? []));
    if (!$sources) return null;
    $resource = ['id' => $id, 'role' => $role, 'delivery' => ['kind' => 'file', 'sources' => $sources]];
    $m = ['evidence' => 'upstream'];
    if ($role === 'video') {
        $m += snapVideoFacts($track);
        // These IDs are explicit HDR profiles in the upstream playurl catalogue.
        if (!isset($m['hdr_type']) && in_array((int)($track['id'] ?? 0), [125, 126], true)) $m['hdr_type'] = (int)$track['id'] === 126 ? 'dolby_vision' : 'hdr_unknown';
        foreach (['width', 'height'] as $field) if (is_numeric($track[$field] ?? null) && $track[$field] > 0) $m[$field] = (int)$track[$field];
        if ($codec = snapText($track['codecs'] ?? null)) $m['video_codec'] = $codec;
        if (is_numeric($track['bandwidth'] ?? null) && $track['bandwidth'] > 0) $m['video_bitrate_bps'] = (int)$track['bandwidth'];
    } else {
        $m += snapAudioFacts($track);
        if ($codec = snapText($track['codecs'] ?? null)) $m['audio_codec'] = $codec;
        if (is_numeric($track['bandwidth'] ?? null) && $track['bandwidth'] > 0) $m['audio_bitrate_bps'] = (int)$track['bandwidth'];
    }
    if (count($m) > 1) $resource['metadata'] = $m;
    return $resource;
}
