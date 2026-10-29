# API 合同

所有公开入口仅接受 GET，查询参数 `url` 是分享 URL 或包含分享 URL 的文本。路径固定，不能用用户输入选择任意 PHP 文件。

| 路径 | 平台/入口 |
| --- | --- |
| `/api/short_videos` | 识别域名后分发到内部单平台入口 |
| `/api/douyin` | 抖音 |
| `/api/ksjx` | 快手 |
| `/api/bilibili` | B 站旧版解析器 `bilibili/bilibili.php` |
| `/api/xhsjx` | 小红书 |
| `/api/toutiao` | 头条 |

聚合入口另支持微博、皮皮虾、皮皮搞笑、最右。只有 `backend/lib/gateway.php` 列出的平台域名可进入对应解析器；`url` 的完整查询参数会保留，包含 B 站 `p=N`。

典型响应：

```json
{"code":200,"msg":"success","data":{"title":"示例作品","url":"https://media.example/video.mp4","images":[],"live_photo":[],"video_backup":[]}}
```

必须同时检查 HTTP 状态与业务 `code`。HTTP 200 可能携带 `code:404/201/-1/0` 等业务失败。未知路由、方法或输入被网关拒绝；HTML、JSON 标量和无业务码响应转成 502；无可用媒体在前端显示错误。

`data` 可包含 `images`、`live_photo`、`video_backup`、`music`、`videos`、`extra.pages` 与合集信息。视频、图集和实况可能同时出现，客户端应保留所有有效媒体，不能因为存在实况就隐藏普通图片。

## 媒体与结果信息

- `url` 是后端为当前作品或指定分 P 选择的主视频地址；`video`、`imgurl`、字符串音乐地址等旧字段在适配层归一化。图集的首张图片不能被当作主视频播放。
- `video_backup` 使用含 `url` 的对象数组，可带 `label`、`quality` 和可取得的媒体属性；前端同时兼容旧版字符串数组。备用项的位置不代表画质排序，`original` 标签本身也不证明分辨率。
- `width`、`height`、`bit_rate`、`codec` 描述所选媒体，只有源数据已知时才提供。播放器、复制链接与下载应使用同一个当前选源。
- 发布时间兼容 `create_time`（秒或毫秒时间戳）、`publish_time` 与旧 `extra.create_time`；未知时如实显示未知，不能用解析时间补齐。
- `extra.statistics`、`extra.hashtags`、`extra.video_tags` 分别供数据、话题与标签展示。源站返回的零值与缺失值含义不同：零值可展示，缺失不能补为零。标题中的 `#话题` 可用于话题展示，不能据此生成统计数据。

B 站按请求的 `p=N` 解析当前分 P，其他分 P 可只返回元数据和懒解析入口；客户端切换或下载时再请求相应分 P。根据 `videos[].index` 选择，不能给失败分 P 借用其他直链。批量下载有条目失败时必须报告失败，不得生成空 ZIP 后显示成功。

内部入口为 `/parse/{platform}`，只用于受控 loopback HTTP，要求固定 Host 与 loopback 来源；它不能再次分发聚合入口。公开层与内部层需使用不同 FPM 池。相关配置见 [部署说明](DEPLOYMENT.md)。

`/api/v1/session`、`/api/v1/parse`、原始 PHP 路径、媒体代理、抖音主页和网易云服务不属于本项目公开 API。
