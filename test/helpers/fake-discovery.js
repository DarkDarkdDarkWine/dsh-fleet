/** Fake Discovery: records advertisements and lets tests inject found peers. */
export function fakeDiscovery() {
	const listeners = [];
	const fake = {
		advertised: [],
		stopped: false,
		advertise(info) { fake.advertised.push(info); },
		onFound(cb) { listeners.push(cb); },
		async scanNow() {},
		stop() { fake.stopped = true; },
		/** Test hook: pretend a peer was discovered. */
		emit(found) { for (const cb of listeners) cb(found); },
	};
	return fake;
}
