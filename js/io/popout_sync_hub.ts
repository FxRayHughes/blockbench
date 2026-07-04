// [Popout] 跨窗口数据同步的传输层：基于 MessageChannelMain 中介建立的
// MessagePort 双向直连，不经 ipcMain 转发。
//
// 握手流程(由主进程 electron/main.js 的 createPopoutWindow 单方主导，见那里的
// 注释)：popout 窗口创建时，主进程用 MessageChannelMain 生成一对 port，
// port1 立即 postMessage 给主窗口(附带 popoutWindowId)，port2 等popout窗口
// did-finish-load 后再 postMessage 给它(附带 ownerWindowId)。双方各自监听
// 'popout-provide-message-port'，从 event.ports[0] 拿到端口即可直连收发。
//
// 一个主窗口可以同时有多个弹出窗口(多个面板/预览格分别弹出)，每个连接独立
// 维护在 connections 这个 Map 里，key 为“对方窗口的 BrowserWindow.id”。
//
// 广播内容：
//   - 工程快照(不含 bitmaps，跨窗口在同一进程内共享 Texture.img 等运行时对象，
//     不需要重新编码贴图数据) —— finish_edit 后防抖 250ms
//   - 选中态 —— update_selection 后防抖 60ms
//
// 防回声：applying_remote 标志在“应用远端快照/选中态”期间抑制本地
// finish_edit/update_selection 监听器往外广播，打断
// “应用远端→触发本地事件→又广播回去→对方再应用→...”的死循环。这是主要机制；
// window_instance_id + 自增 seq 作为直连管道之外的额外防御(丢弃回声/乱序包)。
import { Blockbench } from "../api";
import { ipcRenderer, process } from "../native_apis";
import { replaceProjectContentInPlace, applySelectionOnly } from "./popout_sync";
import { computeTransformDiff, applyTransformDiff } from "./popout_sync_diff";
import { Panels } from "../interface/panels";

type SyncMessage =
	| {type: 'project', seq: number, from: string, model: any}
	| {type: 'selection', seq: number, from: string, elementUuids: string[], groupUuids: string[]}
	| {type: 'mode', seq: number, from: string, mode: string}
	| {type: 'query_mode', seq: number, from: string}
	| {type: 'mode_response', seq: number, from: string, mode: string}
	| {type: 'diff', seq: number, from: string, projectUuid: string, elementChanges: [string, any][], groupChanges: [string, any][]}
	// [Popout] 通用面板运行时状态同步(见 panels.ts PanelOptions.popout.syncState)。
	// panelId 对应 Panels 字典的 key，state 是该面板 syncState.get() 的返回值。
	| {type: 'panel_state', seq: number, from: string, panelId: string, state: any};

interface Connection {
	port: MessagePort
	last_seen_seq: number
	// [Popout] (#7.3) 增量 diff:记录上次广播的快照,用于计算本次 diff。
	last_broadcasted_snapshot?: any
}

// [Popout] 本窗口是否是弹出窗口(SoloMode)。从 process.argv 直接判断，避免与
// popout.ts 之间形成模块加载期的循环依赖。用于让首次“连接即广播”单向化：
// 只有主窗口(非弹出)在连接建立时把自己的工程推给弹出窗口作为初始内容，
// 弹出窗口此时工程还是空的(启动画面)，不应该反向广播把主窗口的工程冲掉。
const is_popout_window = isApp && process.argv.some(a => a.startsWith('--popout-kind='));

const window_instance_id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let outgoing_seq = 0;
// [Popout] 正在应用远端快照/选中态。期间抑制本地广播，防回声死循环。
let applying_remote = false;
// [Popout] otherWindowId -> Connection。一个主窗口可能同时连接多个弹出窗口，
// 一个弹出窗口只连接它的主窗口，两种角色都用同一个 Map 表达。
const connections = new Map<number, Connection>();

