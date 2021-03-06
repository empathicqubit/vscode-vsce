import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as parseSemver from 'parse-semver';
import * as _ from 'lodash';
import { CancellationToken } from './util';

interface IOptions {
	cwd?: string;
	stdio?: any;
	customFds?: any;
	env?: any;
	timeout?: number;
	maxBuffer?: number;
	killSignal?: string;
}

function parseStdout({ stdout }: { stdout: string }): string {
	return stdout.split(/[\r\n]/).filter(line => !!line)[0];
}

function exec(command: string, options: IOptions = {}, cancellationToken?: CancellationToken): Promise<{ stdout: string; stderr: string; }> {
	return new Promise((c, e) => {
		let disposeCancellationListener: Function = null;

		const child = cp.exec(command, { ...options, encoding: 'utf8' } as any, (err, stdout: string, stderr: string) => {
			if (disposeCancellationListener) {
				disposeCancellationListener();
				disposeCancellationListener = null;
			}

			if (err) { return e(err); }
			c({ stdout, stderr });
		});

		if (cancellationToken) {
			disposeCancellationListener = cancellationToken.subscribe(err => {
				child.kill();
				e(err);
			});
		}
	});
}

function checkNPM(cancellationToken?: CancellationToken): Promise<void> {
	return exec('npm -v', {}, cancellationToken).then(({ stdout }) => {
		const version = stdout.trim();

		if (/^3\.7\.[0123]$/.test(version)) {
			return Promise.reject(`npm@${version} doesn't work with vsce. Please update npm: npm install -g npm`);
		}
	});
}

function getNpmDependencies(cwd: string): Promise<string[]> {
	return checkNPM()
		.then(() => exec('npm list --production --parseable --depth=99999 --loglevel=error', { cwd, maxBuffer: 5000 * 1024 }))
		.then(({ stdout }) => stdout
			.split(/[\r\n]/)
			.filter(dir => path.isAbsolute(dir)));
}

interface YarnTreeNode {
	name: string;
	children: YarnTreeNode[];
}

export interface YarnDependency {
	name: string;
	path: string;
	children: YarnDependency[];
}

interface PnpmTreeNode {
	name: string;
	from: string;
	version: string;
	dependencies: { [key:string]:PnpmTreeNode };
}

function asYarnDependency(prefix: string, tree: YarnTreeNode, prune: boolean): YarnDependency | null {
	if (prune && /@[\^~]/.test(tree.name)) {
		return null;
	}

	let name: string;

	try {
		const parseResult = parseSemver(tree.name);
		name = parseResult.name;
	} catch (err) {
		name = tree.name.replace(/^([^@+])@.*$/, '$1');
	}

	const dependencyPath = path.join(prefix, name);
	const children: YarnDependency[] = [];

	for (const child of (tree.children || [])) {
		const dep = asYarnDependency(path.join(prefix, name, 'node_modules'), child, prune);

		if (dep) {
			children.push(dep);
		}
	}

	return { name, path: dependencyPath, children };
}

async function asPnpmDependency(prefix: string, tree: PnpmTreeNode, prune: boolean): Promise<YarnDependency | null> {
	if (prune && /^[\^~]/.test(tree.version)) {
		return null;
	}

	let name = tree.name || tree.from;

	const dependencyPath = path.join(prefix, name);
	const children: YarnDependency[] = [];

	const deps = await Promise.all(
		_.values(tree.dependencies || {})
			.map(child => asPnpmDependency(prefix, child, prune))
		);
	for(const dep of deps) {
		if (dep) {
			children.push(dep); 
		}
	}

	return { name, path: dependencyPath, children };
}

function selectYarnDependencies(deps: YarnDependency[], packagedDependencies: string[]): YarnDependency[] {

	const index = new class {
		private data: { [name: string]: YarnDependency } = Object.create(null);
		constructor() {
			for (const dep of deps) {
				if (this.data[dep.name]) {
					throw Error(`Dependency seen more than once: ${dep.name}`);
				}
				this.data[dep.name] = dep;
			}
		}
		find(name: string): YarnDependency {
			let result = this.data[name];
			if (!result) {
				throw new Error(`Could not find dependency: ${name}`);
			}
			return result;
		}
	};

	const reached = new class {
		values: YarnDependency[] = [];
		add(dep: YarnDependency): boolean {
			if (this.values.indexOf(dep) < 0) {
				this.values.push(dep);
				return true;
			}
			return false;
		}
	};

	const visit = (name: string) => {
		let dep = index.find(name);
		if (!reached.add(dep)) {
			// already seen -> done
			return;
		}
		for (const child of dep.children) {
			visit(child.name);
		}
	};
	packagedDependencies.forEach(visit);
	return reached.values;
}

