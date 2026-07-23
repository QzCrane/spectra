// goal: provides localized display names for all supported hotkey actions across different languages

import { ja } from './i18n-actions/ja';
import { ko } from './i18n-actions/ko';
import { es } from './i18n-actions/es';
import { fr } from './i18n-actions/fr';
import { de } from './i18n-actions/de';
import { ru } from './i18n-actions/ru';

// note: English serves as the primary fallback if a translation is missing in the target locale
const en: Record<string, string> = {
	none: '(unbound)', play_pause: 'Play/Pause', seek_forward_5s: 'Forward 5s',
	seek_forward_10s: 'Forward 10s', seek_forward_30s: 'Forward 30s',
	seek_backward_5s: 'Backward 5s', seek_backward_10s: 'Backward 10s',
	seek_backward_30s: 'Backward 30s', seek_frame_forward: 'Next Frame',
	seek_frame_backward: 'Prev Frame', speed_up: 'Speed +', speed_down: 'Speed -',
	speed_reset: 'Speed Reset', speed_set: 'Set Speed', volume_up: 'Volume +',
	volume_down: 'Volume -', volume_mute: 'Mute', volume_set: 'Set Volume',
	audio_reset: 'Audio Reset', gain_up: 'Gain +', gain_down: 'Gain -',
	pitch_up: 'Pitch +', pitch_down: 'Pitch -', pitch_reset: 'Pitch Reset',
	delay_up: 'Delay +', delay_down: 'Delay -', delay_reset: 'Delay Reset',
	pan_left: 'Pan Left', pan_right: 'Pan Right', pan_reset: 'Pan Reset',
	mono_toggle: 'Mono', capture_toggle: 'Capture', fullscreen_toggle: 'Fullscreen',
	pip_toggle: 'PiP', rotate_cw: 'Rotate CW', rotate_ccw: 'Rotate CCW',
	mirror_toggle: 'Mirror', screenshot: 'Screenshot', dim_background: 'Dim BG',
	marker_add: 'Add Marker', marker_jump_prev: 'Prev Marker', marker_jump_next: 'Next Marker',
	ab_set_a: 'Set A', ab_set_b: 'Set B', ab_clear: 'Clear AB', ab_skip: 'Skip AB',
	loop_toggle: 'Loop', fx_toggle: 'FX Toggle', fx_reset: 'FX Reset', tab_pin: 'Pin Tab',
	tab_mute: 'Mute Tab', show_info: 'Info', open_popup: 'Popup', open_options: 'Options',
	run_js: 'Run JS', open_url: 'Open URL',
};

const zh: Record<string, string> = {
	none: '(未绑定)', play_pause: '播放/暂停', seek_forward_5s: '前进 5 秒',
	seek_forward_10s: '前进 10 秒', seek_forward_30s: '前进 30 秒',
	seek_backward_5s: '后退 5 秒', seek_backward_10s: '后退 10 秒',
	seek_backward_30s: '后退 30 秒', seek_frame_forward: '下一帧', seek_frame_backward: '上一帧',
	speed_up: '加速', speed_down: '减速', speed_reset: '重置速度', speed_set: '设置速度',
	volume_up: '音量 +', volume_down: '音量 -', volume_mute: '静音', volume_set: '设置音量',
	audio_reset: '重置音频', gain_up: '增益 +', gain_down: '增益 -',
	pitch_up: '音调 +', pitch_down: '音调 -', pitch_reset: '重置音调',
	delay_up: '延迟 +', delay_down: '延迟 -', delay_reset: '重置延迟',
	pan_left: '左声道', pan_right: '右声道', pan_reset: '重置声道',
	mono_toggle: '单声道', capture_toggle: '劫持模式', fullscreen_toggle: '全屏',
	pip_toggle: '画中画', rotate_cw: '顺时针旋转', rotate_ccw: '逆时针旋转',
	mirror_toggle: '镜像', screenshot: '截图', dim_background: '背景暗化',
	marker_add: '添加标记', marker_jump_prev: '上一标记', marker_jump_next: '下一标记',
	ab_set_a: '设置 A 点', ab_set_b: '设置 B 点', ab_clear: '清除 AB', ab_skip: '跳过 AB',
	loop_toggle: '循环', fx_toggle: 'FX 开关', fx_reset: 'FX 重置', tab_pin: '固定标签',
	tab_mute: '标签静音', show_info: '显示信息', open_popup: '打开弹窗', open_options: '选项',
	run_js: '执行 JS', open_url: '打开 URL',
};

const zhTw: Record<string, string> = {
	none: '(未綁定)', play_pause: '播放/暫停', seek_forward_5s: '前進 5 秒',
	seek_forward_10s: '前進 10 秒', seek_forward_30s: '前進 30 秒',
	seek_backward_5s: '後退 5 秒', seek_backward_10s: '後退 10 秒',
	seek_backward_30s: '後退 30 秒', seek_frame_forward: '下一幀', seek_frame_backward: '上一幀',
	speed_up: '加速', speed_down: '減速', speed_reset: '重設速度', speed_set: '設定速度',
	volume_up: '音量 +', volume_down: '音量 -', volume_mute: '靜音', volume_set: '設定音量',
	audio_reset: '重設音訊', gain_up: '增益 +', gain_down: '增益 -',
	pitch_up: '音高 +', pitch_down: '音高 -', pitch_reset: '重設音高',
	delay_up: '延遲 +', delay_down: '延遲 -', delay_reset: '重設延遲',
	pan_left: '向左平衡', pan_right: '向右平衡', pan_reset: '重設平衡',
	mono_toggle: '單聲道', capture_toggle: '擷取模式', fullscreen_toggle: '全螢幕',
	pip_toggle: '子母畫面', rotate_cw: '順時針旋轉', rotate_ccw: '逆時針旋轉',
	mirror_toggle: '鏡像', screenshot: '螢幕截圖', dim_background: '背景變暗',
	marker_add: '新增標記', marker_jump_prev: '上一個標記', marker_jump_next: '下一個標記',
	ab_set_a: '設定 A 點', ab_set_b: '設定 B 點', ab_clear: '清除 AB', ab_skip: '跳過 AB',
	loop_toggle: '循環', fx_toggle: '效果開關', fx_reset: '重設效果', tab_pin: '釘選分頁',
	tab_mute: '分頁靜音', show_info: '顯示資訊', open_popup: '開啟彈出視窗', open_options: '選項',
	run_js: '執行 JS', open_url: '開啟網址',
};

const LANG_MAP: Record<string, Record<string, string>> = {
	'en-US': en, 'zh-CN': zh, 'zh-TW': zhTw, 'ja-JP': ja, 'ko-KR': ko,
	'es-ES': es, 'fr-FR': fr, 'de-DE': de, 'ru-RU': ru,
};

// post: returns the localized name for an action, falling back to English or an auto-formatted identifier if necessary
export function getActionName(action: string, lang: string): string {
	const dict = LANG_MAP[lang];
	return dict?.[action] ?? en[action] ?? action.replace(/_/g, ' ');
}
