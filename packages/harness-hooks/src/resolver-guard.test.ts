import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { verdict } from "./resolver-guard.ts";

// The guard reads its own repo name from the environment when it loads.
vi.hoisted(() => {
	process.env["RESOLVER_GUARD_REPO"] = "lab-repo";
});

// Built from pieces so this file does not trip the rule it tests.
const dotted = (...parts: (number | string)[]) => parts.join(".");
const V4 = [
	dotted(1, 1, 1, 1),
	dotted(1, 0, 0, 1),
	dotted(8, 8, 8, 8),
	dotted(8, 8, 4, 4),
	dotted(9, 9, 9, 9),
	dotted(149, 112, 112, 112),
];
const V6 = ["2001:4860:4860::", "8888"].join("");
const DOH = ["cloudflare", "dns.com"].join("-");
const ONE = dotted(1, 1, 1, 1);
const EIGHT = dotted(8, 8, 8, 8);

const bash = (command: string, cwd = "/work/demo") => ({
	tool_name: "Bash",
	tool_input: { command },
	cwd,
});
const write = (file_path: string, content: string) => ({
	tool_name: "Write",
	tool_input: { file_path, content },
});
const edit = (file_path: string, new_string: string) => ({
	tool_name: "Edit",
	tool_input: { file_path, old_string: "a", new_string },
});

describe("resolver-guard verdict", () => {
	it.each(V4)("denies %s in Bash, Write and Edit, and the reason names the fix", (ip) => {
		for (const payload of [
			bash(`dig @${ip} example.com`),
			write("/etc/resolv.conf", `nameserver ${ip}\n`),
			edit("/etc/x", `dns=${ip}`),
		]) {
			expect(verdict(payload)).toMatch(/AdGuard|local resolver/iu);
			expect(verdict(payload)).toContain(`BLOCKED: ${ip} is a public DNS resolver`);
		}
	});

	it("words the reason for the tool: command for Bash, content otherwise", () => {
		expect(verdict(bash(`dig @${ONE} x`))).toContain("from this command.");
		expect(verdict(write("/etc/x", ONE))).toContain("from this content.");
	});

	it("catches IPv6 and DoH names", () => {
		expect(verdict(bash(`dig @${V6} x`))).toContain(V6);
		expect(verdict(bash(`curl https://${DOH}/dns-query`))).toContain(DOH);
	});

	it.each([
		"ping 11.1.1.1",
		"echo 1.1.1.10",
		"echo 21.1.1.1",
		"curl http://10.0.0.5/x",
		"echo v1.1.1.1.2",
		"ls -la",
		"dig @10.0.0.53 example.com",
	])("passes the look-alike %s", (command) => {
		expect(verdict(bash(command))).toBeNull();
	});

	it("passes a local resolver in Write and Edit", () => {
		expect(verdict(write("/etc/resolv.conf", "nameserver 10.0.0.53\n"))).toBeNull();
		expect(verdict(edit("/etc/x", "dns=10.0.0.53"))).toBeNull();
	});

	it("allows the hook's own repo and fixtures by path, but not other paths", () => {
		const w = (p: string) => write(p, `x = "${ONE}"`);

		expect(verdict(w("/work/lab-repo-demo/modules/guards/test.mjs"))).toBeNull();
		expect(verdict(w("/home/me/lab-repo/modules/guards/resolver-guard.mjs"))).toBeNull();
		expect(verdict(w("/work/proj/test/fixtures/dns.json"))).toBeNull();
		expect(verdict(w("/work/proj/src/dns.json"))).toMatch(/^BLOCKED/u);
	});

	it("allows a Bash command by repo cwd or a cd or git -C into the repo", () => {
		const grep = `grep -rn ${ONE} .`;

		expect(verdict(bash(grep, "/work/lab-repo-demo"))).toBeNull();
		expect(verdict(bash(`cd /work/lab-repo-demo && grep -rn ${ONE} modules`))).toBeNull();
		expect(verdict(bash(grep, "/work/proj"))).toMatch(/^BLOCKED/u);
	});

	it("never exempts a network or DNS tool by location", () => {
		expect(verdict(bash(`dig @${EIGHT} x`, "/work/lab-repo-demo"))).toMatch(/^BLOCKED/u);
		expect(verdict(bash(`git -C ~/lab-repo status; dig @${EIGHT} x`))).toMatch(/^BLOCKED/u);
	});

	it("ignores other tools, empty input and missing fields", () => {
		expect(verdict({ tool_name: "Read", tool_input: { content: ONE } })).toBeNull();
		expect(verdict({ tool_name: "Bash" })).toBeNull();
		expect(verdict(null)).toBeNull();
	});
});

describe("resolver-guard as a hook process", () => {
	const script = fileURLToPath(new URL("resolver-guard.ts", import.meta.url));
	const run = (stdin: string) => {
		const result = spawnSync(process.execPath, ["--no-warnings", script], {
			input: stdin,
			encoding: "utf8",
		});

		expect(result.status).toBe(0);

		return result.stdout;
	};

	it("prints a deny that names the fix", () => {
		const out = JSON.parse(run(JSON.stringify(bash(`dig @${ONE} example.com`)))) as {
			hookSpecificOutput: {
				hookEventName: string;
				permissionDecision: string;
				permissionDecisionReason: string;
			};
		};

		expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
		expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
		expect(out.hookSpecificOutput.permissionDecisionReason).toContain("local resolver");
	});

	it("prints nothing for an allowed call", () => {
		expect(run(JSON.stringify(bash("ls -la")))).toBe("");
		expect(run(JSON.stringify(write("/work/proj/test/fixtures/a.json", ONE)))).toBe("");
	});

	it("fails open on bad input", () => {
		expect(run("not json")).toBe("");
		expect(run("null")).toBe("");
	});
});