function debounce<T extends (...args: any[]) => void>(fn: T, wait: number): T {
	let timer: any = null;
	return ((...args: any[]) => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => { timer = null; fn(...args); }, wait);
	}) as T;
}

function broadcast(message: SyncMessage) {
	for (let {port} of connections.values()) {
		port.postMessage(message);
	}
}

function broadcastProject() {
	if (!Project || applying_remote || connections.size == 0) return;
	outgoing_seq++;
	// [Popout] 不带 bitmaps —— 双方是同一台机器上的独立进程，但共享同一份磁盘
	// 上的模型状态；跨窗口在意的是结构/选中/变换数据的实时性，贴图数据没有
	// 变化时重复传输只会增加每次 finish_edit 后的序列化与传输开销。
	let snapshot = Codecs.project.compile({editor_state: true, raw: true});
	// [Popout] compile 不会输出工程自身的 uuid(uuid 不是 ModelProject 的导出
	// Property)。手动挂上，接收端 replaceProjectContentInPlace 才能按 uuid 找到
	// 要原地替换的目标工程(找不到则回退到 Codecs.project.load 首次构造)。
	snapshot.uuid = Project.uuid;

	// [Popout] (#7.3) 增量 diff:每个连接独立计算 diff,优先发 diff 消息(变换编辑),
	// 若检测到结构变化则回退全量 project 消息。首次同步(last_broadcasted_snapshot=null)
	// 必须全量。
	for (let conn of connections.values()) {
		let diff = computeTransformDiff(snapshot, conn.last_broadcasted_snapshot);
		if (diff && !diff.structuralChange && (diff.elementChanges.size > 0 || diff.groupChanges.size > 0)) {
			// 纯变换编辑,发 diff
			conn.port.postMessage({
				type: 'diff',
				seq: outgoing_seq,
				from: window_instance_id,
				projectUuid: Project.uuid,
				elementChanges: Array.from(diff.elementChanges.entries()),
				groupChanges: Array.from(diff.groupChanges.entries()),
			} as SyncMessage);
		} else {
			// 首次同步 / 结构变化 / 无变化 -> 发全量(无变化也发,保持简单;future:可优化)
			conn.port.postMessage({
				type: 'project',
				seq: outgoing_seq,
				from: window_instance_id,
				model: snapshot
			} as SyncMessage);
		}
		// 更新记忆快照(deep clone 避免后续修改污染)
		conn.last_broadcasted_snapshot = JSON.parse(JSON.stringify(snapshot));
	}
}
const broadcastProjectDebounced = debounce(broadcastProject, 250);

function broadcastSelection() {
	if (!Project || applying_remote || connections.size == 0) return;
	outgoing_seq++;
	broadcast({
		type: 'selection',
		seq: outgoing_seq,
		from: window_instance_id,
		elementUuids: Project.selected_elements.map((el: any) => el.uuid),
		groupUuids: (Group.multi_selected || []).map((g: any) => g.uuid),
	});
}
const broadcastSelectionDebounced = debounce(broadcastSelection, 60);

// [Popout] 通用面板运行时状态同步。任何 Panel 在自己的 popout 配置里声明
// syncState({events, get, apply})即可接入，不需要改这个文件。
// 由 registerPanelStateSync()(见下方)在 Panels 字典已填充完毕后统一订阅。
function broadcastPanelState(panel_id: string) {
	if (applying_remote || connections.size == 0) return;
	let panel = (Panels as any)[panel_id];
	let sync = panel?.popout_config?.syncState;
	if (!panel || !sync) return;
	outgoing_seq++;
	broadcast({
		type: 'panel_state',
		seq: outgoing_seq,
		from: window_instance_id,
		panelId: panel_id,
		state: sync.get(panel),
	});
}

