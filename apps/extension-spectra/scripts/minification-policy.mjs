/**
 * Application bundles cross storage, extension IPC, Chrome dictionaries, DOM,
 * independent execution worlds, dynamic imports, and generated JSON. No second
 * minifier can prove that complete ABI after esbuild has already optimized each
 * production domain, so application bundles never enter the Terser pass.
 *
 * PeerJS is emitted as one opaque vendor IIFE. Its public surface does not use
 * underscore-prefixed names, so only its physically private `_...` properties
 * are eligible for property mangling.
 */
export function productionMangleOptions(opaqueVendor) {
	if (!opaqueVendor) throw new Error('Application bundles must not enter the secondary Terser pass');
	return {
		toplevel: true,
		properties: {
			regex: /^_/u,
			keep_quoted: true,
		},
	};
}
