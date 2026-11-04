/**
 * dsh-fleet — client side (fleet panel).
 *
 * Follows the dsh-quota-pets pattern proven on DSH Desktop (dsh 0.2.1-rc.2):
 *   - package.json dsh.client.inject: ["@deepseek-ai/dsh-client-ui-slots"]
 *   - apply(ctx): ctx.inject(["slots"], (ready) => { ready.slots.inject(...) })
 *   - never throw out of apply; degrade to a console.warn instead.
 *
 * Panel data: GET /fleet/panel (host half, no auth, read-only snapshot).
 */
(function () {
	"use strict";
	window.__ModuleLoader__.load({
		id: "dsh-fleet",
		factory: function (require) {
			var module = { exports: {} };
			var exports = module.exports;
			Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

			var React = null;
			try { React = require("react"); } catch (_) { React = null; }

			var POLL_MS = 5000;

			function useFleetSnapshot() {
				var _a = React.useState({ loading: true, data: null, error: null });
				var state = _a[0];
				var setState = _a[1];
				React.useEffect(function () {
					var stopped = false;
					var refresh = function () {
						fetch("/fleet/panel", { headers: { accept: "application/json" } })
							.then(function (r) { return r.json(); })
							.then(function (d) {
								if (stopped) return;
								setState({ loading: false, data: d, error: d && d.ok === false ? (d.error || "fleet plugin unavailable") : null });
							})
							.catch(function (e) {
								if (!stopped) setState({ loading: false, data: null, error: String(e && e.message || e) });
							});
					};
					refresh();
					var timer = window.setInterval(refresh, POLL_MS);
					return function () { stopped = true; window.clearInterval(timer); };
				}, []);
				return state;
			}

			function fmtUptime(sec) {
				if (sec == null || !isFinite(sec)) return "—";
				var d = Math.floor(sec / 86400);
				var h = Math.floor((sec % 86400) / 3600);
				var m = Math.floor((sec % 3600) / 60);
				var s = Math.floor(sec % 60);
				if (d > 0) return d + "天" + h + "时";
				if (h > 0) return h + "时" + m + "分";
				if (m > 0) return m + "分" + s + "秒";
				return s + "秒";
			}

			function fmtAgo(ms, nowMs) {
				if (!ms) return "从未";
				var delta = Math.max(0, Math.floor((nowMs - ms) / 1000));
				return delta < 60 ? delta + " 秒前" : Math.floor(delta / 60) + " 分钟前";
			}

			var cardStyle = {
				border: "1px solid color-mix(in srgb, currentColor 14%, transparent)",
				borderRadius: 10,
				padding: "12px 14px",
				minWidth: 220,
				flex: "1 1 240px",
				maxWidth: 360,
			};
			var dotStyle = function (online) {
				return {
					display: "inline-block", width: 9, height: 9, borderRadius: "50%",
					marginRight: 8, flexShrink: 0,
					background: online ? "#34c759" : "#8e8e93",
					boxShadow: online ? "0 0 6px rgba(52,199,89,.6)" : "none",
				};
			};
			var labelStyle = { fontSize: 12, opacity: 0.65, marginRight: 6 };
			var valueStyle = { fontSize: 12, opacity: 0.95 };

			function DeviceCard(props) {
				var d = props.device;
				var nowMs = props.nowMs;
				var isSelf = props.isSelf;
				var steward = d.steward || {};
				var stewardState = d.online === false && !isSelf ? "—" : (steward.live ? (steward.busy ? "忙碌中" : (steward.status || "idle")) : "休眠(未唤醒)");
				return React.createElement(
					"div",
					{ style: cardStyle },
					React.createElement(
						"div",
						{ style: { display: "flex", alignItems: "center", marginBottom: 8 } },
						React.createElement("span", { style: dotStyle(isSelf || d.online) }),
						React.createElement("strong", { style: { fontSize: 14 } }, d.device),
						React.createElement("span", { style: { fontSize: 11, opacity: 0.5, marginLeft: 8 } }, isSelf ? "本机" : (d.role || ""))
					),
					React.createElement(
						"div",
						{ style: { display: "grid", gridTemplateColumns: "auto 1fr", rowGap: 4, columnGap: 8 } },
						React.createElement("span", { style: labelStyle }, "版本"), React.createElement("span", { style: valueStyle }, d.version || "—"),
						React.createElement("span", { style: labelStyle }, "运行"), React.createElement("span", { style: valueStyle }, d.uptimeSec != null ? fmtUptime(d.uptimeSec) : "—"),
						React.createElement("span", { style: labelStyle }, "管家"), React.createElement("span", { style: valueStyle }, stewardState),
						React.createElement("span", { style: labelStyle }, "心跳"), React.createElement("span", { style: valueStyle }, isSelf ? "本地" : fmtAgo(d.lastSeenMs, nowMs))
					)
				);
			}

			function FleetPage(_props) {
				var snap = useFleetSnapshot();
				if (snap.loading) {
					return React.createElement("div", { style: { padding: 24, opacity: 0.7 } }, "读取舰队心跳…");
				}
				if (snap.error) {
					return React.createElement(
						"div",
						{ style: { padding: 24 } },
						React.createElement("div", { style: { color: "#ff6b6b", marginBottom: 8 } }, "舰队数据不可用: " + snap.error),
						React.createElement("div", { style: { fontSize: 12, opacity: 0.7 } }, "本 profile 需已配置 dsh-fleet（fleet.json）并启动后，面板才能取到 /fleet/panel。")
					);
				}
				var data = snap.data || {};
				var self = data.self;
				var peers = data.peers || [];
				var nowMs = data.fetchedAt || Date.now();
				var online = peers.filter(function (p) { return p.online; }).length + 1;
				return React.createElement(
					"div",
					{ style: { padding: 20, overflowY: "auto", height: "100%", boxSizing: "border-box" } },
					React.createElement(
						"div",
						{ style: { display: "flex", alignItems: "baseline", gap: 10, marginBottom: 16 } },
						React.createElement("h2", { style: { fontSize: 16, margin: 0 } }, "设备舰队"),
						React.createElement("span", { style: { fontSize: 12, opacity: 0.6 } }, online + " / " + (peers.length + 1) + " 在线 · 每 5s 自动刷新")
					),
					React.createElement(
						"div",
						{ style: { display: "flex", flexWrap: "wrap", gap: 12 } },
						self ? React.createElement(DeviceCard, { key: self.device, device: self, isSelf: true, nowMs: nowMs }) : null,
						peers.map(function (p) { return React.createElement(DeviceCard, { key: p.device, device: p, isSelf: false, nowMs: nowMs }); })
					)
				);
			}

			function FleetIcon(props) {
				var size = props.size || 18;
				return React.createElement(
					"svg",
					{ width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true" },
					React.createElement("circle", { cx: 5, cy: 6, r: 2.2, fill: "currentColor" }),
					React.createElement("circle", { cx: 12, cy: 12, r: 2.6, fill: "currentColor" }),
					React.createElement("circle", { cx: 19, cy: 6, r: 2.2, fill: "currentColor" }),
					React.createElement("circle", { cx: 19, cy: 18, r: 2.2, fill: "currentColor" }),
					React.createElement("circle", { cx: 5, cy: 18, r: 2.2, fill: "currentColor" }),
					React.createElement("path", { d: "M7 7.2 10 10.4M14 10.4 17 7.2M14 13.6 17 16.8M7 16.8 10 13.6", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" })
				);
			}

			function registerSlots(slots, effect) {
				var register = function () {
					slots.inject("main", function () {
						return slots.register({
							name: "main",
							key: "fleet",
							inject: function () { return {}; }
						}, FleetPage);
					});
					slots.inject("sidebar.panellist", function () {
						return slots.register({
							name: "sidebar.panellist",
							id: "fleet",
							order: 30,
							label: function () { return "舰队"; }
						}, FleetIcon);
					});
				};
				if (typeof effect === "function") effect(register, "dsh-fleet: panel slots");
				else register();
			}

			function apply(ctx) {
				try {
					if (!React) {
						console.warn("[dsh-fleet] react unavailable in client runtime; panel not registered");
						return;
					}
					if (ctx && typeof ctx.inject === "function") {
						ctx.inject(["slots"], function (ready) {
							try {
								if (ready && ready.slots && typeof ready.slots.inject === "function") {
									registerSlots(ready.slots, ready.effect);
								} else {
									console.warn("[dsh-fleet] slots service has no inject(); panel not registered");
								}
							} catch (e) {
								console.warn("[dsh-fleet] slot registration failed:", e);
							}
						});
					} else if (ctx && ctx.slots && typeof ctx.slots.inject === "function") {
						registerSlots(ctx.slots, ctx.effect);
					} else {
						console.warn("[dsh-fleet] client runtime exposes no slots service; panel not registered");
					}
				} catch (e) {
					console.warn("[dsh-fleet] apply failed (panel disabled):", e);
				}
			}

			exports.apply = apply;
			return module.exports;
		}
	});
})();
