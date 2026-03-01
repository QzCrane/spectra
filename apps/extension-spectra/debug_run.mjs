import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, 'dist');
const CHROME_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

async function run() {
	console.log('Launching browser...');
	const browser = await puppeteer.launch({
		executablePath: CHROME_PATH,
		headless: false,
		args: [
			`--disable-extensions-except=${EXTENSION_PATH}`,
			`--load-extension=${EXTENSION_PATH}`,
		],
	});

	// Capture Service Worker logs
	browser.on('targetcreated', async target => {
		if (target.type() === 'service_worker') {
			const worker = await target.worker();
			if (worker) {
				worker.on('console', msg => console.log('SW LOG:', msg.text()));
			}
		}
	});

	const page = await browser.newPage();
	page.on('console', msg => console.log('PAGE LOG:', msg.text()));

	console.log('Navigating to test page...');
	await page.goto('https://www.google.com', { waitUntil: 'networkidle2' });

	// Check for content script marker
	let loaded = await page.evaluate(() => document.documentElement.hasAttribute('data-spectra-content-loaded'));
	console.log('Content script loaded (Initial):', loaded);

	console.log('Testing refresh...');
	await page.reload({ waitUntil: 'networkidle2' });

	loaded = await page.evaluate(() => document.documentElement.hasAttribute('data-spectra-content-loaded'));
	console.log('Content script loaded (After Refresh):', loaded);

	console.log('Success? Check the browser window for logs.');
	await new Promise(r => setTimeout(r, 5000));
	await browser.close();
}

run().catch(err => {
	console.error('Debug failed:', err);
	process.exit(1);
});
