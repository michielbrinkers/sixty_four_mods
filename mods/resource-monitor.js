"use strict";

// ============================================================================
// Resource Monitor — a Sixty Four mod
//
// Adds a Q/E-style "select mode" (default key: R): click or drag over
// buildings to toggle them in a selection, and a panel shows the resources
// flowing in (fuel consumed) and out (production) of the selected group,
// averaged over a rolling window.
//
// How it measures: consumption is attributed by observing
// Game.requestResources/askForResources (their destination argument is the
// building's grid position); production by observing
// Game.createResourceTransfer at emission time (its source argument is the
// building's screen position, inverted back to a grid cell). Transfers with
// a custom completion callback or the "skip" flag are ignored — those are
// internal moves (cube -> consumer), purchases and refunds.
//
// Chasm-network production (gradient well, general decay reactor) is counted
// via createChasmTransfer, whose path starts at the emitting entity's cell.
//
// Known limits: resource cubes are not selectable (transient), so income
// from manually breaking cubes is not measurable; rare event payouts
// (hollow events) originate from HUD coordinates and may occasionally land
// on a building.
// ============================================================================

const RES_COUNT = 10;
const GAIN_COLOR = `#6ea56e`; // same colors the game uses for its +X/s readout
const LOSS_COLOR = `#C38C75`;
const PRODUCED = 0;
const CONSUMED = 1;

const state = {
	selectMode: false,
	selection: new Set(),      // Entity refs
	dragVisited: new Set(),    // entities already painted during the current drag
	dragAction: true,          // what this drag paints: true = select, false = deselect
	ledger: new Map(),         // Entity -> [{t, dir, r}], t in game-time ms
	clock: 0,                  // accumulated game time (frozen while paused)
	perMinute: false,
	mctx: null,
	ui: {}
};

// --------------------------------------------------------------------------
// Selection

function isAlive(g, e) {
	return e && !e.killme && e.position && g.stuffMap[`u${e.position[0]}v${e.position[1]}`] === e;
}

function setSelected(e, on) {
	if (on) state.selection.add(e);
	else state.selection.delete(e);
	refreshPanel();
}

// Paint an entity during a click/drag with the action latched at press time.
// Resource cubes are not selectable at all — they are transient (break,
// respawn from pumps) and would churn the selection mid-drag.
function paintSelection(g, e) {
	if (e.name === `cube` || !isAlive(g, e) || state.dragVisited.has(e)) return;
	state.dragVisited.add(e);
	setSelected(e, state.dragAction);
}

function enterSelectMode() {
	state.selectMode = true;
	if (typeof game !== `undefined` && game) {
		delete game.itemInHand;
		delete game.transportedEntity;
	}
	document.body.classList.add(`rm-select-mode`);
}

function exitSelectMode() {
	state.selectMode = false;
	state.dragVisited.clear();
	document.body.classList.remove(`rm-select-mode`);
}

// --------------------------------------------------------------------------
// Measurement

function record(entity, dir, r) {
	if (!entity || !Array.isArray(r)) return;
	let events = state.ledger.get(entity);
	if (!events) {
		events = [];
		state.ledger.set(entity, events);
	}
	events.push({ t: state.clock, dir: dir, r: r.slice(0, RES_COUNT) });
}

function entityFromScreen(g, p) {
	if (!Array.isArray(p)) return undefined;
	const uv = g.xyToUV([p[0] / g.pixelRatio, p[1] / g.pixelRatio]);
	return g.stuffMap[`u${Math.floor(uv[0])}v${Math.floor(uv[1])}`];
}

function windowMs() {
	return state.mctx.settings.windowSeconds.value * 1000;
}

function pruneLedger(g) {
	const cutoff = state.clock - windowMs();
	for (const [e, events] of state.ledger) {
		while (events.length && events[0].t < cutoff) events.shift();
		if (!events.length && !isAlive(g, e)) state.ledger.delete(e);
	}
}

// Per-resource [produced, consumed] sums over the window, as units/second
function aggregateRates() {
	const rates = [];
	for (let i = 0; i < RES_COUNT; i++) rates.push([0, 0]);
	const win = windowMs();
	const cutoff = state.clock - win;
	// don't understate rates right after load, but never divide by < 1s
	const horizon = Math.max(1000, Math.min(win, state.clock));
	for (const e of state.selection) {
		const events = state.ledger.get(e);
		if (!events) continue;
		for (const ev of events) {
			if (ev.t < cutoff) continue;
			for (let i = 0; i < ev.r.length; i++) {
				if (ev.r[i]) rates[i][ev.dir] += ev.r[i];
			}
		}
	}
	const perSecond = 1000 / horizon;
	for (let i = 0; i < RES_COUNT; i++) {
		rates[i][PRODUCED] *= perSecond;
		rates[i][CONSUMED] *= perSecond;
	}
	return rates;
}

