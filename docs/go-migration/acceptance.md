# Go 迁移验收记录

## 基线与范围

- PHP main：`665bd55134982b9fe107aa1cd00373ba8da8ff3c`。
- PHP tree：`93744d4d718c3299f82640d2888e93252106db70`。
- 工具链：Go 1.27.3；参考执行器 PHP 8.3.6。工具链从 Go 官方发布清单下载并核验 SHA-256。
- 第二阶段检查点已通过：骨架、unified、稳定 ID 和票据对拍。随后进入抖音迁移。
- 生产仍由 PHP 提供服务；没有生产切流、配置 reload 或生产回滚。

## 第二阶段的固定证据

| 检查 | 结果与覆盖 | 证据位置 |
| --- | --- | --- |
| 冻结 PHP 纯函数/合同 | 208 场景逐字段比较通过；涵盖 29 设计样例、拒绝合同、默认、普通/debug、身份、来源、事实合并、音轨配对 | `backend/testdata/php-baseline/cases.json`，`internal/unified/baseline_test.go` |
| 票据 | 21 场景通过；有效签发字节和验证结果与 PHP 相同，保留 TTL/上游到期/非法输入拒绝 | `tickets.json`，`internal/media/weibo/ticket_test.go` |
| 平台目录 | 与 PHP 实际 CLI 输出逐字段一致，继续读取唯一平台注册 JSON | `catalog.json`，`internal/catalog/catalog_test.go` |
| 基线完整性 | 40 个固定 PHP/Schema 输入文件摘要通过；两次由同一固定 Git archive 生成的数据与 manifest 逐字节一致 | `manifest.json`，`scripts/go-migration/verify.py` |
| 独立 Schema/语义 | 76/76 份实际 Go 公共层输出通过既有 Python Draft 2020-12 及独立语义验证 | `DOKITOOL_GO_BASELINE_OUTPUT` 导出，`scripts/validate-unified-schema.py` |
| HTTP 骨架 | 旧路由 410、未知路径 404、GET/版本/输入边界、缺 adapter 503、resolve 目标及完整工作保留、过滤前拒绝非法合同 | `internal/api/handler_test.go` |
| 请求边界 | 混合公网/私网 DNS 拒绝、批准 IP 传递、跨主机凭据移除、逐跳限制、原 query、压缩前后读取限额、DNS 取消 | `internal/fetch/fetch_test.go` |
| Go 检查 | 全包 345 个叶子场景通过，race 与 vet 通过；Schema 扩展门禁及 URL/HTTP/manifest 差异已修复 | Go 测试和静态检查命令见 README |

阶段 2 机器可读结果见 [phase2-checks.json](phase2-checks.json)。该检查点尚无抖音 Go 平台实现，证明先公共层、后平台的执行顺序。

这些均为离线或受控测试，不证明当前真实平台可访问，也不证明浏览器已保存媒体。票据兼容不等于微博媒体 relay 已迁移。

## 尚未关闭的切换门槛

其他平台迁移、真实链接双实现对照、代表性浏览器保存、微博流式协议、目标部署配置与运行条件、完整旧发布包以及实际回滚演练，均不能从第二阶段测试推断完成。后续结果在本文件按阶段追加，保留证据类别，不用新一轮合成通过数覆盖历史未验证项。
