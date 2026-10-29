<?php
require_once __DIR__ . '/../lib/runtime.php';
/**
 * @Author: JH-Ahua
 * @CreateTime: 2025/10/24 下午10:37
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @Api: api.bugpk.com
 * @tip: 今日头条去水印解析
 */

function toutiaoAllowedUrl(string $url): bool
{
    $parts = parse_url($url);
    $host = strtolower($parts['host'] ?? '');
    return snapMediaUrl($url) !== '' && !preg_match('/[\\\\\x00-\x20\x7f]/', $url)
        && ($host === 'toutiao.com' || str_ends_with($host, '.toutiao.com'))
        && (!isset($parts['port']) || $parts['port'] === (strtolower($parts['scheme'] ?? '') === 'https' ? 443 : 80));
}

/** Only IDs in supported path/query positions count; wid and digits in a host do not. */
function toutiaoVideoId(string $url): ?string
{
    if (!toutiaoAllowedUrl($url)) {
        return null;
    }
    $parts = parse_url($url);
    if (preg_match('~^/(?:video/|group/|i)([0-9]{6,22})/?$~D', $parts['path'] ?? '', $match)) {
        return $match[1];
    }
    parse_str($parts['query'] ?? '', $query);
    foreach (['group_id', 'item_id'] as $key) {
        if (isset($query[$key]) && is_string($query[$key]) && preg_match('/^[0-9]{6,22}$/D', $query[$key])) {
            return $query[$key];
        }
    }
    return null;
}

function toutiaoRedirectUrl(string $current, string $location): ?string
{
    if (str_starts_with($location, '//')) {
        $location = 'https:' . $location;
    } elseif (str_starts_with($location, '/')) {
        $location = 'https://' . parse_url($current, PHP_URL_HOST) . $location;
    }
    return toutiaoAllowedUrl($location) ? $location : null;
}

/** Bounded metadata requests. Anonymous ttwid stays in memory for this parse only. */
function toutiaoRequest(string $url, array $options = []): array
{
    $ch = curl_init($url);
    $location = '';
    $ttwid = '';
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_TIMEOUT => max(1, min(20, (int)($options['timeout'] ?? 20))),
        CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        CURLOPT_HEADERFUNCTION => static function ($handle, string $header) use (&$location, &$ttwid): int {
            if (preg_match('/^Location:\s*(.*?)\s*$/i', $header, $match)) {
                $location = $match[1];
            }
            if (preg_match('/^Set-Cookie:\s*ttwid=([^;\r\n]{1,8192})/i', $header, $match)) {
                $ttwid = $match[1];
            }
            return strlen($header);
        },
    ]);
    if (isset($options['json'])) {
        curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => json_encode($options['json']), CURLOPT_HTTPHEADER => ['Content-Type: application/json']]);
    }
    if (isset($options['ttwid'])) {
        curl_setopt($ch, CURLOPT_COOKIE, 'ttwid=' . $options['ttwid']);
    }
    $body = snapCurlExec($ch, isset($options['json']) ? 65536 : 2 * 1024 * 1024);
    $result = ['ok' => $body !== false, 'status' => (int)curl_getinfo($ch, CURLINFO_HTTP_CODE), 'body' => $body === false ? '' : $body, 'location' => $location, 'ttwid' => $ttwid];
    curl_close($ch);
    return $result;
}

