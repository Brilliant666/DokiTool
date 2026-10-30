<?php
require_once __DIR__ . '/../../lib/runtime.php';
require_once __DIR__ . '/XiaohongshuMediaProbe.php';
/**
*@Author: JH-Ahua
*@CreateTime: 2026/5/9 10:24
*@email: admin@bugpk.com
*@blog: www.jiuhunwl.cn
*@Api: api.bugpk.com
*@tip: 整合图文、视频、实况解析
*/

class XiaohongshuParser
{
    private $pageRequest;
    private $mediaProbe;
    private string $cookie = '';
    private const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

    public function __construct(?callable $pageRequest = null, ?callable $mediaProbe = null)
    {
        $this->pageRequest = $pageRequest ?? [$this, 'request'];
        $this->mediaProbe = $mediaProbe ?? static fn (string $url, float $deadline): array => (new XiaohongshuMediaProbe())->inspect($url, $deadline);
    }

    private function output(int $code, string $message, array $data = []): string
    {
        return json_encode(['code' => $code, 'msg' => $message, 'data' => $data], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    }

    public function setCookie(string $cookie): void { $this->cookie = $cookie; }

    private static function pageAllowed(string $url): bool
    {
        $p = parse_url($url);
        return $p && filter_var($url, FILTER_VALIDATE_URL) && !preg_match('/[\\\\\x00-\x20\x7f]/', $url)
            && in_array($p['scheme'] ?? '', ['http', 'https'], true)
            && !isset($p['user']) && !isset($p['pass'])
            && (!isset($p['port']) || in_array($p['port'], [80, 443], true))
            && in_array(strtolower($p['host'] ?? ''), ['xiaohongshu.com', 'www.xiaohongshu.com', 'rednote.com', 'www.rednote.com', 'xhslink.com', 'www.xhslink.com', 'xhs.com', 'www.xhs.com'], true);
    }

    /** Fetch desktop HTML; each redirect is checked, cookies are opt-in and never harvested. */
    private function request(string $url): array
    {
        $deadline = microtime(true) + 10;
        for ($redirects = 0; $redirects <= 5 && self::pageAllowed($url); $redirects++) {
            $remaining = (int)(($deadline - microtime(true)) * 1000);
            if ($remaining < 1) break;
            $headers = [];
            $ch = curl_init($url);
            curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_TIMEOUT_MS => $remaining, CURLOPT_ENCODING => '',
                CURLOPT_HTTPHEADER => ['User-Agent: ' . self::UA, 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8'],
                CURLOPT_HEADERFUNCTION => static function ($handle, string $line) use (&$headers): int {
                    if (str_starts_with($line, 'HTTP/')) $headers = [];
                    elseif (str_contains($line, ':')) { [$key, $value] = explode(':', $line, 2); $headers[strtolower(trim($key))] = trim($value); }
                    return strlen($line);
                },
            ]);
            if ($this->cookie !== '') curl_setopt($ch, CURLOPT_COOKIE, $this->cookie);
            $body = snapCurlExec($ch);
            $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            $error = curl_errno($ch);
            curl_close($ch);
            if (in_array($status, [301, 302, 303, 307, 308], true) && isset($headers['location'])) {
                $next = $headers['location'];
                if (str_starts_with($next, '//')) $next = 'https:' . $next;
                elseif (str_starts_with($next, '/')) $next = 'https://' . parse_url($url, PHP_URL_HOST) . $next;
                if (!self::pageAllowed($next)) return ['status' => 502, 'body' => '', 'url' => $url];
                $url = $next;
                continue;
            }
            return ['status' => $status, 'body' => is_string($body) ? $body : '', 'url' => $url, 'transport_error' => $error];
        }
        return ['status' => 502, 'body' => '', 'url' => $url];
    }

    private static function extractId(string $url): ?string
    {
        return preg_match('~/(?:discovery/item|explore|item|note)/([a-zA-Z0-9]+)(?:/|$)~', parse_url($url, PHP_URL_PATH) ?? '', $m) ? $m[1] : null;
    }

