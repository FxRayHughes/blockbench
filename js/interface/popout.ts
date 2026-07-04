// [Popout] 面板/预览格弹出为独立 Electron 窗口。
//
// 技术路线：子窗口复用同一个 index.html + dist/bundle.js (全量资源，不做精简
// entry —— Panel/Preview 实例是各业务模块顶层 side-effect 创建的，无法在模块
// 粒度切割出子集)。SoloMode 通过 additionalArguments 传入的
// --popout-kind=/--popout-target= 检测，在 boot_loader.js 完整启动流程跑完后
// 做一次性的视觉裁剪：隐藏主UI，只把目标 Panel 容器 / Preview 挂到
// #popout_content 上。跨窗口通讯见 js/io/popout_sync_hub.ts (MessagePort 直连，
// 不经 ipcMain 中转)。
import { Blockbench } from "../api";
import { ipcRenderer, currentwindow, process } from "../native_apis";
import { panelPopoutDetachHistory } from "./panels";
import { stopPopoutSync, requestFollowMainWindowMode, registerPanelStateSync } from "../io/popout_sync_hub";

export type PopoutKind = 'panel' | 'preview';

/** 从 process.argv 解析出的 SoloMode 参数，非 popout 窗口下为 null */
export const SoloMode: {kind: PopoutKind, targetId: string} | null = (() => {
	if (!isApp) return null;
	let kind_arg = process.argv.find(a => a.startsWith('--popout-kind='));
	let target_arg = process.argv.find(a => a.startsWith('--popout-target='));
	if (!kind_arg || !target_arg) return null;
	return {
		kind: kind_arg.split('=')[1] as PopoutKind,
		targetId: target_arg.split('=')[1],
	};
})();

/** [Popout] 弹出窗口里，创建它的主窗口的 Electron BrowserWindow.id */
const popout_owner_win_id: number | null = (() => {
	if (!isApp || !SoloMode) return null;
	let arg = process.argv.find(a => a.startsWith('--popout-owner-window-id='));
	if (!arg) return null;
	return parseInt(arg.split('=')[1]);
})();

/**
 * 在 boot_loader.js 完整启动流程末尾调用。若当前窗口是 popout 窗口，
 * 执行视觉裁剪 + 挂载目标内容(数据同步的 MessagePort 由主进程主动推送，
 * popout_sync_hub.ts 模块加载时已注册好接收监听器)；否则是主窗口，注册
 * popout-closed 的收回监听。
 */
export function initPopoutMode(): void {
	if (!isApp) return;
	console.log('[popout] initPopoutMode: SoloMode=' + JSON.stringify(SoloMode) + ' argv=' + JSON.stringify(process.argv.filter(a => a.startsWith('--popout'))));

	// [Popout] 此时 setupInterface()/setupPanels() 已跑完(boot_loader.js 调用
	// 顺序:setupInterface() 在前,initPopoutMode() 在后),Panels 字典已填充,
	// 可以安全扫描所有面板的 popout_config.syncState 并注册订阅。主窗口和
	// 弹出窗口都要注册——双方都需要在本地状态变化时向对方广播。
	registerPanelStateSync();

	if (SoloMode) {
		// [Popout] 弹出窗口里,任何挂载期异常都写到可见的覆盖层,避免"空白一闪而过"
		// 无从排查(弹出窗口可能来不及看自身 devtools)。
		try {
			applySoloWindowMode();
		} catch (err) {
			showPopoutError('applySoloWindowMode 抛异常: ' + (err && err.stack || err));
			console.error('[popout] applySoloWindowMode failed', err);
		}
	} else {
		// 主窗口：监听子窗口关闭事件，把面板/预览格收回原位
		ipcRenderer.on('popout-closed', (event, data) => {
			handlePopoutClosed(data);
		});
		// [Popout] 只在"打开一个已存在的项目文件"时恢复上次的弹出窗口,不在新建空白
		// [Popout] (#7.1) 用户要求:关闭后只记位置,不自动恢复。手动点"弹出"按钮时
		// 再弹且用记忆位置。因此注释掉 restoreOpenPopouts() 自动恢复调用。
		// 几何记忆(savePopoutGeometry/getPopoutGeometry)仍然工作,手动弹出时
		// requestPopout 会读取上次记忆的 bounds。
		// let restored = false;
		// Blockbench.addListener('load_project', () => {
		// 	if (restored) return;
		// 	restored = true;
		// 	restoreOpenPopouts();
		// });
	}
}

/** [Popout] 在弹出窗口里显示一条醒目的错误信息(而不是留一片空白) */
function showPopoutError(message: string) {
	document.body.classList.add('solo-panel-mode');
	let content = document.getElementById('popout_content');
	if (!content) return;
	content.innerHTML = '';
	let box = document.createElement('div');
	box.style.cssText = 'padding:16px;color:var(--color-text);font:13px/1.5 monospace;white-space:pre-wrap;overflow:auto;';
	box.textContent = '[Popout] ' + message;
	content.append(box);
}

