# B 站子插件契约

插件 0.1.1，manifest ID `bilibili`，运行 ID `surf/bilibili`。必需依赖 `surf`，可选依赖 `vision`；不导入提供者实现、不读取提供者私有文件。公开 `bilibili.status()` 只返回能力、开关和忙碌状态，不提供凭据。

模型工具以可信 `ToolSession.id` 固定本轮会话。模型自报 sessionId 无效，不能读取另一会话的引用。除了无外部资料的 `bilibili_status`，所有浏览和互动都是临时工具；观看是临时多模态工具。

| 工具 | 参数与语义 |
| --- | --- |
| bilibili_browse | source=`recommended|following`，可选page/cursor；返回视频引用及下一页信息 |
| bilibili_search | query、可选page；返回站内视频搜索结果 |
| bilibili_open | target为普通视频URL/BV/av号/短链；返回资料、分P及videoRef |
| bilibili_comments | videoRef、可选page；返回临时评论和commentRef |
| bilibili_subtitles | videoRef、part、language、offset；默认第一P、优先中文，返回最多60条时间轴字幕及nextOffset |
| bilibili_watch | videoRef、part、fromSeconds/toSeconds；默认30秒，单次最多60秒，返回真实画面附件及实际覆盖说明 |
| bilibili_interact | action、operationId、videoRef或commentRef，以及评论/回复text；受独立开关、账号与full权限约束 |

普通结果为 `{status:'ok',data}` 或 `{status:'error',error:{code,message}}`。不能用工具外层 `ok` 当作平台成功。互动结果明确 `confirmed|rejected|uncertain`，重复请求给 `duplicate:true`；pending重启记录视为uncertain，不发远端请求。稳定 operationId 及内容指纹共同防重发，记录中不保存评论正文或凭据。

确认的互动通过 `memory.recordExperience` 记录固定动作说明；事件标识使用动作散列，重复补记幂等。记忆失败只影响 `experienceRecorded`，不把已经完成的外部动作重新提交。

引用只在内存中保存，默认600秒，单会话最多128、全局512；过期、账号代际变化及重载失效。字幕、简介、评论、标题和声音证据标为外部资料，没有指令权威。持久回执只含动作和状态；浏览结果、原文、URL、引用与图片不进入回执。最终助手正文遵守主干现行保存契约。

`bilibili_watch` 消费 vision 的公开 `offerMedia/prepare/understand/release`，仅内部保留媒体引用。声音关闭仅调 `prepare`；开启要求 audiovisualApiVersion 1.0.0 与 understand 存在，显式 `audio:['speech']`。不另选主模型、不将base64当普通JSON交给模型、不代为收藏或发送。采样与语音后端失败准确呈现，部分成功不冒充全片理解。

设置路径均位于 `/plugins/surf/bilibili/`，继承宿主鉴权与来源检查。GET settings/config/state/folders，POST config/login/start/login/poll/login/import/login/logout。配置与账号修改采用各自 revision，拒绝过期编辑；二维码只由本地编码器生成，登录密钥不返回状态。Cookie不随重定向传播到CDN。网络请求仅HTTPS、公网DNS校验并固定连接地址，压缩前后限量、限时、可取消，无自动业务重试。

平台HTTP/JSON数据结构仅在本插件内适配，版本变化以明确错误报告。缺少宿主临时工具时停用浏览，缺少视觉只关闭观看。插件停止撤销入口并取消所属请求；已经确认的远端动作不伪装撤销、不自动重放。