    /** Change only the authority. Signed query bytes must not be decoded/re-encoded. */
    private static function desktopUrl(string $url, string $host): string
    {
        return preg_replace('~^https?://[^/?#]+~i', 'https://' . $host, $url);
    }

    public function parse($url): string
    {
        if (!is_string($url) || !self::pageAllowed($url)) return $this->output(400, '请输入有效的小红书或 rednote 分享链接');
        $host = strtolower((string)parse_url($url, PHP_URL_HOST));
        if (in_array($host, ['xhs.com', 'www.xhs.com'], true)) $url = self::desktopUrl($url, 'xhslink.com');
        $id = self::extractId($url);
        if (!$id) {
            $redirected = ($this->pageRequest)($url);
            $url = $redirected['url'] ?? '';
            if (!self::pageAllowed($url) || !($id = self::extractId($url))) return $this->output(400, '分享链接未指向可识别的笔记');
        }
        $urls = array_values(array_unique([self::desktopUrl($url, 'www.rednote.com'), self::desktopUrl($url, 'www.xiaohongshu.com')]));
        $lastStatus = 0;
        foreach ($urls as $pageUrl) {
            $response = ($this->pageRequest)($pageUrl);
            $lastStatus = $response['status'] ?? 0;
            if ($lastStatus !== 200) continue;
            $note = self::extractNote($response['body'] ?? '', $id);
            if ($note !== null) return $this->output(200, '解析成功', $this->formatNoteData($note));
        }
        $code = $lastStatus === 0 || $lastStatus >= 500 ? 502 : (in_array($lastStatus, [403, 429], true) ? $lastStatus : 404);
        return $this->output($code,
            '未取得可用笔记内容，请检查分享 token 是否有效；来源可能要求验证或暂时限制访问');
    }

    private static function extractNote(string $html, string $id): ?array
    {
        if (!preg_match('~window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*;?\s*</script>~i', $html, $m)) return null;
        // Normalize only known empty JS values outside strings; never evaluate page code.
        $json = preg_replace_callback('/"(?:\\\\.|[^"\\\\])*"|\bundefined\b|\bnew (?:Set|Map)\(\[\]\)/',
            static fn (array $m): string => match ($m[0]) { 'undefined' => 'null', 'new Set([])' => '[]', 'new Map([])' => '{}', default => $m[0] }, $m[1]);
        $state = json_decode($json, true);
        $note = $state['note']['noteDetailMap'][$id]['note'] ?? $state['noteData']['data']['noteData'] ?? null;
        if (!is_array($note) || !$note || (isset($note['noteId']) && (string)$note['noteId'] !== $id)) return null;
        return $note;
    }

    /** Keep only metadata belonging to this representation, never source_dimension. */
    private static function streamCandidate(array $stream, ?string $codec = null): ?array
    {
        $url = snapMediaUrl($stream['masterUrl'] ?? $stream['master_url'] ?? $stream['url'] ?? '');
        if ($url === '') return null;
        $candidate = ['url' => $url, 'metadata_source' => 'upstream', 'sources' => [['url' => $url]]];
        foreach (['width' => ['width'], 'height' => ['height'], 'bit_rate' => ['avgBitrate', 'videoBitrate', 'video_bitrate', 'avg_bitrate', 'bitrate'], 'size' => ['size', 'sizeBytes', 'size_bytes']] as $out => $keys) {
            foreach ($keys as $key) if (is_numeric($stream[$key] ?? null) && (float)$stream[$key] > 0) { $candidate[$out] = (int)$stream[$key]; break; }
        }
        if (is_numeric($stream['duration'] ?? null) && $stream['duration'] > 0) $candidate['duration'] = (float)$stream['duration'] / 1000;
        $codec = strtolower((string)($stream['videoCodec'] ?? $stream['video_codec'] ?? $codec));
        if (in_array($codec, ['h265', 'hevc'], true)) $candidate['codec'] = 'hevc';
        elseif (in_array($codec, ['h264', 'avc', 'avc1'], true)) $candidate['codec'] = 'h264';
        elseif (in_array($codec, ['av1', 'h266', 'vvc'], true)) $candidate['codec'] = $codec;
        foreach (($stream['backupUrls'] ?? $stream['backup_urls'] ?? []) as $backup) {
            $backup = snapMediaUrl($backup);
            if ($backup !== '' && !in_array($backup, array_column($candidate['sources'], 'url'), true)) $candidate['sources'][] = ['url' => $backup];
        }
        return $candidate;
    }

