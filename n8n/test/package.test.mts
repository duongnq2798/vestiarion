import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

/**
 * The package as n8n and npm take it (docs/superpowers/specs/2026-11-03-n8n-node-design.md N8, N10): n8n's rules for a
 * community package, the build `npm run build` makes, and the committed tarball, which must be that build.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const TARBALL = path.join(ROOT, '..', 'public', 'n8n', `vestiarion-n8n-nodes-vestiarion-${pkg.version}.tgz`);

/** The files in a .tgz, by path. A tar file is 512-byte headers, each followed by its file padded to 512 bytes. */
function untar(tgz: Buffer): Map<string, Buffer> {
	const tar = gunzipSync(tgz);
	const files = new Map<string, Buffer>();
	const field = (from: number, to: number, header: Buffer) => header.subarray(from, to).toString('utf8').replace(/\0[\s\S]*$/, '');
	for (let offset = 0; offset + 512 <= tar.length; ) {
		const header = tar.subarray(offset, offset + 512);
		const name = field(0, 100, header);
		if (!name) break;
		const prefix = field(345, 500, header);
		const size = parseInt(field(124, 136, header).trim() || '0', 8);
		const type = String.fromCharCode(header[156] || 48);
		if (type === '0') files.set(prefix ? `${prefix}/${name}` : name, Buffer.from(tar.subarray(offset + 512, offset + 512 + size)));
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	return files;
}

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const file = path.join(dir, name);
		return statSync(file).isDirectory() ? walk(file) : [file];
	});
}

const lf = (text: string) => text.replace(/\r\n/g, '\n');

describe('the package n8n installs', () => {
	it("has a name, keyword and licence n8n's community packages need", () => {
		expect(pkg.name).toMatch(/^@([a-z0-9]+(?:-[a-z0-9]+)*)\/n8n-nodes-([a-z0-9]+(?:-[a-z0-9]+)*)$/);
		expect(pkg.keywords).toContain('n8n-community-node-package');
		expect(pkg.license).toBe('MIT');
		expect(pkg.author.name).toBeTruthy();
		expect(pkg.author.email).toBeTruthy();
		expect(pkg.files).toEqual(['dist', '!dist/tsconfig.tsbuildinfo']);
		expect(pkg.repository).toMatchObject({ url: 'git+https://github.com/duongnq2798/vestiarion.git', directory: 'n8n' });
	});

	it('has no runtime dependency: n8n-workflow is a peer, as verified nodes require', () => {
		expect(pkg.dependencies).toBeUndefined();
		expect(pkg.peerDependencies).toEqual({ 'n8n-workflow': '*' });
		expect(pkg.scripts.prepare ?? pkg.scripts.preinstall ?? pkg.scripts.postinstall).toBeUndefined();
	});

	it('lists, under n8n, a built file for every credential and node: run npm run build first', () => {
		expect(pkg.n8n.n8nNodesApiVersion).toBe(1);
		for (const file of [...pkg.n8n.credentials, ...pkg.n8n.nodes]) {
			expect(file).toMatch(/^dist\//);
			expect(existsSync(path.join(ROOT, file)), file).toBe(true);
		}
	});

	it('requires only n8n-workflow, node:crypto and its own files at run time', () => {
		const built = walk(path.join(ROOT, 'dist')).filter((file) => file.endsWith('.js'));
		expect(built.length).toBeGreaterThan(3);
		for (const file of built) {
			const required = [...readFileSync(file, 'utf8').matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]);
			for (const name of required) expect(['n8n-workflow', 'node:crypto'].includes(name) || name.startsWith('.'), `${path.relative(ROOT, file)}: ${name}`).toBe(true);
		}
	});
});

describe('the tarball npm publishes', () => {
	it('holds exactly the build, the README, the licence and package.json: run npm run n8n:pack', () => {
		expect(existsSync(TARBALL), `${TARBALL} is missing`).toBe(true);
		const files = untar(readFileSync(TARBALL));
		const built = walk(path.join(ROOT, 'dist'))
			.filter((file) => !file.endsWith('.tsbuildinfo'))
			.map((file) => path.relative(ROOT, file).replace(/\\/g, '/'));
		const expected = [...built, 'README.md', 'LICENSE', 'package.json'].map((file) => `package/${file}`).sort();
		expect([...files.keys()].sort()).toEqual(expected);
		for (const file of [...built, 'README.md', 'LICENSE']) {
			const packed = files.get(`package/${file}`)!.toString('utf8');
			expect(lf(packed), file).toBe(lf(readFileSync(path.join(ROOT, file), 'utf8')));
		}
		expect(JSON.parse(files.get('package/package.json')!.toString('utf8'))).toEqual(pkg);
	});
});
