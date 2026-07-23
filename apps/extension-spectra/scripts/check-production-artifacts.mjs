import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KiB = 1024;
const IMPORT_PATTERN = /(?:\bimport\s*(?:[^"'()]*?from\s*)?|\bimport\s*\()\s*["']([^"']+)["']/gu;
const HTML_REFERENCE_PATTERN = /\b(?:href|poster|src)\s*=\s*["']([^"']+)["']/giu;
const CSS_REFERENCE_PATTERN = /(?:@import\s+(?:url\()?|url\()\s*["']?([^"')\s]+)["']?\s*\)?/giu;
const STRING_LITERAL_PATTERN = /(["'`])((?:\\.|(?!\1)[\s\S])*)\1/gu;
const SOURCE_MAP_REFERENCE_PATTERN = /[#@]\s*sourceMappingURL=/u;
const DIAGNOSTIC_CALL_PATTERN = /\bconsole\.(?:debug|info|log)\s*\(/u;
const URL_SCHEME_PATTERN = /^(?:blob:|chrome:|data:|https?:|javascript:|mailto:)/iu;

export const FORBIDDEN_PRODUCTION_ARTIFACT_PATTERNS = Object.freeze([
	/(?:^|\/)(?:\.git|\.turbo|coverage|node_modules|test|tests|__tests__)(?:\/|$)/iu,
	/(?:^|\/)(?:\.DS_Store|Thumbs\.db)$/iu,
	/(?:^|\/)(?:build-analysis|metafile|stats)(?:\.[^/]*)?$/iu,
	/(?:^|\/)[^/]+\.(?:log|map|md|ts|tsx|tsbuildinfo)$/iu,
	/(?:^|\/)[^/]+(?:^|\.)(?:spec|test)\.[^/]+$/iu,
]);

function format(bytes) {
	return `${(bytes / KiB).toFixed(1)}KiB`;
}

function artifactName(root, path) {
	return relative(root, path).replaceAll('\\', '/');
}

function walkArtifacts(directory, root = resolve(directory), failures = []) {
	const paths = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = resolve(directory, entry.name);
		if (entry.isSymbolicLink()) {
			failures.push(`${artifactName(root, path)}: symbolic links are forbidden`);
			continue;
		}
		if (entry.isDirectory()) {
			paths.push(...walkArtifacts(path, root, failures));
			continue;
		}
		if (!entry.isFile()) {
			failures.push(`${artifactName(root, path)}: unsupported filesystem entry`);
			continue;
		}
		paths.push(path);
	}
	return paths.sort((left, right) => artifactName(root, left).localeCompare(artifactName(root, right)));
}

function globPattern(value) {
	return new RegExp(`^${value
		.split(/([*?])/u)
		.map((part) => part === '*' ? '.*' : part === '?' ? '.' : part.replace(/[\\^$+?.()|[\]{}]/gu, '\\$&'))
		.join('')}$`, 'u');
}

function cleanSpecifier(specifier) {
	return specifier.trim().replace(/[?#].*$/u, '').replaceAll('\\', '/');
}

function candidateNames(fromName, specifier) {
	const cleaned = cleanSpecifier(specifier);
	if (!cleaned || cleaned.startsWith('#') || URL_SCHEME_PATTERN.test(cleaned)) return [];
	const names = cleaned.startsWith('/')
		? [cleaned.slice(1)]
		: cleaned.startsWith('.')
			? [posix.join(posix.dirname(fromName), cleaned)]
			: [cleaned, posix.join(posix.dirname(fromName), cleaned)];
	return [...new Set(names.map((name) => posix.normalize(name).replace(/^\.\//u, '')))]
		.filter((name) => name !== '..' && !name.startsWith('../'));
}

function resolveReference(index, fromName, specifier, { required = false } = {}) {
	const cleaned = cleanSpecifier(specifier);
	if (!cleaned || cleaned.startsWith('#') || URL_SCHEME_PATTERN.test(cleaned)) return [];
	const dynamic = /\$\{[^}]+\}/u.test(specifier);
	const candidates = candidateNames(fromName, dynamic ? specifier.replace(/\$\{[^}]+\}/gu, '*') : specifier);
	const matches = [];
	for (const candidate of candidates) {
		if (candidate.includes('*') || candidate.includes('?')) {
			const pattern = globPattern(candidate);
			for (const name of index.keys()) if (pattern.test(name)) matches.push(name);
		} else if (index.has(candidate)) {
			matches.push(candidate);
		}
	}
	if (required && matches.length === 0) {
		throw new Error(`${fromName}: referenced production artifact is missing (${specifier})`);
	}
	return [...new Set(matches)];
}

function manifestReferences(manifest, index) {
	const references = [];
	const add = (value, label) => {
		if (typeof value !== 'string' || value.length === 0) return;
		const matches = resolveReference(index, 'manifest.json', value, { required: true });
		if (matches.length === 0) throw new Error(`manifest.json: ${label} is missing (${value})`);
		references.push(...matches);
	};
	const addIcons = (icons, label) => {
		for (const [size, value] of Object.entries(icons ?? {})) add(value, `${label}.${size}`);
	};

	add(manifest.background?.service_worker, 'background.service_worker');
	add(manifest.action?.default_popup, 'action.default_popup');
	addIcons(manifest.action?.default_icon, 'action.default_icon');
	addIcons(manifest.icons, 'icons');
	add(manifest.options_page, 'options_page');
	add(manifest.options_ui?.page, 'options_ui.page');
	add(manifest.devtools_page, 'devtools_page');
	add(manifest.side_panel?.default_path, 'side_panel.default_path');
	for (const value of Object.values(manifest.chrome_url_overrides ?? {})) add(value, 'chrome_url_overrides');
	for (const page of manifest.sandbox?.pages ?? []) add(page, 'sandbox.pages');
	for (const [scriptIndex, script] of (manifest.content_scripts ?? []).entries()) {
		for (const value of script.js ?? []) add(value, `content_scripts.${scriptIndex}.js`);
		for (const value of script.css ?? []) add(value, `content_scripts.${scriptIndex}.css`);
	}
	for (const [resourceIndex, resource] of (manifest.web_accessible_resources ?? []).entries()) {
		for (const value of resource.resources ?? []) add(value, `web_accessible_resources.${resourceIndex}`);
	}
	if (manifest.default_locale) {
		const localeArtifacts = [...index.keys()].filter((name) => name.startsWith('_locales/'));
		if (localeArtifacts.length === 0) throw new Error('manifest.json: default_locale requires _locales artifacts');
		references.push(...localeArtifacts);
	}
	return [...new Set(references)];
}

function fileReferences(name, source, index) {
	const references = [];
	const add = (specifier, required = false) => {
		try {
			references.push(...resolveReference(index, name, specifier, { required }));
		} catch (error) {
			throw new Error(error instanceof Error ? error.message : String(error));
		}
	};
	const extension = extname(name).toLowerCase();
	if (extension === '.html') {
		for (const match of source.matchAll(HTML_REFERENCE_PATTERN)) add(match[1], true);
	} else if (extension === '.css') {
		for (const match of source.matchAll(CSS_REFERENCE_PATTERN)) add(match[1], true);
	} else if (extension === '.js') {
		for (const match of source.matchAll(IMPORT_PATTERN)) {
			const specifier = match[1];
			if (!specifier || URL_SCHEME_PATTERN.test(specifier)) continue;
			if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
				throw new Error(`${name}: bare production import is forbidden (${specifier})`);
			}
			add(specifier, true);
		}
		for (const match of source.matchAll(STRING_LITERAL_PATTERN)) add(match[2]);
	}
	return [...new Set(references)];
}

export function bundleFootprint(distDir, bundleName) {
	const root = resolve(distDir);
	const files = new Set();
	const visit = (path) => {
		const normalized = resolve(path);
		const localPath = relative(root, normalized);
		if (localPath.startsWith('..') || resolve(root, localPath) !== normalized) {
			throw new Error(`${bundleName}: import escapes production dist (${localPath})`);
		}
		if (files.has(normalized)) return;
		files.add(normalized);
		const source = readFileSync(normalized, 'utf8');
		for (const match of source.matchAll(IMPORT_PATTERN)) {
			const specifier = match[1];
			if (!specifier?.startsWith('.')) continue;
			visit(resolve(dirname(normalized), cleanSpecifier(specifier)));
		}
	};
	visit(resolve(root, bundleName));
	return {
		bytes: [...files].reduce((sum, path) => sum + statSync(path).size, 0),
		files: [...files].sort(),
	};
}

function productionGraph(index, manifest) {
	const roots = new Set(['manifest.json', ...manifestReferences(manifest, index)]);
	const reachable = new Set();
	const queue = [...roots];
	while (queue.length > 0) {
		const name = queue.shift();
		if (!name || reachable.has(name)) continue;
		const path = index.get(name);
		if (!path) throw new Error(`${name}: production root is missing`);
		reachable.add(name);
		const extension = extname(name).toLowerCase();
		if (!['.css', '.html', '.js'].includes(extension)) continue;
		const source = readFileSync(path, 'utf8');
		for (const reference of fileReferences(name, source, index)) {
			if (!reachable.has(reference)) queue.push(reference);
		}
	}
	return { reachable, roots };
}

function duplicateArtifacts(files, root) {
	const hashes = new Map();
	for (const path of files) {
		const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
		const names = hashes.get(digest) ?? [];
		names.push(artifactName(root, path));
		hashes.set(digest, names);
	}
	return [...hashes.values()].filter((names) => names.length > 1);
}

function metafileEvidence(metafiles) {
	const owners = new Map();
	const contributors = new Map();
	for (const build of metafiles) {
		if (!build?.metafile || typeof build.sharingDomain !== 'string') {
			throw new Error('Every production metafile requires one explicit sharingDomain');
		}
		const inputs = new Set();
		for (const output of Object.values(build.metafile.outputs ?? {})) {
			for (const [path, info] of Object.entries(output.inputs ?? {})) {
				const normalized = path.replaceAll('\\', '/');
				inputs.add(normalized);
				contributors.set(normalized, (contributors.get(normalized) ?? 0) + (info.bytesInOutput ?? 0));
			}
		}
		for (const input of inputs) {
			const list = owners.get(input) ?? [];
			list.push({ name: build.name, sharingDomain: build.sharingDomain });
			owners.set(input, list);
		}
	}
	const redundantModules = [];
	const boundaryReplications = [];
	for (const [input, builds] of owners) {
		if (builds.length < 2) continue;
		const domains = new Set(builds.map((build) => build.sharingDomain));
		if (domains.size < builds.length) redundantModules.push({ input, builds });
		else boundaryReplications.push({ input, builds });
	}
	const topContributors = [...contributors]
		.map(([path, bytes]) => ({ path, bytes }))
		.sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path))
		.slice(0, 8);
	return { boundaryReplications, redundantModules, topContributors };
}

export function analyzeProductionArtifacts({ distDir, metafiles = [] }) {
	const root = resolve(distDir);
	const failures = [];
	const files = walkArtifacts(root, root, failures);
	const index = new Map(files.map((path) => [artifactName(root, path), path]));
	const manifestPath = index.get('manifest.json');
	if (!manifestPath) failures.push('manifest.json: required production root is missing');

	for (const name of index.keys()) {
		if (FORBIDDEN_PRODUCTION_ARTIFACT_PATTERNS.some((pattern) => pattern.test(name))) {
			failures.push(`${name}: development or source artifact is forbidden`);
		}
	}
	for (const path of files.filter((candidate) => candidate.endsWith('.js'))) {
		const source = readFileSync(path, 'utf8');
		const name = artifactName(root, path);
		if (SOURCE_MAP_REFERENCE_PATTERN.test(source)) failures.push(`${name}: source map reference is forbidden`);
		if (DIAGNOSTIC_CALL_PATTERN.test(source)) failures.push(`${name}: diagnostic console call is forbidden`);
	}

	let graph = { reachable: new Set(), roots: new Set() };
	if (manifestPath) {
		try {
			const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
			graph = productionGraph(index, manifest);
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
		}
	}
	for (const name of index.keys()) {
		if (!graph.reachable.has(name)) failures.push(`${name}: unreachable production artifact`);
	}

	const duplicates = duplicateArtifacts(files, root);
	for (const names of duplicates) failures.push(`byte-identical production artifacts: ${names.join(', ')}`);

	let evidence = { boundaryReplications: [], redundantModules: [], topContributors: [] };
	try {
		evidence = metafileEvidence(metafiles);
		for (const item of evidence.redundantModules) {
			failures.push(`${item.input}: repeated in shareable build domain (${item.builds.map((build) => build.name).join(', ')})`);
		}
	} catch (error) {
		failures.push(error instanceof Error ? error.message : String(error));
	}

	const javascript = files.filter((path) => extname(path) === '.js')
		.reduce((sum, path) => sum + statSync(path).size, 0);
	const total = files.reduce((sum, path) => sum + statSync(path).size, 0);
	let defaultStartup = 0;
	if (manifestPath) {
		try {
			const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
			const startupNames = [
				manifest.background?.service_worker,
				...(manifest.content_scripts ?? []).flatMap((script) => script.js ?? []),
			].filter((name) => typeof name === 'string');
			const startupFiles = new Set(startupNames.flatMap((name) => bundleFootprint(root, name).files));
			defaultStartup = [...startupFiles].reduce((sum, path) => sum + statSync(path).size, 0);
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
		}
	}
	const entrypoints = [...index.keys()]
		.filter((name) => extname(name) === '.js' && !name.includes('/'))
		.map((name) => ({ name, ...bundleFootprint(root, name) }))
		.sort((left, right) => left.name.localeCompare(right.name));

	return {
		boundaryReplications: evidence.boundaryReplications,
		defaultStartup,
		duplicates,
		entrypoints,
		failures: [...new Set(failures)].sort(),
		files: files.length,
		javascript,
		reachable: graph.reachable.size,
		topContributors: evidence.topContributors,
		total,
	};
}

export function checkProductionArtifacts(options) {
	const report = analyzeProductionArtifacts(options);
	if (report.failures.length > 0) {
		throw new Error(`Production artifact integrity failed:\n${report.failures.join('\n')}`);
	}
	console.log(
		`✓ Production artifacts: ${report.reachable}/${report.files} reachable, 0 duplicate; `
		+ `startup ${format(report.defaultStartup)}, JS ${format(report.javascript)}, dist ${format(report.total)}`,
	);
	console.log(`✓ Entrypoint closures: ${report.entrypoints.map((item) => `${item.name}:${format(item.bytes)}`).join(' | ')}`);
	if (report.topContributors.length > 0) {
		console.log(`✓ Largest module contributions: ${report.topContributors
			.map((item) => `${item.path}:${format(item.bytes)}`)
			.join(' | ')}`);
	}
	if (report.boundaryReplications.length > 0) {
		console.log(`✓ ${report.boundaryReplications.length} shared source modules are isolated only across non-shareable Chrome runtime domains`);
	}
	return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
	checkProductionArtifacts({ distDir: resolve(projectDir, 'dist') });
}
