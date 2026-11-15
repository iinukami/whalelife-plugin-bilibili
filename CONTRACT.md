# B 站子插件契约

插件 0.2.3，manifest ID `bilibili`，运行 ID `surf/bilibili`。必需依赖 `surf`，可选依赖 `vision`、`qq`；不导入提供者实现、不读取提供者私有文件。公开 `bilibili.status()` 只返回能力、开关和忙碌状态，不提供凭据。

模型工具以可信 `ToolSession.id` 固定本轮会话。模型自报 sessionId 无效，不能读取另一会话的引用。除了无外部资料的 `bilibili_status`，所有浏览和互动都是临时工具；观看是临时多模态工具。

| 工具 | 参数与语义 |
| --- | --- |
| bilibili_browse | source=`recommended|following`，可选page/cursor；返回视频引用及下一页信息 |
| bilibili_search | query、可选page；返回站内视频搜索结果 |
| bilibili_open | target为普通视频URL/BV/av号/短链；返回资料、分P及videoRef |
| bilibili_comments | videoRef、可选page；返回临时评论和commentRef |
| bilibili_notifications | source=`replies|likes`，可选cursor；需登录，按需读取“回复我的”或“收到的赞”，下一页使用返回的同类cursor |
| bilibili_replies | notificationRef或commentRef二选一，可选page；回查目标及所属视频后返回根评论、目标评论与当前页子回复 |
| bilibili_subtitles | videoRef、part、language、offset；默认第一P、优先中文，返回最多60条时间轴字幕及nextOffset |
| bilibili_danmaku | videoRef、可选part/fromSeconds/toSeconds/offset；需danmakuEnabled，默认0–30秒、窗口最多60秒，100条一页 |
| bilibili_watch | videoRef、part、fromSeconds/toSeconds；默认30秒，单次最多60秒，返回真实画面附件、实际覆盖说明及historySync；启用且登录/full时同次自动同步位置 |
| bilibili_mark_history | watchRef、稳定operationId；保留旧调用兼容，需登录、historySyncEnabled与full权限；正常watch已自动同步，无需补调 |
| bilibili_interact | action仅限like/favorite/follow/comment/reply、operationId、videoRef或commentRef，以及评论/回复text；受独立开关、账号与full权限约束 |
| bilibili_share_qq | videoRef、userId、operationId；需shareToQQEnabled、full权限及兼容QQ服务，按QQ设置以图文或小程序分享当前会话视频 |
| bilibili_share_qq_delivery | userId、原operationId；查询同一可信会话的QQ发送回执，不发送；关闭开关或引用过期后仍可查 |

普通结果为 `{status:'ok',data}` 或 `{status:'error',error:{code,message}}`。不能用工具外层 `ok` 当作平台成功。互动结果明确 `confirmed|rejected|uncertain`，重复请求给 `duplicate:true`；pending重启记录视为uncertain，不发远端请求。稳定 operationId 及内容指纹共同防重发，记录中不保存评论正文或凭据。

QQ 分享仅在 `ctx.optional('qq')` 绑定有效且 `videoShareApiVersion === '1.0.0'`、`sendVideoShare/videoShareDelivery` 均存在时注册临时工具。提供方契约见 QQ 插件的公开 `VIDEO-SHARING.md`（QQ 0.19.0 起）；本插件仅保留类型副本。`qqShareAvailable` 表示服务兼容且绑定有效，不代表QQ在线或收件人可发。旧QQ或旧宿主只缺此能力，不影响既有浏览；QQ停止撤销分享工具并取消在途调用，不重放。

`shareToQQEnabled` 默认false；关闭会取消在途分享，查询仍可用。发送参数严格只接受videoRef/userId/operationId，查询只接受userId/operationId；sessionId、personaId、permission均来自可信工具会话。operationId为1–96位ASCII字母、数字、点、下划线、冒号或短横线，向QQ加 `bilibili:` 前缀。userId为5–20位非零开头数字字符串，QQ进一步核对好友白名单和非自身。发送由有效且同账号代际的视频引用取得标题、UP主、BV、aid及hdslb.com封面，构造 `pages/video/video?avid=<aid>` 与规范B站webUrl，不接受模型填写外部卡片字段。不做B站网络请求、登录续期、视频下载或统计上报。标题和封面属于外部资料，不构成发送授权。

