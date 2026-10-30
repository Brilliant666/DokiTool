# DokiTool

DokiTool 是在同一仓库维护 Vue 3 前端与自建 PHP 解析接口的短视频工具，支持视频、图片、实况照片、画质与备用源选择，以及 B 站分 P 的展示、播放和下载。普通媒体优先由用户浏览器直接从媒体 CDN 获取。

本项目在两个指定上游快照上独立维护，采用选择性适配，并非 GitHub Fork 或上游仓库的完整镜像：

| 组件 | 上游 | 采用版本 |
| --- | --- | --- |
| PHP 解析器 | [jiuhunwl/short_videos](https://github.com/jiuhunwl/short_videos) | `72e5b6e72ab21e695d510e1c4c45213ce9a25f0f` |
| Vue 前端 | [jiuhunwl/shortvideo-html](https://github.com/jiuhunwl/shortvideo-html) | `cd16011960fe90b53dd87f57714d1a096e986e5a`，包版本 `4.1.0` |

原作者的许可证与版权声明保留在 [backend/LICENSE](backend/LICENSE)、[frontend/LICENSE](frontend/LICENSE) 和源码注释中；新增适配代码采用 [MIT](LICENSE)。依赖许可见 [NOTICE](NOTICE) 及 [frontend/public/licenses](frontend/public/licenses)。详细来源记录在 [UPSTREAM.json](UPSTREAM.json)，人工引入更新的方法见 [上游维护说明](docs/UPSTREAM-MAINTENANCE.md)。

[上游每日更新检查](docs/UPSTREAM-WATCH.md) 由 GitHub Actions 在北京时间 09:00 运行，新变化通过仓库 Issue 通知；不自动合并或部署。

## 当前目标

先完成已接入平台的实际使用，再扩展能力。当前范围是抖音、快手、B 站、小红书、今日头条、微博、皮皮虾、皮皮搞笑、最右这九个平台；前端入口与后端注册表保持一致。

一次完整使用包括：粘贴有效链接、识别平台、解析并展示对应媒体、切换或勾选内容、播放与下载，以及失败后能重试。接口返回成功但图片丢失、播放错分 P、下载空文件或页面仍显示旧结果，都属于本阶段要修复的缺陷。平台解析、界面交互与真实媒体下载分别记录验收结果，不能用固定样例通过代替真实平台可用。

相关缺陷按批修复，集中回归并提交一个 PR；本阶段不新增平台，也不以更换为作者公共 API 代替自建后端修复。

## 统一媒体接口

九平台统一使用 `/api/parse`、`/api/resolve` 和 `/api/platforms`，请求携带 `schema_version=1.0`。返回结构为 `items → variants → delivery`：每个条目的完整文件默认项由后端计算，前端校验后直接读取；用户选中的版本独立保留。旧公共字段与平台专属前端归一化已移除，前后端须成套切换。

单文件使用 `delivery.sources`，实况配对和音视频组合才展开 `resources`。完整 variants 保留，需处理的更高规格通过引用说明能力；DASH、音视频合流和需 remux 的分段目前明确提示暂不支持，视频裸轨不会被当成完整视频下载。待解析的原画 variant 可声明 `state:deferred`，不会伪造地址/规格或覆盖现有完整文件。

平台注册唯一来源是 `backend/config/platforms.json`，前端构建自动生成目录快照，运行时也读取公开目录。新增现有媒体能力的平台只需后端适配与注册，图标可以使用通用样式。详细说明见 [API 合同](docs/API.md)、[schema 与验证](docs/schema/unified-v1/README.md) 和 [成套切换要求](docs/DEPLOYMENT.md#统一媒体-v1-切换)。

小红书已保留 stream、原画候选及真实媒体探测能力，但当前 PHP 页面请求仍无法取得对照样本的原始作品数据。本 PR 不加入 Python/curl_cffi 运行依赖；已探测到的真实 4K 是隔离页面抓取后交给 PHP 探测的结果，不等于目标后端端到端或浏览器完整保存通过。脱敏证据与后续 Go 迁移验收条件见 [研究记录](docs/research/xhs-4k-transport-comparison-2026-10-30.md)。

## 下载与任务管理

紫色“下载视频”按钮按以下顺序选择完整文件的交付方式：

| 方式 | 采用条件 | 数据路径与体验 |
| --- | --- | --- |
| 原生直链 `browser_native` | 能读取到符合要求的附件响应头、媒体类型及文件名 | CDN → 浏览器下载管理器。文件名由来源决定；页面只确认已交接，不能跟踪其进度或保存结果。 |
| SW 流式 `browser_streaming` | 未满足原生附件条件，且浏览器支持 Service Worker、媒体允许跨域读取 | CDN → 浏览器 Worker → 下载管理器。按作品命名，边收边交付，显示进度，不在页面积攒整个文件。 |
| Blob `browser_blob` | 尚未启动 SW 任务，已确认浏览器缺少所需流式能力 | CDN → 浏览器完整接收 → 保存。没有固定文件大小上限，每页串行处理，仍受浏览器内存能力限制。 |

普通 CDN 下载不经本站服务器中转；微博仍使用本站限定来源的签名媒体服务。SW 注册、桥接加载或协议故障，以及源站错误、任务状态未知，都不会自动改走 Blob 再下载一份。播放器菜单中的“下载”由浏览器自行处理，不经过上述选择与命名流程。ZIP 打包、分段与 HLS 合并继续使用各自流程，不属于 SW 刷新恢复范围。

SW 需要 HTTPS 或 localhost，同时传输最多两项任务；等待名额时先保留任务，获准交付后再启动正式媒体传输。同一标签页刷新后会查询并恢复仍存在的任务，已被浏览器接管的附件不会重新启动下载。通信暂时失败会显示状态待确认，避免重复下载；原任务丢失则报告中断。这是恢复原任务的观察与控制，不是断点续传。

下载期间保留必要的受控桥接页，并继续联系各任务原来的 Worker；更新等待任务结束后自然接替，不强制切换。关闭全部页面、锁屏或浏览器被系统挂起后的持续下载尚无保证。实现、部署要求和验收记录见 [下载说明](docs/DOWNLOADS.md)。

任务面板将活动和状态待确认任务排在前面，历史记录默认汇总，展开后可查看全部。手动折叠会记住偏好，新任务不会擅自展开；全部结束后，未悬停或聚焦的面板在五秒后自动收起。“清除已结束”可在其他任务运行时使用，不清除状态待确认任务，也不删除已保存文件。折叠与展开只改变界面，不停止传输。

## 目录

- `frontend/`：Vue 3、TypeScript、Vite 界面与契约测试。
- `backend/`：PHP 控制器、明确启用的平台解析器及离线测试。
- `ops/examples/`：脱敏的 Caddy/PHP-FPM 配置示例。
- `docs/`：[API 合同](docs/API.md)、[下载说明](docs/DOWNLOADS.md)、[部署说明](docs/DEPLOYMENT.md)和上游维护说明。
- `scripts/`：依赖许可整理与公开文件清单检查工具。

`public-files.json` 明确列出公开文件，`.gitignore` 默认忽略未列出的本地资料。新增源码时先审查并加入清单，再运行 `python scripts/check-public-files.py --write-ignore`；提交前用 `python scripts/check-public-files.py --staged` 核对暂存内容。本地备份、凭据、运行日志、生产配置和构建产物不进入仓库。

## 本地构建

准备 Node.js（Vite 5 要求 Node 18+，建议使用受支持的 LTS）、npm，以及 Python 3.10+。生产环境只需前端静态文件和 PHP-FPM，不需要常驻 Vite 开发服务器。

```sh
cd frontend
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm test
npm run build
npm run check:load-budget
cd ..
python scripts/third-party-notices.py
```

构建产物在 `frontend/dist/`，不会提交到 Git。锁文件固定依赖版本和完整性信息；部分上游锁定下载地址使用 npm 镜像，命令行 registry 不会替换所有锁定地址。

首屏使用本地 SVG 图标和带 hash 的小尺寸品牌素材；原图保存在 `frontend/brand-originals/`，可用 `npm run assets:brand` 重新生成网页 PNG。结果区在解析期间加载，JSZip 在打包操作时加载。加载预算只检查构建体积与依赖拆分；[浏览器性能验收与缓存发布要求](docs/DEPLOYMENT.md#静态资源缓存与首次加载) 另行记录。

页眉、首页输入区与下载面板采用统一的明暗主题颜色过渡；平台卡片两侧以透明遮罩淡出，避免切换主题时出现底色断层。保留现有布局、渐变和粒子动画，并尊重系统的减少动态效果设置。

默认 `VITE_API_MODE=php`、`VITE_API_BASE_URL` 为空，浏览器请求同源 `/api/*`。可参考 `frontend/.env.example`。设置 API origin 不会自动启用加密协议；仅显式 `secure` 模式使用另行实现的 `/api/v1` 协议，基础 PHP 后端不提供该协议。

## 本地检查

PHP 8.1+，启用 cURL、OpenSSL、JSON 和标准扩展；本地已验证 PHP 8.4。用已安装的 PHP 可执行文件运行：

```sh
php backend/tests/contract.php
python backend/tests/validate.py --php /path/to/php --output .local/backend-validation.json
python -m pip install -r scripts/requirements-validation.txt
python scripts/test-unified-schema.py
python scripts/validate-unified-schema.py --php /path/to/php --output .local/unified-validation.json
python scripts/check-public-files.py
cd frontend
npm run test:media-integration
cd ..
```

Windows 的 `--php` 可使用 PHP 可执行文件的完整路径。`validate.py` 只运行离线契约、语法和 CLI 场景，不启动服务，也不请求真实媒体平台。两进程 HTTP 夹具的使用方式见 [部署说明中的本地 HTTP 验证](docs/DEPLOYMENT.md#本地-http-验证)。

`npm test` 仍是独立前端测试；`npm run test:media-integration` 另验证实际 PHP 输出进入前端下载 composable 后的续签、默认快照与显式选择。后者需要 PHP：优先读取 `DOKITOOL_PHP_BINARY` 环境变量，其次使用仓库已有的本地 PHP，再尝试 PATH 中的 `php`。上游输入为合成夹具，不请求真实媒体平台；平台与续签输出的独立 Schema 验证命令见 [schema README](docs/schema/unified-v1/README.md#实现与验证)。

自动化检查涵盖前端行为、PHP 网关契约、解析器与媒体传输回归、CLI 场景和独立 HTTP 夹具。前端测试覆盖元数据、混合静图与实况、分 P、选源、ZIP 取消重试，以及 SW 排队、刷新、取消竞态、任务面板和历史清理。仓库发布与线上服务发布分别进行，本仓库不会自动部署或定时覆盖上游。

PR #7 的历史下载验收使用本地生产构建与 Edge：两条超过六分钟的受控跨域文件下载经历刷新和 Worker 更新等待后完整保存；第三项排队超过五分钟，随后以原任务 ID 完成；更新自然激活后再次下载成功。另验证了新客户端搭配旧 Worker 的小文件下载。五个实际保存文件的大小与 SHA-256 均匹配源文件，详细结果见 [下载验收记录](docs/DOWNLOADS.md#state-and-admission-consolidation-2026-10-30)。

统一合同首次候选 `36bde3f` 完成九平台适配器离线验证、八平台真实 API 样本验证及两个浏览器文件保存/哈希对照。当时刷新后的文件完整，但页面终态误报中断，该历史失败继续保留。本轮二次审查已修复续签身份、mux 画质引用、实况子资源续签、gzip 大小判断及三项平台映射问题，并完成离线回归和跨语言下载集成；最终构建另通过 Edge 受控跨域 gzip ZIP 保存、解包大小与哈希检查。这些结果不计为真实平台重新验收。小红书 4K 端到端与本轮 Worker 升级仍需独立验收。各轮结果、SW 后续同条件对照与剩余问题见 [统一媒体验收记录](docs/UNIFIED-MEDIA-ACCEPTANCE.md)。

这些受控样例验证任务生命周期与文件完整性，不能证明真实平台当前成功率、CDN 吞吐或所有浏览器的保存行为。升级样例只改变 Worker 构建标记，不代表未来不兼容协议也可直接升级。界面“传输完成”表示已将数据交给浏览器，最终保存仍以浏览器下载列表和实际文件为准；iOS Safari／微信、关闭全部页面、锁屏与系统挂起仍需单独验收。

## 适配与边界

默认 API 由本站 PHP 提供；后端适配器保留平台内部抽取细节，对外只发布统一合同。服务端执行结构与语义验证，独立 Python 验证器再检查实际适配器导出的响应；这些离线合成输入的通过不代表平台实时成功率。界面图标使用本地 SVG，平台展示图标与品牌图片随构建发布；不再加载图标字体和 Swiper。

除微博外，播放和下载直接使用解析结果的媒体地址，仍受媒体站点的 CORS、防盗链、地区限制和链接时效影响。微博通过本站限定来源的签名媒体服务播放与下载，需要配置共享密钥和独立媒体池，详见 [部署说明](docs/DEPLOYMENT.md#微博播放与下载)。当前公开入口不包含开放媒体代理、需要 Cookie 的抖音主页、网易云 Python 服务或其他可选上游脚本。

部署前必须选择访问控制、使用独立 PHP-FPM 池并限制解析服务出网。现有 TLS、域名和超时检查不构成完整的重定向/DNS 隔离；请完整阅读 [部署边界](docs/DEPLOYMENT.md)。
