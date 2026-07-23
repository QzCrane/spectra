// goal: resolve the tiny, current-locale OSD payload in the background context

export interface ContentOSDMessages {
	muted: string;
	corsAutoAdded: string;
	corsAddedSafe: string;
	corsCorrectedSafe: string;
}

const ENGLISH_OSD_MESSAGES: Readonly<ContentOSDMessages> = {
	muted: 'MUTE',
	corsAutoAdded: '🔧 Auto-added {domain} to capture list',
	corsAddedSafe: '✓ Added {domain} to safe list',
	corsCorrectedSafe: '✓ Corrected {domain} to safe',
};

const OSD_MESSAGES: Readonly<Record<string, Readonly<ContentOSDMessages>>> = {
	'en-US': ENGLISH_OSD_MESSAGES,
	'zh-CN': {
		muted: '静音',
		corsAutoAdded: '🔧 已自动添加 {domain} 到劫持列表',
		corsAddedSafe: '✓ 已添加 {domain} 到安全列表',
		corsCorrectedSafe: '✓ 已更正 {domain} 为安全站点',
	},
	'zh-TW': {
		muted: '靜音',
		corsAutoAdded: '🔧 已自動新增 {domain} 至擷取清單',
		corsAddedSafe: '✓ 已新增 {domain} 至安全清單',
		corsCorrectedSafe: '✓ 已將 {domain} 更正為安全網站',
	},
	'ja-JP': {
		muted: 'ミュート',
		corsAutoAdded: '🔧 {domain} をキャプチャリストに自動追加しました',
		corsAddedSafe: '✓ {domain} を安全なリストに追加しました',
		corsCorrectedSafe: '✓ {domain} を安全なサイトに修正しました',
	},
	'ko-KR': {
		muted: '음소거',
		corsAutoAdded: '🔧 {domain}을(를) 캡처 목록에 자동 추가했습니다',
		corsAddedSafe: '✓ {domain}을(를) 안전한 목록에 추가했습니다',
		corsCorrectedSafe: '✓ {domain}을(를) 안전한 사이트로 수정했습니다',
	},
	'es-ES': {
		muted: 'SILENCIO',
		corsAutoAdded: '🔧 {domain} añadido automáticamente a la lista de captura',
		corsAddedSafe: '✓ {domain} añadido a la lista segura',
		corsCorrectedSafe: '✓ {domain} corregido como seguro',
	},
	'ru-RU': {
		muted: 'БЕЗ ЗВУКА',
		corsAutoAdded: '🔧 {domain} автоматически добавлен в список захвата',
		corsAddedSafe: '✓ {domain} добавлен в белый список',
		corsCorrectedSafe: '✓ {domain} исправлен как безопасный',
	},
	'de-DE': {
		muted: 'STUMM',
		corsAutoAdded: '🔧 {domain} automatisch zur Capture-Liste hinzugefügt',
		corsAddedSafe: '✓ {domain} zur sicheren Liste hinzugefügt',
		corsCorrectedSafe: '✓ {domain} als sicher korrigiert',
	},
	'fr-FR': {
		muted: 'MUET',
		corsAutoAdded: '🔧 {domain} ajouté automatiquement à la liste de capture',
		corsAddedSafe: '✓ {domain} ajouté à la liste sûre',
		corsCorrectedSafe: '✓ {domain} corrigé comme sûr',
	},
};

export function getContentOSDMessages(language: string): ContentOSDMessages {
	return { ...(OSD_MESSAGES[language] ?? ENGLISH_OSD_MESSAGES) };
}

export function withContentOSDMessages<T extends { lang: string }>(
	settings: T,
): T & { osdMessages: ContentOSDMessages } {
	return {
		...settings,
		osdMessages: getContentOSDMessages(settings.lang),
	};
}
