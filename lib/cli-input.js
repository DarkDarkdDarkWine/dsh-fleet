import { createInterface } from "node:readline";

/**
 * Line input for the CLI. On a TTY, PINs are read without echo; otherwise
 * each prompt consumes the next stdin line (used by tests and scripts).
 * Prompts go to stderr so `--json` output on stdout stays clean.
 */
export function createInput(stdin = process.stdin, stderr = process.stderr) {
	let lines = null;
	const nextLine = async () => {
		lines ??= createInterface({ input: stdin, terminal: false })[Symbol.asyncIterator]();
		const { value, done } = await lines.next();
		if (done) throw new Error("没有更多输入");
		return value.trim();
	};

	const askHidden = (prompt) => new Promise((resolve, reject) => {
		stderr.write(prompt);
		let buf = "";
		const cleanup = () => { stdin.off("data", onData); stdin.setRawMode(false); stdin.pause(); stderr.write("\n"); };
		const onData = (chunk) => {
			for (const c of chunk) {
				if (c === "\r" || c === "\n") { cleanup(); resolve(buf); return; }
				if (c === "\u0003") { cleanup(); reject(new Error("已取消")); return; }
				buf = c === "\u007f" || c === "\b" ? buf.slice(0, -1) : buf + c;
			}
		};
		stdin.setRawMode(true);
		stdin.setEncoding("utf8");
		stdin.resume();
		stdin.on("data", onData);
	});

	return {
		/** @param {string} prompt @param {{ hidden?: boolean }} [opts] */
		async ask(prompt, { hidden = false } = {}) {
			if (stdin.isTTY && hidden) return askHidden(prompt);
			stderr.write(prompt);
			const line = await nextLine();
			if (!stdin.isTTY) stderr.write("\n");
			return line;
		},
		close() {
			lines?.return?.();
		},
	};
}
