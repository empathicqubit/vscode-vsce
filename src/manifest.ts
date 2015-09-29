export interface Person {
	name: string;
	url?: string;
	email?: string;
}

export interface Manifest {
	// mandatory (npm)
	name: string;
	version: string;
	engines: { vscode: string; [name: string]: string; };
	
	// vscode
	publisher: string;
	contributes?: { [contributionType: string]: any; };
	activationEvents?: string[];
	extensionDependencies?: string[];
	_bundling?: { [name: string]: string; }[];
	_testing?: string;
	
	// optional (npm)
	author?: string | Person;
	description?: string;
	keywords?: string[];
	homepage?: string;
	bugs?: string | { url?: string; email?: string };
	license?: string;
	contributors?: string | Person[];
	main?: string;
	repository?: string | { type: string; url: string; };
	scripts?: { [name: string]: string; };
	dependencies?: { [name: string]: string; };
	devDependencies?: { [name: string]: string; };
	private?: boolean;
	
	// not supported (npm)
	// files?: string[];
	// bin
	// man
	// directories
	// config
	// peerDependencies
	// bundledDependencies
	// optionalDependencies
	// os?: string[];
	// cpu?: string[];
	// preferGlobal
	// publishConfig
}