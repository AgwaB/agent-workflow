// Project execution/source paths and private run-state paths have different bases.
import { createHash, randomBytes } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import {
	chmod,
	link,
	lstat,
	mkdir,
	open,
	rename,
	unlink,
} from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import {
	readPrivateDirectoryNames,
	readPrivateFileText,
} from "./secure-atomic-write.js";
import { agentWorkflowHome } from "./home-dir.js";

export function canonicalProjectPath(cwd: string): string {
	try {
		return realpathSync.native(resolve(cwd));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return resolve(cwd);
	}
}

export function projectId(cwd: string): string {
	const path = canonicalProjectPath(cwd);
	const slug =
		basename(path)
			.toLowerCase()
			.replace(/[^a-z0-9-]+/gu, "-")
			.replace(/-+/gu, "-")
			.slice(0, 32)
			.replace(/^-|-$/gu, "") || "project";
	return `${slug}-${createHash("sha256").update(path).digest("hex").slice(0, 12)}`;
}

// Canonicalize the existing prefix of the configured user directory as well (e.g. /tmp on macOS).
function physicalHome(path: string): string {
	try {
		return realpathSync.native(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return join(physicalHome(dirname(path)), basename(path));
	}
}

const bases = new Map<string, string>();
export function stateBase(cwd: string): string {
	const path = canonicalProjectPath(cwd);
	const home = agentWorkflowHome();
	const key = JSON.stringify([path, home]);
	let base = bases.get(key);
	if (base === undefined) {
		base = join(physicalHome(home), "projects", projectId(path));
		bases.set(key, base);
	}
	return base;
}

export function fromStatePath(cwd: string, filePath: string): string {
	return isAbsolute(filePath) ? filePath : resolve(stateBase(cwd), filePath);
}

export function toStatePath(cwd: string, filePath: string): string {
	return isAbsolute(filePath)
		? relative(stateBase(cwd), filePath) || "."
		: filePath;
}

/** Create only physical application-owned components, never through a project-state symlink. */
export async function ensureStateBase(cwd: string): Promise<string> {
	const base = stateBase(cwd);
	const home = dirname(dirname(base));
	await mkdir(home, { recursive: true, mode: 0o700 });
	for (const dir of [home, dirname(base), base]) {
		try {
			await mkdir(dir, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const info = await lstat(dir);
		if (
			!info.isDirectory() ||
			info.isSymbolicLink() ||
			realpathSync.native(dir) !== dir ||
			(typeof process.getuid === "function" && info.uid !== process.getuid())
		)
			throw new Error(`Unsafe project state directory: ${dir}`);
		if (dir === base && (info.mode & 0o777) !== 0o700) await chmod(dir, 0o700);
	}
	return base;
}

export interface ProjectRegistration {
	schema: "agent-workflow-project-v1";
	id: string;
	path: string;
	name: string;
	createdAt: string;
	lastSeenAt: string;
}

async function readRegistration(
	file: string,
	path: string,
	id: string,
	attempt = 0,
): Promise<ProjectRegistration> {
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		// Exclusive first publication briefly links the private temp inode twice. Never
		// accept a multi-link registry, but allow the publishing process to unlink its temp.
		if (info.isFile() && info.nlink === 2 && attempt < 10) {
			await new Promise((done) => setTimeout(done, 5));
			return await readRegistration(file, path, id, attempt + 1);
		}
		if (
			!info.isFile() ||
			info.nlink !== 1 ||
			(info.mode & 0o777) !== 0o600 ||
			(typeof process.getuid === "function" && info.uid !== process.getuid())
		)
			throw new Error(`Unsafe project registry: ${file}`);
		const value: unknown = JSON.parse(await handle.readFile("utf8"));
		if (
			!value ||
			typeof value !== "object" ||
			!("path" in value) ||
			value.path !== path
		)
			throw new Error(
				`Project registry path mismatch: ${file}; refusing to merge with ${path}`,
			);
		const record = value as Partial<ProjectRegistration>;
		if (
			record.schema !== "agent-workflow-project-v1" ||
			record.id !== id ||
			typeof record.name !== "string" ||
			typeof record.createdAt !== "string" ||
			!Number.isFinite(Date.parse(record.createdAt)) ||
			typeof record.lastSeenAt !== "string" ||
			!Number.isFinite(Date.parse(record.lastSeenAt))
		)
			throw new Error(`Invalid project registry: ${file}`);
		return record as ProjectRegistration;
	} finally {
		await handle.close();
	}
}

/** Register a launch. Publication is atomic; an existing identity is always checked first. */
export async function registerProject(cwd: string): Promise<void> {
	const base = await ensureStateBase(cwd);
	const path = canonicalProjectPath(cwd);
	const id = projectId(path);
	const file = join(base, "project.json");
	const now = new Date().toISOString();
	let record: ProjectRegistration = {
		schema: "agent-workflow-project-v1",
		id,
		path,
		name: basename(path),
		createdAt: now,
		lastSeenAt: now,
	};
	try {
		record = await readRegistration(file, path, id);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const temp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	const write = async (value: ProjectRegistration) => {
		const handle = await open(
			temp,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
			0o600,
		);
		try {
			await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}
	};
	try {
		await write({ ...record, lastSeenAt: now });
		try {
			await link(temp, file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			record = await readRegistration(file, path, id);
			await unlink(temp);
			await write({ ...record, lastSeenAt: now });
			await rename(temp, file);
		}
	} finally {
		await unlink(temp).catch(() => undefined);
	}
}

/** Registry ids, never request paths, select a project's private state. */
export function validProjectId(id: string): boolean {
	return /^[a-z0-9-]{1,32}-[0-9a-f]{12}$/.test(id);
}

export async function listRegisteredProjects(): Promise<ProjectRegistration[]> {
	const root = join(agentWorkflowHome(), "projects");
	let names: string[];
	try {
		names = await readPrivateDirectoryNames(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const projects: ProjectRegistration[] = [];
	for (const id of names.sort()) {
		if (!validProjectId(id)) continue;
		try {
			const value: unknown = JSON.parse(
				await readPrivateFileText(join(root, id, "project.json"), 16384),
			);
			if (!value || typeof value !== "object") continue;
			const record = value as Partial<ProjectRegistration>;
			if (
				record.schema !== "agent-workflow-project-v1" ||
				record.id !== id ||
				typeof record.path !== "string" ||
				!isAbsolute(record.path) ||
				projectId(record.path) !== id ||
				typeof record.name !== "string" ||
				typeof record.createdAt !== "string" ||
				!Number.isFinite(Date.parse(record.createdAt)) ||
				typeof record.lastSeenAt !== "string" ||
				!Number.isFinite(Date.parse(record.lastSeenAt))
			)
				continue;
			projects.push(record as ProjectRegistration);
		} catch {
			/* Untrusted or concurrently removed registry entries are not projects. */
		}
	}
	return projects;
}
