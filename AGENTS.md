# B 站子插件开发约束

- 遵守同级 WhaleLife 的 AGENTS.md、architecture/STATUS.md、PLUGINS.md 和 RELEASING.md。只修改本插件及其测试、文档。
- 独立 ID bilibili，运行 ID surf/bilibili；安装 plugins/surf/sub/bilibili，声明依赖 surf、可选依赖 vision。不得读取其他插件私有配置或导入其实现。
- 沿用当前主体、人格、模型与可信工具会话；不创建新人格、记忆或自主调度。
- 浏览资料只经临时工具；实际视频由可选视觉服务处理。声音默认关闭，关闭时不得调用声音方法或向模型暴露可用于声音读取的私有媒体引用。
- 扫码与 Cookie 导入只保存在本插件私有 data。日志、状态、回执、测试与提交不得含真实 Cookie、二维码密钥、私人资料。
- 点赞、收藏、关注、评论、回复、投币独立开关且默认关闭；弹幕读取与登录自动续期亦为独立默认关闭选项；普通浏览不自动互动。不确定的提交不重放。真实账号操作需单独授权，隔离回归只用合成数据。
- Node 24；验证最低兼容宿主和当前宿主。测试资源登记并清理，本仓 .artifacts/tests 下保存临时数据，不运行 acceptance.ts。
- 明确文件列表暂存，审查完整 staged diff 后本地提交；不得 push、远端标签或 Release。发行包白名单并保留许可，安装时保留 data。