    private function videoCandidates(array $video): array
    {
        $candidates = [];
        foreach (($video['media']['stream'] ?? []) as $codec => $streams) {
            if (!is_array($streams)) continue;
            foreach ($streams as $stream) if (is_array($stream) && ($candidate = self::streamCandidate($stream, (string)$codec))) $candidates[] = $candidate;
        }
        $mediaV2 = $video['mediaV2'] ?? [];
        if (is_string($mediaV2)) $mediaV2 = json_decode($mediaV2, true) ?? [];
        $opaque = $mediaV2['opaque1'] ?? [];
        if (is_string($opaque)) $opaque = json_decode($opaque, true) ?? [];
        foreach (['hd_screencast_stream', 'default_screencast_stream'] as $key) {
            $stream = $opaque[$key] ?? null;
            if (is_string($stream)) $stream = json_decode($stream, true);
            if (is_array($stream) && ($candidate = self::streamCandidate($stream))) $candidates[] = $candidate;
        }
        $key = $video['consumer']['originVideoKey'] ?? null;
        if (is_string($key) && preg_match('~^[A-Za-z0-9_/-]+$~D', $key) && !str_contains($key, '..') && !str_starts_with($key, '/')) {
            $original = ['is_original' => true, 'label' => '原始入口', 'sources' => []];
            $deadline = microtime(true) + 10;
            $measured = false;
            foreach (['qn', 'al', 'qc', 'bd'] as $cdn) {
                $source = ['url' => 'https://sns-video-' . $cdn . '.xhscdn.com/' . $key];
                if (!$measured && microtime(true) < $deadline) {
                    try { $probe = ($this->mediaProbe)($source['url'], $deadline); }
                    catch (Throwable $e) { $probe = []; }
                    $metadata = $probe['result']['metadata'] ?? [];
                    if (isset($metadata['width'], $metadata['height'])) {
                        $original = array_merge($original, $metadata);
                        $source['availability'] = 'available';
                        $original['url'] = $source['url'];
                        $measured = true;
                    } elseif (in_array($probe['http_status'] ?? null, [403, 404, 410], true)) $source['availability'] = 'unavailable';
                }
                $original['sources'][] = $source;
            }
            $original['url'] ??= $original['sources'][0]['url'];
            // Origin category alone is not evidence of dimensions, bitrate or superiority.
            $candidates[] = $original;
        }
        $unique = [];
        foreach ($candidates as $candidate) {
            $key = $candidate['url'];
            if (!isset($unique[$key])) { $unique[$key] = $candidate; continue; }
            $previous = $unique[$key];
            $unique[$key] = ($candidate['metadata_source'] ?? '') === 'mp4' ? array_replace($previous, $candidate) : $previous + $candidate;
            $sources = [];
            foreach (array_merge($previous['sources'], $candidate['sources']) as $source) $sources[$source['url']] = ($sources[$source['url']] ?? []) + $source;
            $unique[$key]['sources'] = array_values($sources);
        }
        return array_values($unique);
    }