// --------------------------------------------------------------------------
// Selection highlight (canvas, world space — runs after renderHoveredCell)

function renderSelection(g, settings) {
	if (!state.selection.size) return;
	const ctx = g.ctx;
	ctx.save();
	ctx.globalAlpha = 1;
	ctx.lineWidth = g.unit * .02;
	ctx.strokeStyle = settings.highlightColor.value;
	ctx.fillStyle = settings.highlightFill.value;
	for (const e of state.selection) {
		if (!isAlive(g, e) || !g.isVisible(e)) continue;
		const xy = g.uvToXY(e.position);
		// footprint plus a small margin that hugs the building's base
		const mult = (e.entitySpan ? e.entitySpan * 2 + 1 : 1) + .05;
		const dx = .866 * g.unit * mult;
		const dy = .5 * g.unit * mult;
		ctx.beginPath();
		ctx.moveTo(xy[0], xy[1] - dy);
		ctx.lineTo(xy[0] + dx, xy[1]);
		ctx.lineTo(xy[0], xy[1] + dy);
		ctx.lineTo(xy[0] - dx, xy[1]);
		ctx.closePath();
		ctx.fill();
		ctx.stroke();
	}
	ctx.restore();
}

// --------------------------------------------------------------------------
// Stats panel (DOM)

function fmt(g, v) {
	if (!isFinite(v) || v < 0) return `0`;
	if (v >= 1e4) return String(g.makeReadable(v));
	if (v >= 100) return v.toFixed(0);
	if (v >= 10) return v.toFixed(1);
	return v.toFixed(2);
}

function refreshPanel() {
	if (typeof game === `undefined` || !game || !state.ui.panel) return;

	for (const e of state.selection) {
		if (!isAlive(game, e)) state.selection.delete(e);
	}
	pruneLedger(game);

	const panel = state.ui.panel;
	if (!state.selection.size) {
		panel.classList.remove(`rm-open`);
		return;
	}
	panel.classList.add(`rm-open`);
	state.ui.count.textContent = `${state.selection.size} building${state.selection.size === 1 ? `` : `s`}`;

	const rates = aggregateRates();
	const mul = state.perMinute ? 60 : 1;
	const suffix = state.perMinute ? `/min` : `/s`;
	state.ui.unit.textContent = suffix;

	const rows = state.ui.rows;
	rows.textContent = ``;
	let any = false;
	for (let i = 0; i < RES_COUNT; i++) {
		const p = rates[i][PRODUCED];
		const c = rates[i][CONSUMED];
		if (!p && !c) continue;
		any = true;

		const chip = document.createElement(`span`);
		chip.className = `rm-chip`;
		chip.style.backgroundColor = game.codex.resources[i].triplet[1];

		const name = document.createElement(`span`);
		name.className = `rm-name`;
		name.textContent = game.pronounce(`resources`, i);

		const cIn = document.createElement(`span`);
		cIn.className = `rm-out`;
		cIn.textContent = c ? `– ${fmt(game, c * mul)}` : ``;

		const cOut = document.createElement(`span`);
		cOut.className = `rm-in`;
		cOut.textContent = p ? `+ ${fmt(game, p * mul)}` : ``;

		const net = p - c;
		const cNet = document.createElement(`span`);
		cNet.className = `rm-net ${net > 0 ? `rm-pos` : net < 0 ? `rm-neg` : ``}`;
		cNet.textContent = `${net >= 0 ? `+` : `–`} ${fmt(game, Math.abs(net) * mul)} ${suffix}`;

		rows.append(chip, name, cOut, cIn, cNet);
	}
	if (!any) {
		const empty = document.createElement(`span`);
		empty.className = `rm-empty`;
		empty.textContent = `No resource flow observed yet…`;
		rows.append(empty);
	}
}

function buildUI(selectKey) {
	const panel = document.createElement(`div`);
	panel.id = `rm-panel`;

	const header = document.createElement(`div`);
	header.id = `rm-header`;

	const count = document.createElement(`span`);
	count.id = `rm-count`;

	const unit = document.createElement(`button`);
	unit.id = `rm-unit`;
	unit.title = `Toggle per-second / per-minute`;
	unit.addEventListener(`click`, () => {
		state.perMinute = !state.perMinute;
		refreshPanel();
	});

	const clear = document.createElement(`button`);
	clear.id = `rm-clear`;
	clear.textContent = `Clear`;
	clear.addEventListener(`click`, () => {
		state.selection.clear();
		refreshPanel();
	});

	header.append(count, unit, clear);

	const rows = document.createElement(`div`);
	rows.id = `rm-rows`;

	panel.append(header, rows);

	const badge = document.createElement(`div`);
	badge.id = `rm-badge`;
	badge.textContent = `SELECT MODE — click or drag over buildings · ${selectKey.toUpperCase()} or ESC to exit`;

	state.ui = { panel, rows, count, unit, badge };

	const attach = () => document.body.append(panel, badge);
	if (document.body) attach();
	else window.addEventListener(`DOMContentLoaded`, attach);
}