function applySoloWindowMode() {
	console.log('[popout] applySoloWindowMode start, kind=' + SoloMode.kind + ' target=' + SoloMode.targetId);
	document.body.classList.add('solo-panel-mode');
	setupPopoutTitleBar();

	if (SoloMode.kind == 'panel') {
		applyPanelPopoutContent(SoloMode.targetId);
	} else if (SoloMode.kind == 'preview') {
		applyPreviewPopoutContent(SoloMode.targetId);
	}
	console.log('[popout] applySoloWindowMode done');
}

function applyPanelPopoutContent(panel_id: string) {
	let panel = Panels[panel_id];
	if (!panel) {
		showPopoutError(`找不到面板 "${panel_id}"。已注册面板: ${Object.keys(Panels).join(', ')}`);
		return;
	}
	console.log('[popout] mounting panel "' + panel_id + '" -> #popout_content');
	let content = document.getElementById('popout_content');
	content.append(panel.container);
	panel.container.classList.remove('hidden');
	// [Popout] 标记为已弹出:此后本窗口的 updateInterface()/updateSidebarOrder()
	// 不再把这个容器拽回(隐藏的)侧栏,保证它一直留在 #popout_content 里可见。
	panel.popout_active = true;
	// moveTo('hidden') 在主窗口侧会 remove() 掉 node，这里补回
	if (!panel.node.isConnected) {
		panel.container.append(panel.node);
	}
	panel.node.classList.remove('floating');

	document.getElementById('popout_title_bar_text').textContent = panel.name;

	let info = {width: window.innerWidth, height: window.innerHeight};
	panel.popout_config?.onPopoutReady?.(panel, info);

	window.addEventListener('resize', () => {
		panel.popout_config?.onPopoutResize?.(panel, window.innerWidth, window.innerHeight);
	});
}

function applyPreviewPopoutContent(index_str: string) {
	// 具体实现在 js/preview/preview.js 里的 applyPreviewPopoutMount()，
	// 因为需要访问 Preview.split_screen 的私有状态；这里只做转发，
	// 避免 popout.ts 反向依赖 preview.js 造成循环 import。
	Blockbench.dispatchEvent('popout_mount_preview', {index: parseInt(index_str)});
}

function setupPopoutTitleBar() {
	document.getElementById('popout_controls_button_minimize').addEventListener('click', () => {
		currentwindow.minimize();
	});
	// [Popout] 最大化按钮已从 HTML 移除(#7.4),不再绑定事件。
	document.getElementById('popout_controls_button_close').addEventListener('click', () => {
		if (popout_owner_win_id != null) stopPopoutSync(popout_owner_win_id);
		currentwindow.close();
	});
	// [Popout] 最大化/取消最大化的 body class 切换也移除(按钮已删)。

	let pin_button = document.getElementById('popout_pin_button');
	pin_button.addEventListener('click', () => {
		let next_state = !currentwindow.isAlwaysOnTop();
		currentwindow.setAlwaysOnTop(next_state);
		pin_button.classList.toggle('active', next_state);
	});

	// [Popout] 模式切换按钮 (#7.5)。点击弹出菜单:
	//  - 各模式项:仅切换**本窗口**模式,不影响主窗口(独立模式)。
	//  - "跟随主窗口":主动向主窗口查询当前模式并切过去(requestFollowMainWindowMode)。
	let mode_switcher = document.getElementById('popout_mode_switcher');
	mode_switcher.addEventListener('click', (event) => {
		let entries: any[] = [];
		for (let id in Modes.options) {
			let mode = Modes.options[id];
			entries.push({
				id,
				icon: mode.icon || 'mode',
				name: mode.name,
				condition: mode.condition,
				click: () => { mode.select(); },
			});
		}
		entries.push('_');  // 分隔线
		entries.push({
			id: 'follow_main_window',
			icon: 'link',
			name: tl('menu.popout.follow_main_window') || 'Follow Main Window',
			click: () => { requestFollowMainWindowMode(); },
		});
		new Menu(entries).open(mode_switcher);
	});
}

function handlePopoutClosed(data: {kind: PopoutKind, targetId: string, bounds?: {x: number, y: number, width: number, height: number}, popoutWindowId?: number}) {
	if (data.bounds) {
		savePopoutGeometry(data.kind, data.targetId, data.bounds);
	}
	// [Popout] 用户手动关闭弹出窗口 -> 从"待恢复"集合里移除,下次启动不再自动弹出。
	// (应用整体退出时主窗口已销毁,这条 popout-closed 不会送达,open 状态得以保留,
	//  正是下次启动要恢复的那些窗口。)
	setPopoutOpenState(data.kind, data.targetId, false);
	if (data.popoutWindowId != null) {
		stopPopoutSync(data.popoutWindowId);
	}
	if (data.kind == 'panel') {
		recoverPanel(data.targetId);
	} else if (data.kind == 'preview') {
		Blockbench.dispatchEvent('popout_recover_preview', {index: parseInt(data.targetId)});
	}
}