QQ返回状态投影为sent/not_sent/uncertain/not_found，只有sent且具有效平台消息ID才confirmed；not_found仅用于查询。固定 `retryAutomatically:false/canRetry:false`，B站无自动重试、换格式回退或换ID补发；不调用旧小程序发送入口。持久防重记录属于QQ插件，原动作跨B站插件重载仍可查询；B站插件不另存标题、链接或签名。异常跨过提供方调用边界后保守报uncertain，已可靠确认发送的回执不因随后取消改成未发。仅投影预期字段及固定安全错误，不把提供方原始异常、ARK或外部正文写入回执。`format`反映原动作的card或miniapp，`coverIncluded`仅表示图文准备包含封面，不代表接收端已显示；无记录、服务不可用等未给格式时不推断。平台成功但落盘失败仍保留sent、平台消息ID、ledgerSaved:false及固定storage错误，禁止重发。

格式完全由QQ配置 `videoShareFormat` 决定，默认card，可选miniapp；消费者不传format、ARK或额外消息段。card为一次普通图文消息，点击其中完整文字链接打开视频，封面本身不跳转。空封面以空字符串传递，由QQ按模式决定是否接受；其他不合法封面仍拒绝。QQ可在平台提交前处理封面失败为同次纯文字消息，但消费者不补发。miniapp由QQ生成签名并原样发送，仍有手机播放/打开App兼容问题。新服务缺失时仅停用分享，不把旧小程序入口冒充支持图文；不自动点击网页分享控件，不保证B站分享计数增加。

确认的互动通过 `memory.recordExperience` 记录固定动作说明；事件标识使用动作散列，重复补记幂等。记忆失败只影响 `experienceRecorded`，不把已经完成的外部动作重新提交。

消息中心按需读取，不后台轮询、主动提交已读或发送互动；互动开关关闭时仍可读取。通知的用户、正文、原内容与来源均仅作临时资料；聚合点赞只返回平台提供的用户列表，不承诺全部点赞者。普通视频来源的 `videoTarget` 可用于既有 open 工具；有可靠定位信息的普通视频回复另返回 `notificationRef`。非视频、聚合点赞和定位不全的通知不生成评论入口。分页 cursor 和 notificationRef 为不透明内存引用，绑定可信会话、账号代际及 TTL，与视频/评论引用共享容量上限；不接收模型拼装的平台原始分页字段。

`bilibili_replies` 通过评论详情核对 aid/rpid/root/作者，再读取根楼层页。`target` 始终是原始目标，即使其不在当前页；`targetOnPage` 单独说明这一点。`contextComplete` 仅在第一页且无更多页时为true，表示平台当前可见楼层页读完，不保证包含已删除或不可见内容。已删除、不可见、身份不符或异常响应不产生可用引用。继续回复用 `target.commentRef` 调用原有 interact/reply，root为所属根评论、parent为目标评论；仍受原有独立开关、full权限和持久防重发约束。

引用只在内存中保存，默认600秒，单会话最多128、全局512；过期、账号代际变化及重载失效。匿名状态也绑定登录状态代际，登录后再退出不会恢复此前的匿名引用。字幕、简介、评论、标题和声音证据标为外部资料，没有指令权威。持久回执只含动作和状态；浏览结果、原文、URL、引用与图片不进入回执。最终助手正文遵守主干现行保存契约。

`bilibili_watch` 消费 vision 的公开 `offerMedia/prepare/understand/release`，仅内部保留媒体引用。声音关闭仅调 `prepare`；开启要求 audiovisualApiVersion 1.0.0 与 understand 存在，显式 `audio:['speech']`。不另选主模型、不将base64当普通JSON交给模型、不代为收藏或发送。采样与语音后端失败准确呈现，部分成功不冒充全片理解。