// --------------------------------------------------------------------------
// Mod definition

module.exports = {

	id: `resource-monitor`,
	name: `Resource Monitor`,
	description: `Press R to enter select mode, click/drag over buildings to select them, and watch the resources flowing in and out of the selection.`,
	version: `1.0.0`,
	gameVersion: `1.2.1`,
	loaderVersion: `1.0.0`,

	settings: {
		selectKey: {
			type: `string`,
			name: `Select Mode Key`,
			description: `Single key that toggles select mode.`,
			default: `r`,
			sanitize: (v, d) => {
				const s = String(v).trim().toLowerCase();
				return s.length === 1 ? s : d;
			}
		},
		windowSeconds: {
			type: `number`,
			name: `Averaging Window (seconds)`,
			description: `Rates are averaged over this many seconds (5-3600). Longer windows smooth out buildings that emit in bursts.`,
			default: 60,
			sanitize: (v, d) => (typeof v === `number` && isFinite(v) ? Math.max(5, Math.min(3600, v)) : d)
		},
		perMinute: {
			type: `boolean`,
			name: `Show Rates Per Minute`,
			description: `Start with rates displayed per minute instead of per second.`,
			default: false,
			sanitize: v => !!v
		},
		highlightColor: {
			type: `string`,
			name: `Highlight Outline Color`,
			description: `RGBA hex color for the selection outline.`,
			default: `#2266ffff`,
			sanitize: MOD_TOOLBOX.sanitizers.colorHexRGBA
		},
		highlightFill: {
			type: `string`,
			name: `Highlight Fill Color`,
			description: `RGBA hex color for the selection fill.`,
			default: `#2266ff28`,
			sanitize: MOD_TOOLBOX.sanitizers.colorHexRGBA
		}
	},

	getPatches(mctx) {
		state.mctx = mctx;
		return {
			Game: {
				wrap: {
					// Left mouse press: toggle selection instead of mining.
					// Calling the original with rightclick=true keeps the wrap
					// contract while skipping the whole left-click branch.
					processDown(ctx, rightclick) {
						if (!state.selectMode || rightclick) return ctx.original(rightclick);
						ctx.self.mouse.state = 1;
						state.dragVisited.clear();
						// The pressed building defines what this whole drag paints
						// (toggle of its state). Pressing empty ground, a cube or
						// a dying entity starts a select-drag.
						const e = ctx.self.hoveredEntity;
						state.dragAction = isAlive(ctx.self, e) && e.name !== `cube` ? !state.selection.has(e) : true;
						if (e) paintSelection(ctx.self, e);
						return ctx.original(true);
					},
					// Left drag: paint-toggle each building once per drag.
					// Masking the button (click=0) keeps hover updates and
					// panning intact while suppressing drag-mining.
					processMousemove2(ctx, xy, dxy, click) {
						if (!state.selectMode || click !== 1) return ctx.original(xy, dxy, click);
						const res = ctx.original(xy, dxy, 0);
						const e = ctx.self.hoveredEntity;
						if (e) paintSelection(ctx.self, e);
						return res;
					},
					// Partial fuel intake: compute what will actually be taken
					// before the original subtracts it.
					askForResources(ctx, r, d, f, skip) {
						let taken = null;
						if (!skip && Array.isArray(r) && Array.isArray(d)) {
							taken = [];
							for (let i = 0; i < r.length; i++) {
								if (r[i]) taken[i] = Math.min(ctx.self.resources[i], r[i]);
							}
						}
						const result = ctx.original(r, d, f, skip);
						if (taken) record(ctx.self.stuffMap[`u${d[0]}v${d[1]}`], CONSUMED, taken);
						return result;
					}
				},
				observe: {
					// Note: drag state is reset at the next press (processDown),
					// not on mouseup — the game's gamepad polling can fire
					// spurious processMouseup calls mid-drag.
					// Picking up a tool (Q) or a building (E) replaces the
					// selection tool, like the game's own tools replace each other.
					processQ(ctx) {
						if (state.selectMode && ctx.self.itemInHand) exitSelectMode();
					},
					processE(ctx) {
						if (state.selectMode && ctx.self.itemInHand) exitSelectMode();
					},
					// Game-time clock: frozen while the game is paused/halted.
					updateCycle(ctx, result, span) {
						state.clock += span || 0;
					},
					// Fuel intake: d is the requesting building's [u,v].
					requestResources(ctx, result, r, d, f, skip) {
						if (result === true && !skip && Array.isArray(r) && Array.isArray(d)) {
							record(ctx.self.stuffMap[`u${d[0]}v${d[1]}`], CONSUMED, r);
						}
					},
					// Production at emission: p is the source in canvas pixels.
					// A custom callback f means the transfer does NOT credit the
					// player (internal move, e.g. cube -> consumer) — skip those.
					createResourceTransfer(ctx, result, r, p, d, f, v, skip) {
						if (!skip && !f && Array.isArray(r) && Array.isArray(p)) {
							record(entityFromScreen(ctx.self, p), PRODUCED, r);
						}
					},
					// Chasm-network production (gradient well, general decay
					// reactor): the emitting entity's grid cell is path[0].
					// A custom callback f means no player credit (e.g. the
					// silo's fuel-delivery animation) — skip those.
					createChasmTransfer(ctx, result, r, path, f, v, skipIndex) {
						if (!f && Array.isArray(r) && Array.isArray(path) && Array.isArray(path[0])) {
							record(ctx.self.stuffMap[`u${path[0][0]}v${path[0][1]}`], PRODUCED, r);
						}
					},
					renderHoveredCell(ctx) {
						renderSelection(ctx.self, state.mctx.settings);
					}
				}
			}
		};
	},

	getStyles() {
		return `
#rm-panel {
	position: fixed;
	top: 1rem;
	/* sit to the left of the shop (width: var(--unit) * 14.8 + padding) */
	right: calc(var(--unit, 16px) * 14.8 + 26px);
	min-width: 22rem;
	max-width: 28rem;
	z-index: 900;
	display: none;
	flex-direction: column;
	gap: .5rem;
	background: #ffffffee;
	color: #112;
	border-radius: .6rem;
	padding: .8rem 1rem;
	font-family: 'Montserrat', sans-serif;
	font-size: .85rem;
	-webkit-user-select: none;
	user-select: none;
	box-shadow: 0 .15rem 1rem #0003;
}

#rm-panel.rm-open {
	display: flex;
}

#rm-header {
	display: flex;
	align-items: center;
	gap: .5rem;
}

#rm-count {
	flex: 1;
	font-weight: 600;
}

#rm-unit, #rm-clear {
	padding: .2rem .6rem;
	background: #1121;
	color: #112;
	border: none;
	border-radius: .4rem;
	font-family: inherit;
	font-size: .8rem;
	cursor: pointer;
}

#rm-unit:hover, #rm-clear:hover {
	background: #1122;
}

#rm-rows {
	display: grid;
	grid-template-columns: auto 1fr auto auto auto;
	gap: .2rem .7rem;
	align-items: center;
}

.rm-chip {
	width: .7rem;
	height: .7rem;
	border-radius: 50%;
	border: 1px solid #0003;
}

.rm-name {
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.rm-in {
	color: ${GAIN_COLOR};
	text-align: right;
	font-variant-numeric: tabular-nums;
}

.rm-out {
	color: ${LOSS_COLOR};
	text-align: right;
	font-variant-numeric: tabular-nums;
}

.rm-net {
	text-align: right;
	font-weight: 600;
	font-variant-numeric: tabular-nums;
}

.rm-net.rm-pos { color: ${GAIN_COLOR}; }
.rm-net.rm-neg { color: ${LOSS_COLOR}; }

.rm-empty {
	grid-column: 1 / -1;
	color: #1128;
}

#rm-badge {
	position: fixed;
	bottom: 1.2rem;
	left: 50%;
	transform: translateX(-50%);
	z-index: 900;
	display: none;
	background: #112c;
	color: #eee;
	padding: .5rem 1.2rem;
	border-radius: 2rem;
	font-family: 'Montserrat', sans-serif;
	font-size: .85rem;
	letter-spacing: .5px;
	pointer-events: none;
}

body.rm-select-mode #rm-badge {
	display: block;
}
`;
	},

	onLoad(mctx) {
		state.mctx = mctx;
		state.perMinute = mctx.settings.perMinute.value;
		const selectKey = mctx.settings.selectKey.value;

		buildUI(selectKey);

		// Mode toggle key
		window.addEventListener(`keydown`, e => {
			if (e.key.toLowerCase() !== selectKey || e.repeat) return;
			if (MOD_TOOLBOX.focusesTextEditableElement()) return;
			if (typeof game === `undefined` || !game || game.splash?.isShown) return;
			if (state.selectMode) exitSelectMode();
			else enterSelectMode();
		});

		// Esc exits select mode without opening the menu. The game's own
		// listener is bubble-phase on window, so a capture-phase listener
		// runs first and can stop it.
		window.addEventListener(`keydown`, e => {
			if (e.key !== `Escape` || !state.selectMode) return;
			if (typeof game !== `undefined` && game && game.splash?.isShown) return;
			exitSelectMode();
			e.stopPropagation();
		}, true);

		setInterval(refreshPanel, 500);
	}
};
