# Go 迁移工作区

迁移边界见 [mapping.md](mapping.md)，切换前必须完成的旧发布包与实际回滚演练见 [rollback.md](rollback.md)。进度及证据范围见 [acceptance.md](acceptance.md)。

## 当前运行方式

Go module 位于 `backend/`。固定工具链为 Go **1.27.3**，生产代码当前只使用标准库。PHP 应用保留为现行生产入口及冻结参考；Go 使用独立的 loopback 端口做迁移验收，没有 PHP 回退调用。

```sh
cd backend
go test ./...
go test -race ./...
go vet ./...
go build -o /tmp/dokitool-go ./cmd/dokitool
/tmp/dokitool-go catalog
/tmp/dokitool-go serve -listen 127.0.0.1:9082
```

catalog 从原路径 `backend/config/platforms.json` 内嵌，公开字段与九平台 PHP 目录保持一致。目录表示项目的平台注册事实；某平台尚未绑定 Go adapter 时，其解析请求明确返回 `503 SERVICE_NOT_CONFIGURED`，不会把空媒体结果当迁移成功。当前只有抖音绑定了 Go adapter，仍存在 [未关闭的基线合同问题](known-issues.md)，Go 服务不能替代九平台生产入口。

公开 JSON 仍为 `/api/parse`、`/api/resolve`、`/api/platforms`，需要 `schema_version=1.0`。例如检查目录：

```sh
curl 'http://127.0.0.1:9082/api/platforms?schema_version=1.0'
```

不接受公开任意 URL 代理、客户端 Cookie/传输配置或 TLS 参数。平台经 `internal/fetch.Executor` 请求上游，实际执行器统一约束目标、DNS、socket 绑定、逐跳校验、读取限额和 context。首次实现采用标准 `net/http`；替换握手/传输实现时须保留同一策略和对应测试。媒体探测及微博流式媒体各自有更严格/独立的预算，不应直接复用普通 JSON 请求预算。

抖音有界 MP4 探测每次最多 1 MiB、12 个请求、6 秒，限制重定向与文件总大小，不下载整片。严格媒体请求使用标准库 HTTP/1.1 传输，并在标准解析器前观察原始头部和 trailer，防止同值重复 `Content-Length` 被合并而丢失原有拒绝证据；正文仍由 `net/http` 解码。普通页面/API 请求保留标准库 HTTP/2 协商。两条路径都将请求取消绑定到底层连接。

Go 对普通请求新增了逐跳目的域、DNS 与连接约束；Live HEAD 重定向只访问已声明媒体主机。这是已批准的出站边界收紧，与旧 PHP 接受任意重定向的行为不同，真实平台兼容性仍须在后续阶段验证。

## 合同与身份

`internal/unified` 使用保留精度的 JSON tree 表示公开对象：`json.Number` 不先转浮点，缺字段、null、false、0 和空数组分别保留。所有公开媒体结果在完整候选阶段校验，应用来源资格和公共候选策略后再次校验。平台包不能自行实现第二套默认规则或把未经验证的 tree 直接发给前端。

同一规范仍是 `docs/schema/unified-v1/unified-v1.schema.json`。Go 只内嵌自动生成且有字节一致性测试的副本：

```sh
cd backend
go generate ./internal/unified
go test ./internal/unified
```

身份哈希与票据使用显式的 PHP JSON 兼容编码，不能改成普通 Go map 的 JSON 编码。公共 JSON 对象键序不影响比较，但哈希/签名的输入字节有意义。变更身份规则必须单独审查，而不是更新 fixture 以通过测试。

完整离线门禁可一次执行（需要 Go 和既有 Python 校验依赖，无需 PHP）：

```sh
python scripts/go-migration/check.py --race --check-php-source --report /tmp/dokitool-go-checks.json
# 已安装 frontend/package-lock.json 中的依赖时，再加入原前端消费和四项续签检查：
python scripts/go-migration/check.py --race --frontend --report /tmp/dokitool-go-checks.json
```

门禁会运行各项独立检查并保存失败明细，任何未通过的公共响应使总结果为 `passed: false`、进程退出 1。当前 fragment 与极限文件大小的基线冲突保留为失败项，没有跳过或白名单放行。

## 冻结 PHP 对拍

冻结目录：`backend/testdata/php-baseline/`（公共层）与 `backend/testdata/php-douyin/`（实际抖音 Parse、请求序列、探测及舍入）。正常 Go 测试只读开发分支中冻结的原始输入、期望输出和 manifest，不安装或运行 PHP。

```sh
python scripts/go-migration/verify.py
python scripts/go-migration/verify.py --douyin
python scripts/go-migration/verify.py --integers
```

需要复核 PHP 生成来源时，按该目录 README 从固定 Git commit 重新导出至临时目录，核对差异；生产代码和普通 Go 验收不依赖这个生成器。测试密钥均明确标为公开合成材料，真实密钥只记录受保护来源引用。

可以将 **实际 Go 输出** 导出给既有独立 Python 检查：

```sh
cd backend
DOKITOOL_GO_BASELINE_OUTPUT=/tmp/dokitool-go-baseline.json \
  go test ./internal/unified -run TestPHPBaseline -count=1
cd ..
python scripts/validate-unified-schema.py /tmp/dokitool-go-baseline.json
```

Python 校验依赖仍由 `scripts/requirements-validation.txt` 声明。导出不覆盖 PHP 期望输出，也不把未知动态字段整批删掉。

抖音实际输出可独立导出后给原前端消费；以下脚本只增加测试生产器，没有修改前端产品代码：

```sh
cd backend
DOKITOOL_GO_DOUYIN_OUTPUT=/tmp/dokitool-go-douyin.json \
  go test ./internal/platform/douyin -run TestPHPDouyinBaseline -count=1
cd ..
node frontend/scripts/test-go-media-integration.mjs /tmp/dokitool-go-douyin.json /tmp/dokitool-frontend-go.json
```

## 阶段顺序

先通过骨架、公共合同、稳定身份、票据和冻结基线检查，再接抖音；其他平台随后逐一迁移。最后完成同条件真实链接对照、未修改前端的代表性下载、完整旧发布包和回滚演练，才能切换并退役 PHP。DASH 合流执行器及小红书 4K 新传输专项保持后续范围。