`historySyncEnabled` 默认false，旧配置缺字段按false迁移。开启且登录时，watch 的真实JPEG、逐帧时间及覆盖范围通过校验才生成 `watchRef`；只认实际帧最大时间戳向下取整，必须小于分P时长，不接受模型自填进度。此引用证明采样准备结果，不证明主模型已理解。观看引用独立上限为每会话32/总128，TTL沿用配置；过期、账号变化、关闭开关、重载后失效。容量不足只省略watchRef，不影响观看；自动同步返回sampling_unavailable。

0.2.3 起，watch 在同一次调用中取得合格采样后自动执行历史同步，不调用模型、不启动另一次工具调用。仍要求当前可信会话full权限、已登录和historySyncEnabled；只读字幕、下载或无合格采样不提交。自动动作编号由已校验凭据的账号、会话、视频/分P及实际位置派生，不随重复观看或重载随机变化；原watchRef与手动工具保留兼容。metadata及安全持久回执同时包含historySync：实际执行时为HistoryOutcome；未执行时为`{state:"skipped",reason:"history_disabled"|"login_required"|"permission_required"|"sampling_unavailable"}`；同步前失败为`{state:"error",code}`。台账不可用返回persistence_error。同步单独失败仍返回已准备画面，取消/停用/换号则返回观看错误并保留已取得的同步结果，不返回旧身份画面。同步不能证明主模型已理解图片。

历史写入使用独立持久记录和既有动作队列，先落pending再请求；同operationId改变内容拒绝，相同动作指纹防重，重启pending按uncertain处理。`accepted`仅表示接口接受；`verified`表示本次提交且历史回读位置不低于采样位置；`already_recorded`表示已有位置足够、没有提交；`rejected`是确定拒绝；`uncertain`不自动重发。只在submitted且verified后通过公开记忆接口写固定经历，补记失败不重发。近期历史查询限30条，缺席不证明没有旧记录；已知更高位置不回退，但不承诺发现更早历史或跨设备并发。POST只含aid/cid/progress/csrf，不发送观看心跳、播放时长或完成标记，不保证播放量。

设置路径均位于 `/plugins/surf/bilibili/`，继承宿主鉴权与来源检查。GET settings/config/state/folders，POST config/login/start/login/poll/login/import/login/logout。配置与账号修改采用各自 revision，拒绝过期编辑；二维码只由本地编码器生成，登录密钥不返回状态。Cookie不随重定向传播到CDN。网络请求仅HTTPS、公网DNS校验并固定连接地址，压缩前后限量、限时、可取消，无自动业务重试。

搜索采用 `/x/web-interface/wbi/search/type`。已有 Cookie 中的 `buvid3` 优先；缺少时从固定的 `/x/web-frontend/getbuvid` 读取服务器下发值。导航接口 `/x/web-interface/nav` 提供 WBI 键，匿名 `code:-101` 且带有效键仍可用于公开搜索，不当作登录成功。准备状态按当前完整登录 Cookie 隔离，只保留在客户端内存；签名键缓存5分钟，并发准备合并，各阶段检查取消、停止和当前账号代际；切换账号或注销后不再发出后续旧凭据请求。换凭据后的调用不复用旧身份的站点 Cookie。搜索返回 `v_voucher` 明确视为 `access_blocked`，不交出验证令牌、不自动重试或刷新设备值；本地账号文件不变。

MP4 下载前先校验主地址；若不通过，只检查同一播放响应中前8个备用地址，选择首个通过相同校验的候选。所有候选仍受标准 HTTPS 端口、公网 DNS 和下载限额约束；开始下载后失败不会自动换地址重试，CDN 请求不附带账号 Cookie。

平台HTTP/JSON数据结构仅在本插件内适配，版本变化以明确错误报告。缺少宿主临时工具时停用浏览，缺少视觉只关闭观看。插件停止撤销入口并取消所属请求；已经确认的远端动作不伪装撤销、不自动重放。