function recoverPanel(panel_id: string) {
	let panel = Panels[panel_id];
	if (!panel) return;
	// [Popout] 清掉弹出标记(在主窗口这个 Panel 实例上一般本就是 false,防御性重置),
	// 让它重新参与主界面布局。
	panel.popout_active = false;
	panel.popout_config?.onPopoutClose?.(panel);
	panel.moveTo(panel.previous_slot || 'left_bar');

	let host_id = panelPopoutDetachHistory.get(panel_id);
	if (host_id && Panels[host_id]) {
		Panels[host_id].attachPanel(panel);
	}
	panelPopoutDetachHistory.delete(panel_id);
	// 同时收回曾经附着在这个面板上、跟随它一起摘出的子面板
	for (let [id, host] of [...panelPopoutDetachHistory.entries()]) {
		if (host == panel_id && Panels[id]) {
			panel.attachPanel(Panels[id]);
			panelPopoutDetachHistory.delete(id);
		}
	}
}

/** [Popout] 弹出窗口几何持久化：panelId/preview_<index> -> {x,y,width,height} */
export function savePopoutGeometry(kind: PopoutKind, targetId: string, bounds: {x: number, y: number, width: number, height: number}) {
	StateMemory.init('panel_popout_geometry', 'object');
	let key = `${kind}:${targetId}`;
	let all = StateMemory.get('panel_popout_geometry') as Record<string, any>;
	all[key] = bounds;
	StateMemory.save('panel_popout_geometry');
}
export function getPopoutGeometry(kind: PopoutKind, targetId: string): {x?: number, y?: number, width: number, height: number} | null {
	StateMemory.init('panel_popout_geometry', 'object');
	let all = StateMemory.get('panel_popout_geometry') as Record<string, any>;
	let entry = all[`${kind}:${targetId}`];
	if (!entry) return null;
	return {x: entry.x, y: entry.y, width: entry.width, height: entry.height};
}

/**
 * [Popout] 记录当前"处于弹出状态"的面板/预览格集合(key = `${kind}:${targetId}`),
 * 用于下次启动时把它们恢复出来。与几何数据分开存:几何随窗口 resize/move 更新,
 * 这个只在弹出/收回时增删。
 */
function setPopoutOpenState(kind: PopoutKind, targetId: string, open: boolean) {
	StateMemory.init('open_popouts', 'object');
	let all = StateMemory.get('open_popouts') as Record<string, boolean>;
	let key = `${kind}:${targetId}`;
	if (open) all[key] = true; else delete all[key];
	StateMemory.save('open_popouts');
}

/**
 * [Popout] 启动完成后(仅主窗口)把上次退出时仍处于弹出状态的面板/预览格重新弹出,
 * 并靠持久化的几何数据落回原来的位置。主进程 popout-request 里有去重(existing
 * 聚焦),所以重复调用是安全的。
 */
function restoreOpenPopouts() {
	StateMemory.init('open_popouts', 'object');
	let all = StateMemory.get('open_popouts') as Record<string, boolean>;
	for (let key in all) {
		if (!all[key]) continue;
		let sep = key.indexOf(':');
		if (sep == -1) continue;
		let kind = key.slice(0, sep) as PopoutKind;
		let targetId = key.slice(sep + 1);
		// 面板:必须当前存在且可弹出;预览格:交给触发方判断。用默认尺寸,
		// requestPopout 内部会优先用记忆的几何(含 x/y)。
		if (kind == 'panel') {
			let panel = Panels[targetId];
			if (!panel || !panel.canPopout()) continue;
			panel.requestPanelPopout();
		} else if (kind == 'preview') {
			requestPopout('preview', targetId, [480, 480]);
		}
	}
}

/**
 * [Popout] 通用触发：向主进程请求弹出，携带上次记忆的窗口尺寸与位置(若有)。
 * 数据同步的 MessagePort 由主进程创建popout窗口时主动推送，不需要在这里
 * 显式建立连接(见 js/io/popout_sync_hub.ts 头部注释)。
 */
export function requestPopout(kind: PopoutKind, targetId: string, default_size: [number, number]) {
	let remembered = getPopoutGeometry(kind, targetId);
	let width = remembered?.width ?? default_size[0];
	let height = remembered?.height ?? default_size[1];
	let x = remembered?.x;
	let y = remembered?.y;
	setPopoutOpenState(kind, targetId, true);
	ipcRenderer.send('popout-request', {kind, targetId, width, height, x, y});
}

const global = {
	SoloMode,
	initPopoutMode,
	requestPopout,
	getPopoutGeometry,
};
declare global {
	const SoloMode: typeof global.SoloMode
	const initPopoutMode: typeof global.initPopoutMode
	const requestPopout: typeof global.requestPopout
	const getPopoutGeometry: typeof global.getPopoutGeometry
}
Object.assign(window, global);