function toutiao(string $url, ?callable $request = null, ?callable $clock = null): array
{
    if (!toutiaoAllowedUrl($url)) {
        return ['code' => 400, 'msg' => '请提供有效的今日头条视频链接'];
    }
    $transport = $request ?? 'toutiaoRequest';
    $clock ??= static fn (): float => hrtime(true) / 1e9;
    $deadline = $clock() + 35;
    // Share redirects, anonymous initialization and page retrieval share one budget,
    // leaving room for the aggregate gateway's 45-second timeout.
    $request = static function (string $target, array $options) use ($transport, $clock, $deadline): array {
        $remaining = (int)floor($deadline - $clock());
        if ($remaining < 1) {
            return ['ok' => false, 'status' => 0, 'budget_exhausted' => true];
        }
        $options['timeout'] = min(20, $remaining);
        return $transport($target, $options);
    };
    $id = toutiaoVideoId($url);
    for ($redirect = 0; $id === null && $redirect < 3; $redirect++) {
        $response = $request($url, []);
        if (!($response['ok'] ?? false)) {
            return ['code' => 502, 'msg' => !empty($response['budget_exhausted']) ? '今日头条解析超时，请稍后重试' : '今日头条分享链接请求失败，请稍后重试'];
        }
        if (($response['status'] ?? 0) < 300 || ($response['status'] ?? 0) >= 400) {
            break;
        }
        $url = toutiaoRedirectUrl($url, $response['location'] ?? '');
        if ($url === null) {
            return ['code' => 400, 'msg' => '今日头条分享链接重定向地址无效'];
        }
        $id = toutiaoVideoId($url);
    }
    if ($id === null) {
        return ['code' => 400, 'msg' => '无法识别视频 ID，请复制今日头条视频页面链接'];
    }

    // Public anonymous session initialization, not a user's login Cookie.
    // Flow reference: https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/toutiao.py
    $session = $request('https://ttwid.bytedance.com/ttwid/union/register/', ['json' => ['aid' => 24, 'needFid' => false, 'region' => 'cn', 'service' => 'www.toutiao.com', 'union' => true]]);
    if (!($session['ok'] ?? false) || ($session['status'] ?? 0) !== 200 || empty($session['ttwid'])) {
        return ['code' => 502, 'msg' => !empty($session['budget_exhausted']) ? '今日头条解析超时，请稍后重试' : '今日头条匿名会话初始化失败，请稍后重试'];
    }
    $response = $request('https://www.toutiao.com/video/' . $id . '/', ['ttwid' => $session['ttwid']]);
    if (!($response['ok'] ?? false)) {
        return ['code' => 502, 'msg' => !empty($response['budget_exhausted']) ? '今日头条解析超时，请稍后重试' : '今日头条页面请求失败，请稍后重试'];
    }
    if (in_array($response['status'] ?? 0, [403, 429], true)) {
        return ['code' => 429, 'msg' => '今日头条限制了本次访问，请稍后重试'];
    }
    if (($response['status'] ?? 0) === 404) {
        return ['code' => 404, 'msg' => '今日头条视频页面不存在或不可访问'];
    }
    if (($response['status'] ?? 0) !== 200) {
        return ['code' => 502, 'msg' => '今日头条页面暂时不可用，请稍后重试'];
    }
    return toutiaoResponseFromPage($response['body'], $id);
}

function toutiaoMediaUrl($value): string
{
    $url = snapMediaUrl($value);
    if ($url !== '' || !is_string($value)) {
        return $url;
    }
    $decoded = base64_decode($value, true);
    return $decoded === false ? '' : snapMediaUrl($decoded);
}

function toutiaoCandidates(array $list): array
{
    $candidates = [];
    foreach ($list as $entry) {
        if (!is_array($entry)) {
            continue;
        }
        $meta = is_array($entry['video_meta'] ?? null) ? $entry['video_meta'] : $entry;
        $fields = [];
        foreach (['width' => 'vwidth', 'height' => 'vheight', 'bit_rate' => 'real_bitrate', 'size' => 'size'] as $out => $key) {
            $value = $meta[$key] ?? ($out === 'bit_rate' ? ($meta['bitrate'] ?? null) : null);
            if (is_numeric($value) && (float)$value > 0) {
                $fields[$out] = (int)$value;
            }
        }
        if (is_string($meta['codec_type'] ?? null) && $meta['codec_type'] !== '') {
            $fields['codec'] = $meta['codec_type'];
        }
        $fields['quality'] = isset($fields['width'], $fields['height']) ? min($fields['width'], $fields['height']) . 'p' : 'unknown';
        if ($fields['quality'] === 'unknown' && is_string($meta['definition'] ?? null) && preg_match('/^[0-9]{3,4}p$/D', $meta['definition'])) {
            $fields['quality'] = $meta['definition'];
        }
        foreach (['main_url', 'backup_url', 'backup_url_1', 'backup_url_2'] as $key) {
            $url = toutiaoMediaUrl($entry[$key] ?? null);
            if ($url !== '' && !isset($candidates[$url])) {
                $candidates[$url] = ['url' => $url] + $fields;
            }
        }
    }
    $candidates = array_values($candidates);
    usort($candidates, static function (array $a, array $b): int {
        return (($b['width'] ?? 0) * ($b['height'] ?? 0)) <=> (($a['width'] ?? 0) * ($a['height'] ?? 0))
            ?: ($b['bit_rate'] ?? 0) <=> ($a['bit_rate'] ?? 0)
            ?: ($b['size'] ?? 0) <=> ($a['size'] ?? 0);
    });
    return $candidates;
}