    private function formatNoteData(array $note): array
    {
        $type = ($note['type'] ?? '') === 'video' ? 'video' : 'image';
        $images = $note['imageList'] ?? [];
        $first = $images[0] ?? [];
        $cover = $first['urlPre'] ?? $first['urlDefault'] ?? $first['url'] ?? $note['cover']['url'] ?? '';
        if ($cover === '' && !empty($note['video']['image']['thumbnailFileid'])) $cover = 'https://sns-img-hw.xhscdn.com/' . $note['video']['image']['thumbnailFileid'];
        if ($cover === '' && !empty($note['cover']['fileId'])) $cover = 'https://sns-img-hw.xhscdn.com/' . $note['cover']['fileId'];
        $result = ['type' => $type, 'title' => $note['title'] ?? '', 'desc' => $note['desc'] ?? '',
            'author' => ['name' => $note['user']['nickname'] ?? $note['user']['nickName'] ?? '', 'id' => $note['user']['userId'] ?? '', 'avatar' => $note['user']['avatar'] ?? ''],
            'cover' => $this->processImageUrl($cover), 'images' => [], 'live_photo' => [],
            'video_candidates' => $this->videoCandidates($note['video'] ?? [])];
        if (isset($note['noteId'])) $result['id'] = (string)$note['noteId'];
        if (is_numeric($note['time'] ?? null)) $result['create_time'] = $note['time'];
        foreach (['likedCount' => 'like_count', 'commentCount' => 'comment_count', 'shareCount' => 'share_count', 'collectedCount' => 'collect_count'] as $from => $to) {
            if (is_numeric($note['interactInfo'][$from] ?? null)) $result['statistics'][$to] = (int)$note['interactInfo'][$from];
        }
        // imageList on a video note is its cover, not a separate image-album item.
        if ($type !== 'video') foreach ($images as $image) {
            $imageUrl = $this->processImageUrl($image['url'] ?? $image['urlDefault'] ?? $image['urlPre'] ?? '');
            if ($imageUrl === '') continue;
            $result['images'][] = $imageUrl;
            $live = $this->videoCandidates(['media' => ['stream' => $image['stream'] ?? []]]);
            if ($live) {
                $result['live_photo'][] = ['image' => $imageUrl, 'video' => $live[0]['url'], 'video_candidates' => $live];
            }
        }
        if ($result['live_photo']) $result['type'] = 'live';
        return $result;
    }

    private function processImageUrl($url)
    {
        if (empty($url)) {
            return '';
        }

        // 处理多个URL粘在一起的情况（用 "3http" 分隔）
        if (preg_match('/3http/', $url) && !preg_match('/^http/', $url)) {
            $urls = preg_split('/(?=3http)/', $url);
            $processed = [];
            foreach ($urls as $u) {
                if (preg_match('/^http/', $u)) {
                    $u = preg_replace('/^3http/', 'http', $u);
                }
                $processed[] = $this->processImageUrl($u);
            }
            return implode('', $processed);
        }

        // 1. 优先处理 /oss-sg/notes_pre_post/ 或 /oss-sg/spectrum/ 等带oss-sg路径的结构
        if (preg_match('/\/oss-sg\/([a-zA-Z0-9_]+)\/([a-zA-Z0-9]+)!/', $url, $matches)) {
            $dir = $matches[1];
            if (!preg_match('/^[a-f0-9]{32}$/', $dir) && !is_numeric($dir)) {
                return 'https://sns-img-hw.xhscdn.com/oss-sg/' . $dir . '/' . $matches[2] . '?imageView2/2/w/0/format/jpg';
            }
        }

        // 2. 处理 notes_pre_post 和 spectrum 等通用匹配
        if (preg_match('/\/([a-zA-Z0-9_]+)\/([a-zA-Z0-9]+)!/', $url, $matches)) {
            $dir = $matches[1];
            if (!preg_match('/^[a-f0-9]{32}$/', $dir) && !is_numeric($dir)) {
                return 'https://sns-img-hw.xhscdn.com/' . $dir . '/' . $matches[2] . '?imageView2/2/w/0/format/jpg';
            }
        }

        // 针对不带 ! 的短链接 (如 http://sns-img-bd.xhscdn.com/notes_pre_post/xxx)
        if (preg_match('/(notes_pre_post|spectrum|notes_uhdr)\/([a-zA-Z0-9]+)/', $url, $matches)) {
            return 'https://sns-img-hw.xhscdn.com/' . $matches[1] . '/' . $matches[2] . '?imageView2/2/w/0/format/jpg';
        }

        // 3. 处理其他带 ! 的图片链接 (如实况图)
        if (preg_match('/\/([a-zA-Z0-9]+)!/', $url, $matches)) {
            return 'https://ci.xiaohongshu.com/' . $matches[1] . '?imageView2/2/w/0/format/jpg';
        }

        return $url;
    }

}