/**
 * [Popout] 扫描 Panels 字典,给所有声明了 popout_config.syncState 的面板注册
 * 事件监听。必须在 setupPanels() 跑完(Panels 字典已填充)之后调用——不能放在
 * 本模块顶层的 `if (isApp)` 块里,那段代码在 boot_loader.js 里 import 时就
 * 执行,早于 setupInterface()/setupPanels(),此时 Panels 还是空字典。
 * 由 js/interface/popout.ts 的 initPopoutMode() 调用(它本身就在
 * setupInterface() 之后才被 boot_loader.js 调用)。
 *
 * 可安全重复调用:已注册过的 panel_id 会跳过,不会重复挂监听。插件注册的面板
 * 因为 loadInstalledPlugins() 是异步的，可能在首次调用时还不存在于 Panels
 * 字典里——插件加载完成后应再调一次本函数，把迟到的面板补上。
 */
const panel_state_sync_registered = new Set<string>();
export function registerPanelStateSync() {
	for (let panel_id in Panels) {
		if (panel_state_sync_registered.has(panel_id)) continue;
		let panel = (Panels as any)[panel_id];
		let sync = panel?.popout_config?.syncState;
		if (!sync) continue;
		panel_state_sync_registered.add(panel_id);
		let debounced = debounce(() => broadcastPanelState(panel_id), sync.debounce ?? 150);
		for (let event_name of sync.events) {
			Blockbench.addListener(event_name, debounced);
		}
	}
}

// [Popout] (#7.5) 模式(编辑/绘制/动画等)改为**独立**:子窗口切模式不影响主窗口,
// 主窗口切模式也不影响子窗口。两个窗口是独立进程、各自维护 Mode.selected 全局,
// 天然独立。仅在用户主动点"跟随主窗口"按钮时,子窗口发 query_mode 请求,主窗口
// 回 mode_response,子窗口收到后切到主窗口当前模式。
// 导出给 popout.ts 的"跟随主窗口模式"按钮调用。
export function requestFollowMainWindowMode() {
	if (connections.size == 0) return;
	outgoing_seq++;
	broadcast({type: 'query_mode', seq: outgoing_seq, from: window_instance_id});
}

function handleIncoming(conn: Connection, msg: SyncMessage) {
	if (msg.from == window_instance_id) return; // 丢弃回声(直连管道理论上不会发生，防御性保留)
	if (msg.seq <= conn.last_seen_seq) return; // 丢弃乱序/重复包
	conn.last_seen_seq = msg.seq;

	// [Popout] 应用期间置位 applying_remote，抑制本地 finish_edit/update_selection
	// 监听器把“刚应用进来的远端改动”又当作本地编辑广播出去。500ms 后复位：
	// replaceProjectContentInPlace 触发的 Vue/Three.js 副作用有部分是异步落地的，
	// 复位太早可能让某个异步回调误判成“用户新编辑”而广播回声。
	applying_remote = true;
	try {
		if (msg.type == 'project') {
			replaceProjectContentInPlace(msg.model);
		} else if (msg.type == 'selection') {
			applySelectionOnly(msg.elementUuids, msg.groupUuids);
		} else if (msg.type == 'query_mode') {
			// [Popout] (#7.5) 收到"查询当前模式"请求(通常主窗口收到子窗口的跟随请求),
			// 回一个 mode_response 带上自己当前模式。不受 applying_remote 抑制。
			if (Mode.selected) {
				outgoing_seq++;
				conn.port.postMessage({
					type: 'mode_response', seq: outgoing_seq, from: window_instance_id, mode: Mode.selected.id
				} as SyncMessage);
			}
		} else if (msg.type == 'mode_response') {
			// [Popout] (#7.5) 子窗口收到主窗口的模式回复,切过去(仅本窗口)。
			let mode = (Modes.options as any)[msg.mode];
			if (mode && Mode.selected !== mode) mode.select();
		} else if (msg.type == 'mode') {
			// 兼容旧消息类型(理论上不再发送);仅应用到本窗口。
			let mode = (Modes.options as any)[msg.mode];
			if (mode && Mode.selected !== mode) mode.select();
		} else if (msg.type == 'diff') {
			// [Popout] (#7.3) 增量 diff:只更新变化的属性,不清空重建,无闪烁。
			applyTransformDiff({
				elementChanges: new Map(msg.elementChanges),
				groupChanges: new Map(msg.groupChanges),
				structuralChange: false
			});
		} else if (msg.type == 'panel_state') {
			// [Popout] 通用面板运行时状态同步的应用端。面板不存在(比如对方窗口
			// 弹出了一个本窗口未挂载的面板 id)或未声明 syncState 时安全跳过。
			let panel = (Panels as any)[msg.panelId];
			let sync = panel?.popout_config?.syncState;
			if (panel && sync) {
				sync.apply(panel, msg.state);
			}
		}
	} finally {
		setTimeout(() => { applying_remote = false; }, 500);
	}
}

