# 统一媒体 v1 合同

本目录是 DokiTool 前后端共同使用的公开合同，采用 JSON Schema Draft 2020-12。`unified-v1.schema.json` 定义结构；PHP 运行时验证与独立 Python 验证另检查引用、默认选择、过期时间和交付语义。仅结构合法不能证明默认正确、上游可用或浏览器完成保存。

设计审计基线为 `9e69b7674d491d3b3a8b71614358b0d29d765496`，实现分支从同一 main 开始。附件生成器只是设计验证工具，没有作为 PHP 后端实现接入。原始设计的 26 个示例保留为合成样例；第 27 个示例覆盖用户在实施中确认的 deferred variant 预留。所有示例均非真实平台验收，详见 `fixtures-manifest.json`。

## 结构

```text
response (schema_version, code)
  data (platform, optional title/author/cover/statistics/groups/attachments)
    items[] (id, type, default, optional state)
      variants[] (id, optional metadata/provenance/label)
        delivery
          file/hls/dash → sources[]
          segments     → optional init + ordered pieces[].sources[]
          mux/pair     → resources[] (role, leaf delivery)
```

单文件不使用 `resources`。image、video、audio、live_photo 是 item 的媒体类型；multipart/collection/album 是分组用途，不是媒体类型。多 item 明确 `default_item_id`，每个 item 独立决定 default，背景音乐/字幕独立放 `attachments`。

未知元数据省略，不以零、空串或上传原片规格代替实际文件规格。ID 一律字符串；大小以字节，时长以毫秒，码率以 bit/s。source 的签名查询字节不重新编码；`direct` 为完整 HTTP(S) URL，`relay` 为 `/api/` 相对地址且不能包含凭据、遍历路径和任意请求头。

## 服务端选择与客户端职责

1. 服务端先保留全部版本和各自来源。依据当前时间排除失效/不可用来源；只有完整 `file` 才能成为默认。
2. 画面比例可比较时以实际空间尺寸判断高低，归一横竖方向；不跨编码按码率宣称更清晰。平局依次采用已知尺寸、原始入口身份、稳定 variant ID，来源保留后端声明的次序。原始入口不能压过更高尺寸，未知规格也不超越已知高规格；多来源 default 指定 source ID。
3. `default` 的 variant ID、source ID、URL、访问方式和已知过期时间全部来自同一选中 source。没有完整文件时为 null，原因必须与剩余能力/过期状态相符。
4. 已知更高尺寸、可用但需要处理的 variant 通过 `higher_quality_variants` 引用，能力由 delivery 递归推导，不能遗漏音频等依赖。没有可靠可比较规格时不虚称更高画质；这些候选仍保留在 variants 中。
5. 前端只读取、校验引用与当前时效，不重新排序挑默认。显式选择的 identity 独立保留，默认变化不得覆盖；无效引用明确报错。交付任务保存自己的不可变计划，后续解析不修改旧任务。

`browser_fetch:"blocked"` 不代表不存在完整文件，也不自动取消其默认资格；实际交付能力另检查。没有音轨的作品可以是完整 file，但未取得音频的 DASH 裸视频轨不能因此冒充完整作品。DASH/mux/remux 在本 PR 只识别并提示暂不支持，合流执行器另行实现。

## 两层 deferred

item 的 `state:"deferred"` 用于尚未解析的条目，例如分 P；它带 `resolve_url`，default 为 null，原因为 `needs_resolve`。

variant 的 `state:"deferred"` 用于已经知道有能力缺口、尚不能交付的版本。它只有 `id/state/reason` 与可选 `label/provenance`，不能携带 metadata、delivery、资源 URL 或虚构 4K 尺寸，也不能被 default/higher_quality_variants 引用。这是小红书原画能力的结构预留，不是在 PHP 未取得页面数据时为每条作品自动补出“已发现 4K”。没有 resolver 的占位不能触发隐含网络请求。

已有完整 file 与 deferred variant 可共存，默认保持完整 file。没有任何可用交付且存在待解析版本时 default 为 null、原因为 `needs_resolve`；可用处理版本存在则为 `processing_required`。未声明 state 的普通 variant 仍按 ready 读取。

## 实现与验证

平台目录为 `backend/config/platforms.json`。PHP 解析器保留平台内部抽取格式，在 `backend/lib/media-adapters.php` 转成统一 item/delivery；`media-contract.php` 计算选择并验证，`gateway.php` 负责公开入口、版本、resolve 与微博签名。旧格式只可存在于私有解析器边界，不能穿过内部/公开 JSON 网关。

前端使用 `utils/mediaContract.ts` 读合同，`useVideoParser.ts` 统一 parse/resolve，`useVideoSelection.ts` 保存显式选择，`useMediaDownload.ts` 把统一文件计划交给原有下载模块。新增已有媒体能力的平台只需新增后端适配并登记；专用图标属于可选展示素材。

```sh
# 开发/CI 验证依赖，非 PHP 产品运行依赖
python -m pip install -r scripts/requirements-validation.txt
python scripts/test-unified-schema.py

# 实际解析器抽取函数 + 实际适配器，输入仍是离线合成夹具
python scripts/validate-unified-schema.py --php /path/to/php --output .local/unified-validation.json

# 也可验证另行保存在本地的一份响应
python scripts/validate-unified-schema.py .local/adapter-response.json

# 后端离线回归和前端行为回归
python backend/tests/validate.py --php /path/to/php --output .local/backend-validation.json
cd frontend
npm test
npm run build
npm run check:load-budget
```

`unified-export.php` 每个进程选择一个平台，九平台 ID 见注册表；输出响应本身经过实际 adapter，独立 Python 再运行 JSON Schema 与语义验证。Windows PowerShell 保存 JSON 时使用 UTF-8；验证器可读 UTF-8 BOM。真实平台响应可用同一验证器，但应保存在被忽略的 `.local/`，不要把 token 和签名地址提交。

验收分四层记录：设计合成夹具、实际适配器离线输出、目标后端真实请求/媒体探测、浏览器完整保存与哈希。前一层通过不能替代后一层。发布要求见 [切换部署说明](../../DEPLOYMENT.md#统一媒体-v1-切换)，小红书证据见 [传输对照](../../research/xhs-4k-transport-comparison-2026-10-30.md)。
