<?php
require_once __DIR__ . '/../../lib/runtime.php';
require_once __DIR__ . '/../../lib/douyin-media-probe.php';
/**
 * @Author: JH-Ahua
 * @CreateTime: 2026/2/12 下午9:47
 * @UpdateTime: 2026/10/19
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @Api: api.bugpk.com
 * @tip: 抖音解析核心：免 Cookie 详情接口（视频/图集/实况通用，可返回图集原图）+ 原画直链解析，
 *       与 api/douyin-cloudflare workers/workers.js 逻辑保持一致
 */

class DouyinParser
{
    private $mediaProbe;

    public function __construct(?callable $mediaProbe = null)
    {
        $this->mediaProbe = $mediaProbe ?? static fn (string $url): ?array => (new SnapDouyinMediaProbe())->probe($url);
    }

    /** 详情接口：免 Cookie、免签名，视频返回 play_addr.uri + bit_rate，图集返回 images[].url_list，实况另含 images[].video */
    private const DETAIL_ENDPOINT = 'https://api.amemv.com/aweme/v1/aweme/detail/';

    /** 详情接口专用移动端 UA */
    private const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13; 2210132C Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36';

    /** 桌面端 UA：短链重定向解析、HEAD 探测、原画 302 跟随 */
    private const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

    /** 原画播放地址模板：传入 vid 拼接后 302 即为原画直链（与 workers 版一致） */
    private const ORIGINAL_PLAY_ENDPOINT = 'https://aweme.snssdk.com/aweme/v1/play/';

    /** 批量转换 vid 的单次上限（与 workers 版一致，超出的 vid 回退拼接地址） */
    private const VID_RESOLVE_MAX_COUNT = 30;

    /** 详情接口超时秒数 */
    private const REQUEST_TIMEOUT = 20;

    /**
     * 主解析入口
     */
    public function parse($input)
    {
        if (empty($input) || !is_string($input)) {
            return $this->output(400, '请输入抖音链接');
        }

        $url = $this->extractShareUrl($input);
        if (!$url) {
            return $this->output(400, '未在文本中识别到有效链接');
        }

        // 短链或无 ID 的链接先跟随重定向拿真实地址
        $host = strtolower((string)parse_url($url, PHP_URL_HOST));
        if ($host === 'v.douyin.com' || strpos($host, 'douyin.com') === false || !$this->extractAwemeId($url)) {
            $url = $this->resolveRedirect($url);
        }

        $awemeId = $this->extractAwemeId($url);
        if (!$awemeId) {
            return $this->output(400, '链接格式错误，无法提取作品 ID');
        }

        $response = $this->fetchDetail($awemeId);
        if (!$response['ok']) {
            return $this->output(500, $response['reason']);
        }

        return $this->formatData($response['detail']['aweme_detail'], $awemeId);
    }

    /**
     * 免 Cookie 详情接口：无签名、无游客 Cookie 依赖
     */
    private function fetchDetail($awemeId)
    {
        if (!is_string($awemeId) || !preg_match('/^[1-9][0-9]{15,19}$/', $awemeId)) {
            return ['ok' => false, 'reason' => '请输入作品 aweme_id，而不是合集 mix_id', 'detail' => null];
        }

        $query = http_build_query([
            'aweme_id' => $awemeId,
            'aid' => '6383',
            'device_platform' => 'web',
            'version_code' => '190500',
            'version_name' => '19.5.0',
        ]);

        $raw = $this->httpGet(self::DETAIL_ENDPOINT . '?' . $query, [
            'User-Agent: ' . self::MOBILE_UA,
            'Accept: application/json, text/plain, */*',
        ], self::REQUEST_TIMEOUT);
        if ($raw === false) {
            return ['ok' => false, 'reason' => '详情请求失败', 'detail' => null];
        }

        $json = json_decode($raw, true);
        if (!is_array($json) || !isset($json['status_code']) || !is_numeric($json['status_code'])) {
            return ['ok' => false, 'reason' => '详情接口缺少有效 status_code', 'detail' => null];
        }
        if ((int)$json['status_code'] !== 0) {
            return ['ok' => false, 'reason' => '详情接口 status_code=' . (int)$json['status_code'], 'detail' => null];
        }

        $detail = $json['aweme_detail'] ?? null;
        if (!is_array($detail) || $detail === []) {
            return ['ok' => false, 'reason' => '详情接口未返回 aweme_detail（不能据此断言作品已删除）', 'detail' => null];
        }
        if ((string)($detail['aweme_id'] ?? '') !== $awemeId) {
            return ['ok' => false, 'reason' => '详情接口返回的作品 ID 不匹配', 'detail' => null];
        }

        // 保留完整上游对象，继续交给媒体选取/格式化流程；此处不裁剪图文和实况
        return ['ok' => true, 'reason' => '', 'detail' => $json];
    }