// [Popout] 监听器在模块加载时就无条件注册，不等待任何显式调用——端口是由主进程
// 单方主导推送过来的(见 electron/main.js createPopoutWindow)，对主窗口来说
// port1 在窗口创建时就同步发出，监听器必须提前就位否则会错过这条消息。
if (isApp) {
	ipcRenderer.on('popout-provide-message-port', (event, data: {popoutWindowId?: number, ownerWindowId?: number}) => {
		if (!event.ports || !event.ports[0]) return;
		let other_window_id = data?.popoutWindowId ?? data?.ownerWindowId;
		if (other_window_id == null) return;

		let port = event.ports[0];
		let conn: Connection = {port, last_seen_seq: 0};
		connections.set(other_window_id, conn);
		port.onmessage = (e) => handleIncoming(conn, e.data as SyncMessage);
		port.start();
		// [Popout] 连接建立后立即把当前完整工程推给对方作为初始内容，避免弹出
		// 窗口打开时是空的、要等下一次编辑才追上。但只有主窗口(非弹出)做这件事：
		// 弹出窗口此刻工程还是空的启动画面，反向广播会把主窗口的工程冲掉。
		if (!is_popout_window) {
			broadcastProject();
			// [Popout] 同理,把主窗口当前的面板运行时状态(颜色/播放头等)也
			// 作为初始内容推给新连接,否则弹出窗口要等下一次状态变化事件
			// 才能追上(比如调色盘弹出瞬间还是默认白色,直到用户下次改色)。
			for (let panel_id in Panels) {
				let panel = (Panels as any)[panel_id];
				let sync = panel?.popout_config?.syncState;
				if (!sync) continue;
				outgoing_seq++;
				conn.port.postMessage({
					type: 'panel_state',
					seq: outgoing_seq,
					from: window_instance_id,
					panelId: panel_id,
					state: sync.get(panel),
				} as SyncMessage);
			}
		}
	});

	Blockbench.addListener('finish_edit', broadcastProjectDebounced);
	Blockbench.addListener('update_selection', broadcastSelectionDebounced);
	// [Popout] undo()/redo()(js/undo.js)只 dispatch 'undo'/'redo',不会触发
	// 'finish_edit',原本的广播链路完全绑定在 finish_edit 上,导致撤销/重做的
	// 工程数据变化不会广播给弹出窗口。这里补上监听,复用同一套防抖广播,不改
	// undo.js 本身。
	Blockbench.addListener('undo', broadcastProjectDebounced);
	Blockbench.addListener('undo', broadcastSelectionDebounced);
	Blockbench.addListener('redo', broadcastProjectDebounced);
	Blockbench.addListener('redo', broadcastSelectionDebounced);
	// [Popout] (#7.5) 不再监听 select_mode 自动广播 —— 模式改为独立,仅"跟随主窗口"
	// 按钮主动触发 requestFollowMainWindowMode()。
}

/**
 * 关闭与 other_window_id 的同步连接(对方窗口已关闭时调用)，释放 MessagePort。
 */
export function stopPopoutSync(other_window_id: number) {
	let conn = connections.get(other_window_id);
	if (conn) {
		conn.port.close();
		connections.delete(other_window_id);
	}
}