function toutiaoResponseFromPage(string $html, string $id): array
{
    if (!preg_match('~<script\b[^>]*\sid\s*=\s*(["\x27])RENDER_DATA\1[^>]*>(.*?)</script\s*>~is', $html, $match)) {
        if (str_contains($html, '__ac_signature') || str_contains($html, '验证码')) {
            return ['code' => 429, 'msg' => '今日头条返回了访问验证页，请稍后重试'];
        }
        return ['code' => 404, 'msg' => '今日头条页面未提供视频数据'];
    }
    $json = trim($match[2]);
    $decoded = json_decode(str_starts_with($json, '{') ? $json : rawurldecode($json), true, 512, JSON_BIGINT_AS_STRING);
    if (!is_array($decoded)) {
        return ['code' => 502, 'msg' => '今日头条视频数据格式异常'];
    }
    $root = $decoded['data'] ?? null;
    $video = is_array($root) ? ($root['initialVideo'] ?? null) : null;
    if (!is_array($video) || (isset($root['itemId']) && (!is_scalar($root['itemId']) || (string)$root['itemId'] !== $id))
        || (isset($video['itemId']) && (!is_scalar($video['itemId']) || (string)$video['itemId'] !== $id))) {
        return ['code' => 404, 'msg' => '今日头条页面未提供该视频数据'];
    }
    $play = is_array($video['videoPlayInfo'] ?? null) ? $video['videoPlayInfo'] : [];
    $candidates = toutiaoCandidates(is_array($play['video_list'] ?? null) ? $play['video_list'] : []);
    if (!$candidates) {
        return ['code' => 404, 'msg' => '今日头条未返回可用视频地址'];
    }
    $user = $video['itemCell']['userInfo'] ?? $video['userInfo'] ?? [];
    $user = is_array($user) ? $user : [];
    $data = ['itemId' => $id, 'videoType' => 'video', 'title' => is_string($video['title'] ?? null) ? $video['title'] : '',
        'author' => is_string($user['name'] ?? null) ? $user['name'] : '',
        'userID' => is_scalar($user['userID'] ?? $user['userId'] ?? null) ? (string)($user['userID'] ?? $user['userId']) : '',
        'avatar' => snapMediaUrl($user['avatarURL'] ?? $user['avatarUrl'] ?? null),
        'cover' => snapMediaUrl($video['coverUrl'] ?? $video['poster'] ?? null),
        'video_backup' => array_slice($candidates, 1)] + $candidates[0];
    if (is_string($user['description'] ?? null)) {
        $data['description'] = $user['description'];
    }
    if (is_array($video['itemCell']['videoAbility']['music'] ?? null)) {
        $data['music'] = $video['itemCell']['videoAbility']['music'];
    }
    $duration = $play['video_duration'] ?? $video['duration'] ?? null;
    if (is_numeric($duration) && (float)$duration > 0) {
        $data['duration'] = (float)$duration;
    }
    if (is_numeric($video['publishTime'] ?? null) && (int)$video['publishTime'] > 0) {
        $data['create_time'] = (int)$video['publishTime'];
        $data['publish_time'] = date('Y-m-d H:i:s', $data['create_time']);
    }
    foreach (['diggCount' => 'digg_count', 'commentCount' => 'comment_count', 'repinCount' => 'collect_count', 'playCount' => 'play_count'] as $in => $out) {
        if (is_numeric($video[$in] ?? null) && (float)$video[$in] >= 0) {
            $data['extra']['statistics'][$out] = (int)$video[$in];
        }
    }
    return ['code' => 200, 'msg' => '解析成功', 'data' => $data];
}

if (!defined('DOKITOOL_PARSER_LIBRARY_ONLY')) {
    header('Access-Control-Allow-Origin: *');
    header('Content-Type: application/json; charset=utf-8');
    $url = $_GET['url'] ?? '';
    $result = is_string($url) && $url !== '' ? toutiao($url) : ['code' => 201, 'msg' => 'url为空'];
    echo json_encode($result, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
}
