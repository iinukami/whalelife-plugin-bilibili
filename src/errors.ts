/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
const messages: Record<string, string> = {
  invalid_input: '输入不符合要求。', network_error: 'B 站网络请求失败。', timeout: '请求超时。', cancelled: '操作已取消。', stopped: '插件已停止。',
  access_blocked: 'B 站要求验证或限制访问，请稍后人工检查。', login_required: '需要有效的 B 站登录。', platform_error: 'B 站拒绝了此次操作。',
  media_download_rejected: '视频下载阶段收到 HTTP 567，服务器未接受本次视频下载请求。',
  unsupported_media: '此视频未提供当前支持的完整 MP4 媒体。', too_large: '媒体或响应超过本次读取上限。', unsafe_url: '来源地址未通过校验。',
  malformed_response: 'B 站响应不完整或结构已变化。', reference_unavailable: '引用已过期、不属于当前会话或账号已改变，请重新浏览。',
  host_required: '宿主缺少临时工具能力，无法安全提供浏览。', session_required: '缺少可信当前会话。', vision_unavailable: '视觉服务当前不可用。',
  busy: '当前操作数已达上限。', interaction_disabled: '此互动尚未在子插件设置中开启。', folder_required: '请先在设置中选择收藏夹。',
  duplicate_action: '该动作已提交过，请先核对已有结果，不自动重复发送。', uncertain: '请求已开始提交，但未取得可靠回执；结果不确定，请人工核对，不要重复发送。',
  config_conflict: '设置或账号已改变，请重新读取后再操作。', config_invalid: '配置格式无效。', account_changed: '账号已改变，本次操作已停止。',
  subtitle_unavailable: '没有可用字幕；声音处理关闭时不会自动转写。', persistence_error: '本地状态保存失败，未继续发起新动作。',
  comment_mismatch: '评论目标与视频或通知不一致，未继续操作。',
  history_disabled: '尚未开启同步 B 站观看历史。',
  danmaku_disabled: '尚未开启读取 B 站弹幕。',
  qq_unavailable: 'QQ 视频分享服务暂不可用，请检查 QQ 插件版本与连接。',
  qq_share_disabled: '尚未开启将 B 站视频分享到 QQ。',
  permission_required: '分享到 QQ 需要当前会话的完全执行权限。',
  qq_share_error: 'QQ 视频分享未完成，请检查发送回执。',
  qq_share_invalid_card: 'QQ 返回的视频卡片未通过校验，本次未发送。',
  qq_recipient_unavailable: '收件人不在 QQ 好友白名单内或为自身账号。',
  qq_share_conflict: '该分享动作编号已用于其他内容，请核对原回执，不要盲目重发。',
  qq_share_storage: 'QQ 分享回执读取或保存失败，请核对已有结果，不要重发。',
};
export class BiliError extends Error { code: string; constructor(code: string) { super(messages[code] ?? messages.platform_error); this.name = 'BiliError'; this.code = messages[code] ? code : 'platform_error'; } }
export function safeError(error: unknown) { const e = error instanceof BiliError ? error : new BiliError('network_error'); return { code: e.code, message: e.message }; }
export function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BiliError('invalid_input'); return value as Record<string, unknown>; }