0.2.1 起，默认客户端通过公开 `ctx.logger.warn` 写“B 站请求失败”诊断，每次失败请求至多一条，沿用宿主日志级别与保留设置。字段为随机 `requestId`、固定 `endpoint`、`method`、初始请求携带非空 SESSDATA 的布尔值 `hasSessionCookie`、`elapsedMs`，以及 `stage`：`http` 为非2xx响应（含原 `httpStatus`），`api` 为已知 JSON 接口的非零数字业务码（含 `httpStatus/apiCode`），`transport` 为传输异常（仅固定安全 `errorCode`），`response` 为有界 JSON envelope 格式异常。固定 API 路径白名单可附 `host/path`；CDN、短链、续期动态路径及未知地址均不记录原主机或路径。HTTP 非2xx不扩大响应体读取；JSON观察最多2MiB，不解析媒体或弹幕二进制。二维码等待、已扫码、正常过期均不是失败诊断；`code:0` 后的具体业务data校验一般不属于本层诊断；0.2.2 起，搜索响应自有 `data.v_voucher` 字段时记录 `stage:response`、`errorCode:access_blocked` 和原 HTTP 状态，不保存该字段值。站点 Cookie 获取使用固定分类 `search_cookie`，新旧搜索路径均归类 `search`。只有明确用于匿名搜索取键、未带 SESSDATA、`code:-101`、`isLogin:false` 且带有效 WBI 键的导航响应不记失败；显式账号校验及已登录凭据失效仍保留诊断。取键用途标记仅供内部观察，不作为 HTTP 头或参数发送。

诊断不含查询参数、请求体、响应正文、原始错误说明、异常栈、请求头、Cookie值、用户/视频标识或会话ID，不进入模型回执或经历。排查时按时间和接口对应宿主工具记录；请求编号只标识一条诊断，不作为跨系统追踪ID。携带Cookie不证明登录有效，错误码不证明平台内部风控策略。日志写入失败不改变原响应或异常、取消行为及POST是否已提交的判断；不新增请求、重试、后台监听或风控绕过。

`danmakuEnabled`、`autoRefreshEnabled` 均默认false，旧配置缺字段按false迁移。弹幕仅经safe临时工具返回文字、精确字符串id与视频秒数；时间窗为[from,to)，获取必要的6分钟分段，每段限2MiB/12000条，只保留模式1–6，最多返回12000条，每页100条，每条最多500字。truncated表明裁切，excludedModes统计窗口内未返回的特殊模式；不暴露发送者哈希，不执行代码弹幕，不能视为全量历史。无需vision/声音，不自动记历史。

0.1.8 移除投币能力，`bilibili_interact` 不再支持 `action=coin`，工具契约不再提供 `coinCount`。旧配置中的 `interactions.coin` 只作兼容读取并忽略，不返回为可用开关。旧 `data/actions.json` 中的投币记录及其字段继续兼容并保留；不因移除功能清空账本，也不重放旧投币动作。其余五项互动仍独立默认关闭，弹幕与自动续期不受影响。

自动续期由账号管理器在业务请求前按需检查（不是后台监控）。成功检查24小时内不重复，检查失败15分钟冷却，重启不保留检查间隔。QR确认保存refresh_token；Cookie导入可选refreshToken，未提供时不能自动续期。固定cookie/info与correspond请求取得续期信息，pending先保存，然后提交cookie/refresh、校验同一账号、保存新Cookie及token，再confirm/refresh旧token，最后清除标记。中断标记重启按uncertain处理且不重放；本地无法确认完成时请重新登录。仅两个固定passport路径允许POST，凭据只保存在account.json，不返回模型、页面、回执、日志。state/status的renewal仅含enabled/available/status/lastCheckedAt；GET状态不发平台请求。凭据轮换改变编辑revision但保留当前运行中的账号身份代际；人工账号变更仍失效旧引用。关闭开关或停止会取消后续步骤，不能撤销已提交的远端变化。