async function getPnpmProductionDependencies(cwd: string, packagedDependencies?: string[]): Promise<YarnDependency[]> {
	const raw = await new Promise<string>((c, e) => cp.exec('pnpm list --depth 1000000 --prod --json --silent', { cwd, encoding: 'utf8', env: { ...process.env }, maxBuffer: 5000 * 1024 }, (err, stdout) => err ? e(err) : c(stdout)));
	const match = /^\s*\[[\s\S]*\]\s*$/m.exec(raw);

	if (!match || match.length !== 1) {
		throw new Error('Could not parse result of `pnpm list --json`' + raw);
	}

	const usingPackagedDependencies = Array.isArray(packagedDependencies);
	const trees = _.values(JSON.parse(match[0])[0].dependencies) as PnpmTreeNode[];

	let result = (
		await Promise.all(
			trees.map(tree => asPnpmDependency(path.join(cwd, 'node_modules'), tree, !usingPackagedDependencies))
		)
	).filter(dep => !!dep);

	if (usingPackagedDependencies) {
		result = selectYarnDependencies(result, packagedDependencies);
	}

	return result;
}

async function getYarnProductionDependencies(cwd: string, packagedDependencies?: string[]): Promise<YarnDependency[]> {
	const raw = await new Promise<string>((c, e) => cp.exec('yarn list --prod --json', { cwd, encoding: 'utf8', env: { ...process.env }, maxBuffer: 5000 * 1024 }, (err, stdout) => err ? e(err) : c(stdout)));
	const match = /^{"type":"tree".*$/m.exec(raw);

	if (!match || match.length !== 1) {
		throw new Error('Could not parse result of `yarn list --json`');
	}

	const usingPackagedDependencies = Array.isArray(packagedDependencies);
	const trees = JSON.parse(match[0]).data.trees as YarnTreeNode[];

	let result = trees
		.map(tree => asYarnDependency(path.join(cwd, 'node_modules'), tree, !usingPackagedDependencies))
		.filter(dep => !!dep);

	if (usingPackagedDependencies) {
		result = selectYarnDependencies(result, packagedDependencies);
	}

	return result;
}

async function getYarnDependencies(cwd: string, packagedDependencies?: string[]): Promise<string[]> {
	const result: string[] = [cwd];

	if (await new Promise(c => fs.exists(path.join(cwd, 'yarn.lock'), c))) {
		const deps = await getYarnProductionDependencies(cwd, packagedDependencies);
		const flatten = (dep: YarnDependency) => { result.push(dep.path); dep.children.forEach(flatten); };
		deps.forEach(flatten);
	}

	return _.uniq(result);
}

async function getPnpmDependencies(cwd: string, packagedDependencies?: string[]): Promise<string[]> {
	const result: string[] = [cwd];

	if (await new Promise(c => fs.exists(path.join(cwd, 'pnpm-lock.yaml'), c))) {
		const deps = await getPnpmProductionDependencies(cwd, packagedDependencies);
		const flatten = (dep: YarnDependency) => { result.push(dep.path); dep.children.forEach(flatten); };
		deps.forEach(flatten);
	}

	return _.uniq(result);
}

export function getDependencies(cwd: string, useYarn = false, usePackageManager: "yarn" | "npm" | "pnpm", packagedDependencies?: string[]): Promise<string[]> {
	if(useYarn) {
		return getYarnDependencies(cwd, packagedDependencies);
	}
	else if(usePackageManager == "npm") {
		return getNpmDependencies(cwd);
	}
	else if(usePackageManager == "pnpm") {
		return getPnpmDependencies(cwd, packagedDependencies);
	}
	else if(usePackageManager == "yarn") {
		return getYarnDependencies(cwd, packagedDependencies);
	}
	else {
		return getNpmDependencies(cwd);
	}
}

export function getLatestVersion(name: string, cancellationToken?: CancellationToken): Promise<string> {
	return checkNPM(cancellationToken)
		.then(() => exec(`npm show ${name} version`, {}, cancellationToken))
		.then(parseStdout);
}