    /**
     * 从分享文本中提取首个 http(s) 链接
     */
    private function extractShareUrl($text)
    {
        if (preg_match('/https?:\/\/[^\s\"\'<>]+/i', $text, $matches)) {
            // 去掉行尾跟随的引号或中英文标点，避免分享文本残留符号进入链接
            return rtrim($matches[0], '\'"，。；,.;');
        }
        return null;
    }

    /**
     * 跟随重定向获取真实链接（get_headers 优先，cURL 兜底）
     */
    private function resolveRedirect($url)
    {
        stream_context_set_default([
            'http' => ['method' => 'GET', 'header' => 'User-Agent: ' . self::DESKTOP_UA],
        ]);

        $headers = @get_headers($url, 1);
        if (isset($headers['Location'])) {
            $locations = is_array($headers['Location']) ? $headers['Location'] : [$headers['Location']];
            foreach ($locations as $location) {
                if ($this->extractAwemeId((string)$location)) {
                    return $location;
                }
            }
            return $locations[0];
        }

        // 兜底：cURL 跟随重定向取最终地址
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_USERAGENT => self::DESKTOP_UA,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_HEADER => true,
            CURLOPT_NOBODY => true,
            CURLOPT_TIMEOUT => 10,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ]);
        snapCurlExec($ch);
        $realUrl = (string)curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
        curl_close($ch);

        return $realUrl !== '' ? $realUrl : $url;
    }

    /**
     * 提取作品 ID：先查常见查询参数，再取路径末段（与 workers 版 getVideoId 一致）
     */
    private function extractAwemeId($url)
    {
        $parts = parse_url((string)$url);
        if (empty($parts['path']) && empty($parts['query'])) {
            return null;
        }

        if (!empty($parts['query'])) {
            parse_str($parts['query'], $query);
            foreach (['vid', 'id', 'modal_id', 'v', 's', 'pid'] as $key) {
                if (!empty($query[$key]) && is_scalar($query[$key])) {
                    return (string)$query[$key];
                }
            }
        }

        $segments = array_filter(explode('/', (string)($parts['path'] ?? '')));
        $last = end($segments);
        if ($last === false || $last === '') {
            return null;
        }
        if (substr($last, -5) === '.html') {
            $last = substr($last, 0, -5);
        }
        return $last !== '' ? $last : null;
    }

    /**
     * 统一输出（与 workers 版响应契约一致）
     */
    private function output($code, $msg, $data = [])
    {
        return json_encode([
            'code' => $code,
            'msg' => $msg,
            'data' => $data === [] && $code !== 200 ? [] : $data,
        ], 480);
    }

    /**
     * 格式化 aweme_detail 为统一响应契约（对齐 workers 版 buildLegacyFormatData）
     */
    private function formatData($detail, $fallbackVideoId)
    {
        $title = $this->strv($detail['desc'] ?? '');

        $authorNode = is_array($detail['author'] ?? null) ? $detail['author'] : [];
        $avatarList = is_array($authorNode['avatar_thumb']['url_list'] ?? null) ? $authorNode['avatar_thumb']['url_list'] : [];

        $musicNode = is_array($detail['music'] ?? null) ? $detail['music'] : [];
        $musicPlayNode = is_array($musicNode['play_url'] ?? null) ? $musicNode['play_url'] : [];
        $musicCoverNode = is_array($musicNode['cover_thumb'] ?? null)
            ? $musicNode['cover_thumb']
            : (is_array($musicNode['cover_thumb_medium'] ?? null) ? $musicNode['cover_thumb_medium'] : []);
        $musicPlayUrl = is_array($musicPlayNode['url_list'] ?? null) ? ($musicPlayNode['url_list'][0] ?? '') : '';
        $musicCoverUrl = is_array($musicCoverNode['url_list'] ?? null) ? ($musicCoverNode['url_list'][0] ?? '') : '';

        // 契约要求秒：抖音原始 duration 为毫秒，>=1000 视为毫秒归一为秒
        $duration = isset($detail['video']['duration']) && is_numeric($detail['video']['duration'])
            ? (float)$detail['video']['duration']
            : null;
        if ($duration !== null && $duration >= 1000) {
            $duration = round($duration / 1000, 2);
        }

        $createTime = $this->normalizeCreateTime($detail['create_time'] ?? ($detail['createTime'] ?? 0));

        $result = [
            'type' => 'unknown',
            'title' => $title,
            'desc' => $title,
            'author' => [
                'name' => $this->strv($authorNode['nickname'] ?? ''),
                'id' => $this->strv($authorNode['uid'] ?? $authorNode['unique_id'] ?? $authorNode['short_id'] ?? ''),
                'avatar' => $this->strv($avatarList[0] ?? ''),
            ],
            'cover' => '',
            'url' => null,
            'quality' => '',
            'duration' => $duration,
            'size' => 0,
            'size_label' => '',
            'create_time' => $createTime,
            'publish_time' => $this->formatPublishTime($createTime),
            'video_backup' => [],
            'images' => [],
            'live_photo' => [],
            'music' => [
                'title' => $this->strv($musicNode['title'] ?? $musicNode['music_name'] ?? ''),
                'author' => $this->strv($musicNode['author'] ?? $musicNode['owner_nickname'] ?? ''),
                'url' => $this->toHttps($this->strv($musicPlayUrl)) ?: '',
                'cover' => $this->toHttps($this->strv($musicCoverUrl)) ?: '',
            ],
            'extra' => $this->detailMetadata($detail),
        ];

        $images = is_array($detail['images'] ?? null) ? $detail['images'] : [];
        if (!$images && is_array($detail['image_list'] ?? null)) {
            $images = $detail['image_list'];
        }

        if ($images) {
            $result['type'] = 'image';
            $liveCandidates = [];

            foreach ($images as $img) {
                if (!is_array($img)) {
                    continue;
                }

                $imgUrl = $this->pickImageListItemUrl($img);
                if ($imgUrl) {
                    $result['images'][] = $imgUrl;
                }

                $videoInfo = is_array($img['video'] ?? null) ? $img['video'] : [];
                $liveVideoUrl = $this->extractLivePhotoVideoUrl($videoInfo);
                if ($liveVideoUrl) {
                    $liveVideoUrl = $this->toHttps(str_replace('playwm', 'play', $liveVideoUrl)) ?: '';
                }
                if ($imgUrl && $liveVideoUrl) {
                    $liveCandidates[] = [
                        'image' => $imgUrl,
                        'fallbackUrl' => $liveVideoUrl,
                        'vid' => $this->extractVidFromVideoInfo($videoInfo),
                    ];
                }
            }

            // 多视频 vid 全部转 302 后的原画直链，拿不到的回退原地址
            $vidMap = $this->resolveVidBatch(array_column($liveCandidates, 'vid'));
            foreach ($liveCandidates as $item) {
                $resolved = $item['vid'] !== null && array_key_exists($item['vid'], $vidMap) ? $vidMap[$item['vid']] : null;
                $result['live_photo'][] = [
                    'image' => $item['image'],
                    'video' => $this->ensureVideoMimeType($resolved ?: $item['fallbackUrl']),
                ];
            }

            if ($result['live_photo']) {
                $result['type'] = 'live';
            }
        } else {
            $result['type'] = 'video';
            $videoInfo = $this->extractHighestQualityVideo($detail);

            $playUri = $this->extractVidFromVideoInfo(is_array($detail['video'] ?? null) ? $detail['video'] : []);
            $main = $videoInfo['url'];
            if ($main) {
                $main = $this->toHttps(str_replace('playwm', 'play', $main));
            }

            // The original endpoint may return either a low-quality rendition or
            // the real high-bitrate source. Rank its measured video track, not its name.
            $fallback = $this->buildOriginalPlayUrl($playUri);
            if ($fallback) {
                try { $probed = ($this->mediaProbe)($fallback); }
                catch (Throwable $error) { $probed = null; } // Optional enhancement must not break parsing.
                $originalUrl = $probed['url'] ?? $fallback;
                $originalMetadata = $probed['metadata'] ?? [];
                $originalQuality = isset($originalMetadata['width'], $originalMetadata['height'])
                    ? min($originalMetadata['width'], $originalMetadata['height']) . 'p' : 'unknown';
                if ($originalMetadata) $originalMetadata['is_original'] = true;
                $currentPixels = ($videoInfo['metadata']['width'] ?? 0) * ($videoInfo['metadata']['height'] ?? 0);
                $originalPixels = ($originalMetadata['width'] ?? 0) * ($originalMetadata['height'] ?? 0);
                $better = $originalPixels > $currentPixels || ($originalPixels > 0 && $originalPixels === $currentPixels
                    && ($originalMetadata['bit_rate'] ?? 0) > ($videoInfo['metadata']['bit_rate'] ?? 0));
                if (!$main || $better) {
                    if ($main && $main !== $originalUrl) array_unshift($videoInfo['backup'], array_merge($videoInfo['metadata'],
                        ['url' => $main, 'quality' => $videoInfo['gearName'], 'label' => $videoInfo['gearName']]));
                    $main = $originalUrl; $videoInfo['metadata'] = $originalMetadata; $videoInfo['gearName'] = $originalQuality;
                } elseif ($originalUrl !== $main) {
                    $videoInfo['backup'][] = array_merge($originalMetadata, ['url' => $originalUrl, 'label' => $originalQuality, 'quality' => $originalQuality]);
                }
            }
            $result['quality'] = $videoInfo['gearName'];
            foreach ($videoInfo['metadata'] as $key => $value) {
                $result[$key] = $value;
            }

            // 补齐抖音 CDN 约定参数 mime_type=video_mp4；主地址先归一，保证下面去重比较口径一致
            $main = $this->ensureVideoMimeType($main);

            $backups = [];
            $seen = [$main];
            foreach ($videoInfo['backup'] as $candidate) {
                $item = is_string($candidate) ? ['url' => $candidate] : $candidate;
                $converted = $this->ensureVideoMimeType($this->toHttps(str_replace('playwm', 'play', $item['url'] ?? '')));
                if ($converted && !in_array($converted, $seen, true)) {
                    $item['url'] = $converted;
                    $backups[] = $item;
                    $seen[] = $converted;
                }
            }

            $result['url'] = $main;
            $result['size_label'] = $this->formatSizeLabel($result['size']);
            $result['video_backup'] = $backups;
            $result['video_id'] = $playUri ?: $fallbackVideoId;
        }

        $cover = $this->pickCover($detail);
        $result['cover'] = $cover ? ($this->toHttps($cover) ?: '') : '';

        return $this->output(200, '解析成功', $result);
    }

    /** Keep only metadata actually supplied by the source, including zero counts. */
    private function detailMetadata(array $detail)
    {
        $extra = [];
        $statistics = [];
        foreach (is_array($detail['statistics'] ?? null) ? $detail['statistics'] : [] as $key => $value) {
            if (str_ends_with((string)$key, '_count') && is_numeric($value) && $value >= 0) {
                $statistics[$key] = (int)$value;
            }
        }
        if ($statistics) { $extra['statistics'] = $statistics; }
        $hashtags = [];
        foreach (['text_extra' => 'hashtag_name', 'cha_list' => 'cha_name'] as $field => $name) {
            foreach (is_array($detail[$field] ?? null) ? $detail[$field] : [] as $item) {
                if (is_array($item) && is_string($item[$name] ?? null) && trim($item[$name]) !== '') {
                    $hashtags[] = trim($item[$name]);
                }
            }
        }
        if ($hashtags) { $extra['hashtags'] = array_values(array_unique($hashtags)); }
        $tags = [];
        foreach (is_array($detail['video_tag'] ?? null) ? $detail['video_tag'] : [] as $item) {
            if (is_array($item) && is_string($item['tag_name'] ?? null) && trim($item['tag_name']) !== '') {
                $tags[] = trim($item['tag_name']);
            }
        }
        if ($tags) { $extra['video_tags'] = array_values(array_unique($tags)); }
        return $extra ?: (object)[];
    }

    /**
     * 图集单图取 URL：urlList[0] → url_list[0] → url_list 末位兜底
     */
    private function pickImageListItemUrl($img)
    {
        if (is_array($img['urlList'] ?? null) && isset($img['urlList'][0]) && is_string($img['urlList'][0]) && $img['urlList'][0] !== '') {
            return $this->toHttps($img['urlList'][0]);
        }
        if (is_array($img['url_list'] ?? null)) {
            if (isset($img['url_list'][0]) && is_string($img['url_list'][0]) && $img['url_list'][0] !== '') {
                return $this->toHttps($img['url_list'][0]);
            }
            $last = end($img['url_list']);
            if (is_string($last) && $last !== '') {
                return $this->toHttps($last);
            }
        }
        return null;
    }

    /**
     * 提取实况视频地址：playAddr[] → play_addr.url_list → playApi（优先 v3-web，v26-web 换域名兜底）
     */
    private function extractLivePhotoVideoUrl($videoInfo)
    {
        $liveVideoUrl = null;
        $v26Candidate = null;

        if (is_array($videoInfo['playAddr'] ?? null)) {
            foreach ($videoInfo['playAddr'] as $addr) {
                if (!is_array($addr) || !is_string($addr['src'] ?? null) || $addr['src'] === '') {
                    continue;
                }
                if (strpos($addr['src'], 'v3-web') !== false) {
                    $liveVideoUrl = $addr['src'];
                    break;
                }
                if ($v26Candidate === null && strpos($addr['src'], 'v26-web') !== false) {
                    $v26Candidate = $addr['src'];
                }
            }

            if (!$liveVideoUrl && $v26Candidate) {
                $liveVideoUrl = $this->replacePlayHost($v26Candidate);
            }

            if (!$liveVideoUrl) {
                foreach ([1, 0] as $index) {
                    if (isset($videoInfo['playAddr'][$index]['src']) && is_string($videoInfo['playAddr'][$index]['src']) && $videoInfo['playAddr'][$index]['src'] !== '') {
                        $liveVideoUrl = $videoInfo['playAddr'][$index]['src'];
                        break;
                    }
                }
            }
        }

        if (!$liveVideoUrl && is_array($videoInfo['play_addr']['url_list'] ?? null)) {
            foreach ($videoInfo['play_addr']['url_list'] as $candidate) {
                if (!is_string($candidate) || $candidate === '') {
                    continue;
                }
                if (strpos($candidate, 'v3-web') !== false) {
                    $liveVideoUrl = $candidate;
                    break;
                }
                if ($v26Candidate === null && strpos($candidate, 'v26-web') !== false) {
                    $v26Candidate = $candidate;
                }
            }

            if (!$liveVideoUrl && $v26Candidate) {
                $liveVideoUrl = $this->replacePlayHost($v26Candidate);
            }

            if (!$liveVideoUrl) {
                foreach ([1, 0] as $index) {
                    if (isset($videoInfo['play_addr']['url_list'][$index]) && is_string($videoInfo['play_addr']['url_list'][$index]) && $videoInfo['play_addr']['url_list'][$index] !== '') {
                        $liveVideoUrl = $videoInfo['play_addr']['url_list'][$index];
                        break;
                    }
                }
            }
        }

        if (!$liveVideoUrl && isset($videoInfo['playApi']) && is_string($videoInfo['playApi']) && $videoInfo['playApi'] !== '') {
            $liveVideoUrl = $videoInfo['playApi'];
        }

        return $liveVideoUrl;
    }

    /**
     * 从码率档位条目收集播放地址候选（playAddr[].src 与 play_addr.url_list 双风格兼容）
     */
    private function collectPlayUrlCandidates($rateItem)
    {
        $candidates = [];

        if (is_array($rateItem['playAddr'] ?? null)) {
            foreach ($rateItem['playAddr'] as $item) {
                if (is_array($item) && isset($item['src']) && is_string($item['src']) && $item['src'] !== '') {
                    $candidates[] = $item['src'];
                }
            }
        }

        if (!$candidates && is_array($rateItem['play_addr']['url_list'] ?? null)) {
            foreach ($rateItem['play_addr']['url_list'] as $item) {
                if (is_string($item) && $item !== '') {
                    $candidates[] = $item;
                }
            }
        }

        return $candidates;
    }

    /**
     * Preserve source metadata and prefer known pixel dimensions, then bitrate.
     */
    private function extractHighestQualityVideo($detail)
    {
        $video = is_array($detail['video'] ?? null) ? $detail['video'] : [];
        $bitRateList = null;

        if (!empty($video['bitRateList']) && is_array($video['bitRateList'])) {
            $bitRateList = $video['bitRateList'];
        } elseif (!empty($video['bit_rate']) && is_array($video['bit_rate'])) {
            $bitRateList = $video['bit_rate'];
        }

        $url = null;
        $gearName = '';
        $backup = [];
        $metadata = [];

        if ($bitRateList) {
            usort($bitRateList, function ($a, $b) {
                $ma = $this->videoMetadata(is_array($a) ? $a : []);
                $mb = $this->videoMetadata(is_array($b) ? $b : []);
                $pixelsA = ($ma['width'] ?? 0) * ($ma['height'] ?? 0);
                $pixelsB = ($mb['width'] ?? 0) * ($mb['height'] ?? 0);
                return ($pixelsB <=> $pixelsA) ?: (($mb['bit_rate'] ?? 0) <=> ($ma['bit_rate'] ?? 0));
            });

            foreach ($bitRateList as $rateItem) {
                if (!is_array($rateItem)) {
                    continue;
                }

                $candidates = $this->collectPlayUrlCandidates($rateItem);
                if (!$candidates) {
                    continue;
                }

                $v3Link = null;
                $v26Link = null;
                foreach ($candidates as $candidate) {
                    if (strpos($candidate, 'v3-web') !== false) {
                        $v3Link = $candidate;
                        break;
                    }
                    if ($v26Link === null && strpos($candidate, 'v26-web') !== false) {
                        $v26Link = $candidate;
                    }
                }

                $currentBestUrl = $v3Link ?: ($v26Link ? $this->replacePlayHost($v26Link) : $candidates[0]);
                $itemMetadata = $this->videoMetadata($rateItem);
                $itemQuality = isset($itemMetadata['width'], $itemMetadata['height'])
                    ? min($itemMetadata['width'], $itemMetadata['height']) . 'p'
                    : $this->strv($rateItem['gearName'] ?? $rateItem['gear_name'] ?? 'unknown');

                if (!$url) {
                    $url = $currentBestUrl;
                    $gearName = $itemQuality;
                    $metadata = $itemMetadata;
                }

                foreach ($candidates as $candidate) {
                    if (strpos($candidate, 'v26-web') !== false) {
                        $candidate = $this->replacePlayHost($candidate);
                    }
                    if ($candidate !== $url) {
                        $backup[] = array_merge($itemMetadata, ['url' => $candidate, 'quality' => $itemQuality, 'label' => $itemQuality]);
                    }
                }
            }
        }

        // 码率列表缺失时的兜底：playApi → 原画拼接地址
        if (!$url) {
            $uri = isset($video['uri']) && is_string($video['uri']) ? $video['uri'] : '';
            if ($uri === '' && isset($video['play_addr']['uri'])) {
                $uri = (string)$video['play_addr']['uri'];
            }

            $playApi = '';
            if (isset($video['playApi']) && is_string($video['playApi']) && $video['playApi'] !== '') {
                $playApi = $video['playApi'];
            } elseif (is_string($video['play_addr']['url_list'][0] ?? null)) {
                $playApi = $video['play_addr']['url_list'][0];
            }

            if ($playApi !== '') {
                $url = str_replace('playwm', 'play', $playApi);
                $metadata = $this->videoMetadata($video);
            } elseif ($uri !== '') {
                // 原画兜底地址：formatData 会用 vid 走 resolveOriginalVideoUrl 做 302 解析，失败回退此地址
                $url = $this->buildOriginalPlayUrl($uri);
            }

            $urlList = is_array($video['play_addr']['url_list'] ?? null) ? $video['play_addr']['url_list'] : [];
            if (count($urlList) > 1) {
                foreach ($urlList as $index => $link) {
                    if ($index === 0 || !is_string($link) || $link === '') {
                        continue;
                    }
                    $converted = str_replace('playwm', 'play', $link);
                    if ($converted && $converted !== $url) {
                        $backup[] = array_merge($metadata, ['url' => $converted, 'quality' => 'unknown', 'label' => '备用播放源']);
                    }
                }
            }
        }

        if ($gearName === '' && isset($metadata['width'], $metadata['height'])) {
            $gearName = min($metadata['width'], $metadata['height']) . 'p';
        }
        return ['url' => $url, 'backup' => $backup, 'gearName' => $gearName ?: 'unknown', 'metadata' => $metadata];
    }

    /** Metadata belongs to this candidate, never copied from a different quality. */
    private function videoMetadata(array $item): array
    {
        $address = is_array($item['play_addr'] ?? null) ? $item['play_addr'] : ($item['playAddr'][0] ?? []);
        $address = is_array($address) ? $address : [];
        $metadata = [];
        foreach (['width' => ['width'], 'height' => ['height'], 'bit_rate' => ['bit_rate', 'bitRate'], 'size' => ['data_size', 'dataSize']] as $key => $aliases) {
            foreach ($aliases as $alias) {
                $value = $item[$alias] ?? $address[$alias] ?? null;
                if (is_numeric($value) && $value > 0) {
                    $metadata[$key] = (int)$value;
                    break;
                }
            }
        }
        $codec = strtolower((string)($item['codec'] ?? $item['codec_type'] ?? ''));
        if (in_array($codec, ['h264', 'avc', 'avc1', 'h.264'], true)) {
            $metadata['codec'] = 'h264';
        } elseif (in_array($codec, ['hevc', 'h265', 'h.265'], true)) {
            $metadata['codec'] = 'hevc';
        } elseif (isset($item['is_h265']) && in_array($item['is_h265'], [0, 1, '0', '1'], true)) {
            $metadata['codec'] = (int)$item['is_h265'] === 1 ? 'hevc' : 'h264';
        }
        return $metadata;
    }

    /**
     * 提取封面：originCover → cover → detail.cover → dynamicCover → 图集首图（多风格兼容）
     */
    private function pickCover($detail)
    {
        $video = is_array($detail['video'] ?? null) ? $detail['video'] : null;

        if ($video) {
            foreach (['originCover' => 'urlList', 'origin_cover' => 'url_list'] as $field => $listField) {
                if (is_array($video[$field][$listField] ?? null) && isset($video[$field][$listField][0]) && is_string($video[$field][$listField][0]) && $video[$field][$listField][0] !== '') {
                    return $video[$field][$listField][0];
                }
            }
            if (isset($video['originCover']) && is_string($video['originCover']) && $video['originCover'] !== '') {
                return $video['originCover'];
            }
            if (is_array($video['originCoverUrlList'] ?? null) && isset($video['originCoverUrlList'][0]) && is_string($video['originCoverUrlList'][0]) && $video['originCoverUrlList'][0] !== '') {
                return $video['originCoverUrlList'][0];
            }

            if (is_array($video['cover'] ?? null)) {
                $line = $video['cover']['urlList'][0] ?? ($video['cover']['url_list'][0] ?? '');
                if (is_string($line) && $line !== '') {
                    return $line;
                }
            }
            if (isset($video['cover']) && is_string($video['cover']) && $video['cover'] !== '') {
                return $video['cover'];
            }
        }

        if (is_array($detail['cover']['url_list'] ?? null) && isset($detail['cover']['url_list'][0]) && is_string($detail['cover']['url_list'][0]) && $detail['cover']['url_list'][0] !== '') {
            return $detail['cover']['url_list'][0];
        }

        if ($video) {
            foreach (['dynamicCover' => 'urlList', 'dynamic_cover' => 'url_list'] as $field => $listField) {
                if (is_array($video[$field][$listField] ?? null) && isset($video[$field][$listField][0]) && is_string($video[$field][$listField][0]) && $video[$field][$listField][0] !== '') {
                    return $video[$field][$listField][0];
                }
            }
        }

        $images = is_array($detail['images'] ?? null) ? $detail['images'] : [];
        if (!$images && is_array($detail['image_list'] ?? null)) {
            $images = $detail['image_list'];
        }
        if ($images && is_array($images[0]) && is_array($images[0]['url_list'] ?? null) && isset($images[0]['url_list'][0]) && is_string($images[0]['url_list'][0]) && $images[0]['url_list'][0] !== '') {
            return $images[0]['url_list'][0];
        }

        return null;
    }

    /**
     * 从 video 信息中提取 vid（优先 play_addr.uri，兼容 playAddr[0].uri 与 video.uri）
     */
    private function extractVidFromVideoInfo($videoInfo)
    {
        if (!is_array($videoInfo)) {
            return null;
        }
        if (isset($videoInfo['play_addr']['uri']) && is_scalar($videoInfo['play_addr']['uri'])) {
            return (string)$videoInfo['play_addr']['uri'];
        }
        if (isset($videoInfo['playAddr'][0]['uri']) && is_scalar($videoInfo['playAddr'][0]['uri'])) {
            return (string)$videoInfo['playAddr'][0]['uri'];
        }
        if (isset($videoInfo['uri']) && is_string($videoInfo['uri']) && $videoInfo['uri'] !== '') {
            return $videoInfo['uri'];
        }
        return null;
    }

    /**
     * 拼接原画播放地址（唯一原画接口）
     */
    private function buildOriginalPlayUrl($vid, $ratio = 'default')
    {
        if (empty($vid)) {
            return null;
        }
        return self::ORIGINAL_PLAY_ENDPOINT . '?video_id=' . rawurlencode((string)$vid) . '&ratio=' . $ratio . '&line=0';
    }

    /**
     * 传入视频 vid，拿 302 后的原画直链；任一环节失败则回退拼接的原画地址
     * （与 cloudflare workers 版 resolveOriginalVideoUrl 逻辑一致）
     */
    private function resolveOriginalVideoUrl($vid, $ratio = 'default')
    {
        $fallbackUrl = $this->buildOriginalPlayUrl($vid, $ratio);
        if (!$fallbackUrl) {
            return null;
        }

        $resolved = $this->followLocation($fallbackUrl, 3);
        return $resolved ?: $fallbackUrl;
    }

    /**
     * 单次请求，仅跟踪 302 Location（最多 $max 跳），无重定向返回 null
     */
    private function followLocation($url, $max = 3)
    {
        $current = $url;
        $redirected = false;

        for ($i = 0; $i < $max; $i++) {
            $ch = curl_init($current);
            curl_setopt_array($ch, [
                CURLOPT_USERAGENT => self::DESKTOP_UA,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_HEADER => true,
                CURLOPT_NOBODY => true,
                CURLOPT_TIMEOUT => 10,
                CURLOPT_SSL_VERIFYPEER => true,
                CURLOPT_SSL_VERIFYHOST => 2,
            ]);
            $response = snapCurlExec($ch);
            $error = curl_error($ch);
            $headerSize = (int)curl_getinfo($ch, CURLINFO_HEADER_SIZE);
            $httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);

            if ($error || $response === false || $httpCode < 300 || $httpCode >= 400) {
                break;
            }

            $headerText = substr((string)$response, 0, $headerSize);
            if (!preg_match('/^location:\s*(\S+)/mi', $headerText, $matches)) {
                break;
            }

            $location = trim($matches[1]);
            // 相对地址转绝对
            if (strpos($location, 'http') !== 0) {
                $parsed = parse_url($current);
                if (!empty($parsed['scheme']) && !empty($parsed['host'])) {
                    $location = $parsed['scheme'] . '://' . $parsed['host']
                        . ($location[0] === '/' ? '' : '/') . $location;
                }
            }

            $current = $location;
            $redirected = true;
        }

        return $redirected ? $current : null;
    }

    /**
     * 批量转换 vid：去重 + 数量上限（超出的 vid 不在结果中，由调用方回退拼接地址）
     */
    private function resolveVidBatch($vidList)
    {
        $cache = [];
        $unique = array_values(array_unique(array_filter($vidList)));
        $limited = array_slice($unique, 0, self::VID_RESOLVE_MAX_COUNT);

        foreach ($limited as $vid) {
            $cache[$vid] = $this->resolveOriginalVideoUrl($vid);
        }

        return $cache;
    }

    /**
     * 基础 GET 请求
     */
    private function httpGet($url, $headers = [], $timeout = self::REQUEST_TIMEOUT)
    {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_ENCODING => 'gzip,deflate',
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_HTTPHEADER => $headers,
        ]);

        $response = snapCurlExec($ch);
        $error = curl_error($ch);
        curl_close($ch);

        return $error ? false : $response;
    }

    /**
     * 有界探测主视频真实字节大小：单次 HEAD、不下载正文，拿不到一律 0（契约允许未知）
     */
    private function probeVideoSize($url)
    {
        if (empty($url)) {
            return 0;
        }

        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_USERAGENT => self::DESKTOP_UA,
            CURLOPT_NOBODY => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 5,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ]);
        snapCurlExec($ch);
        $error = curl_error($ch);
        $contentType = strtolower((string)curl_getinfo($ch, CURLINFO_CONTENT_TYPE));
        $length = (int)curl_getinfo($ch, CURLINFO_CONTENT_LENGTH_DOWNLOAD_T);
        $httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($error || $httpCode < 200 || $httpCode >= 300) {
            return 0;
        }
        if (strpos($contentType, 'video') === false && strpos($contentType, 'octet-stream') === false) {
            return 0;
        }
        return $length > 0 ? $length : 0;
    }

    /**
     * v26-web 播放域名统一替换（与 workers 版一致）
     */
    private function replacePlayHost($url)
    {
        return preg_replace('/:\/\/([^\/]+)/', '://v26-luna.douyinvod.com', $url);
    }

    /**
     * 统一响应契约辅助：1024 进制 B/KB/MB/GB/TB，最多两位小数且不保留尾部 0
     */
    private function formatSizeLabel($bytes)
    {
        if (!is_numeric($bytes) || $bytes <= 0) {
            return '';
        }
        $units = ['B', 'KB', 'MB', 'GB', 'TB'];
        $value = (float)$bytes;
        $unit = 0;
        while ($value >= 1024 && $unit < count($units) - 1) {
            $value /= 1024;
            $unit++;
        }
        if ($unit === 0) {
            return round($value) . 'B';
        }
        $label = rtrim(rtrim(number_format($value, 2, '.', ''), '0'), '.');
        return $label . $units[$unit];
    }

    /**
     * 发布时间归一化：秒级直用，毫秒级（>=1e12）除一次 1000，非法/超范围归 0
     */
    private function normalizeCreateTime($value)
    {
        if (!is_numeric($value) || $value <= 0) {
            return 0;
        }
        $ts = (float)$value;
        if ($ts >= 1000000000000) {
            $ts = floor($ts / 1000);
        } else {
            $ts = floor($ts);
        }
        $ts = (int)$ts;
        if ($ts < 1000000000 || $ts > 4102444800) {
            return 0;
        }
        return $ts;
    }

    /**
     * 固定东八区格式化为 YYYY-MM-DD HH:mm:ss，未知返回空串
     */
    private function formatPublishTime($createTime)
    {
        if (empty($createTime)) {
            return '';
        }
        try {
            $dt = new DateTime('@' . $createTime);
            $dt->setTimezone(new DateTimeZone('Asia/Shanghai'));
            return $dt->format('Y-m-d H:i:s');
        } catch (Exception $e) {
            return '';
        }
    }

    /**
     * http → https 统一，其余原样返回
     */
    private function toHttps($url)
    {
        if (!is_string($url) || $url === '') {
            return null;
        }
        return strpos($url, 'http://') === 0 ? 'https://' . substr($url, 7) : $url;
    }

    /**
     * 空安全字符串转换（与 workers 版 stringValue 一致）
     */
    private function strv($value)
    {
        if (is_string($value)) {
            return $value;
        }
        return $value === null ? '' : (string)$value;
    }

    /**
     * 补齐视频直链的 mime_type=video_mp4（抖音 CDN 约定参数）
     *
     * 仅对 http(s) 地址生效；已存在 mime_type 参数则原样返回；
     * 无查询串用 ? 拼接，已有查询串用 &；带 fragment 时追加到 fragment 之前。
     * 仅用于视频地址，不用于图集 / 封面 / 音乐。
     */
    private function ensureVideoMimeType($url)
    {
        $url = $this->strv($url);
        if ($url === '' || stripos($url, 'http') !== 0) {
            return $url;
        }

        // fragment 不参与查询串判断，追加时要放在 fragment 之前
        $hashPos = strpos($url, '#');
        $base = $hashPos === false ? $url : substr($url, 0, $hashPos);
        $fragment = $hashPos === false ? '' : substr($url, $hashPos);

        $query = parse_url($base, PHP_URL_QUERY);
        if (is_string($query) && $query !== '') {
            parse_str($query, $params);
            if (array_key_exists('mime_type', $params)) {
                return $url;
            }
        }

        return $base . (strpos($base, '?') !== false ? '&' : '?') . 'mime_type=video_mp4' . $fragment;
    }
}
