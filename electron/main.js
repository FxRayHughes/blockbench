import {app, BrowserWindow, Menu, ipcMain, shell, MessageChannelMain} from 'electron'
import path from 'path'
import url from 'url'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const { autoUpdater } = require('electron-updater');
const remote = require('@electron/remote/main')
remote.initialize();

let all_wins = [];
let orig_win;
let load_project_data;
// [Popout] windowId -> {win, kind: 'panel'|'preview', targetId, ownerWinId}
let popout_wins = new Map();
let popout_win_id_counter = 0;

(() => {
	// Allow advanced users to specify a custom userData directory.
	// Useful for portable installations, and for setting up development environments.
	const index = process.argv.findIndex(arg => arg === '--userData');
	if (index !== -1) {
		if (!process.argv.at(index + 1)) {
			console.error('No path specified after --userData')
			process.exit(1)
		}
		app.setPath('userData', process.argv[index + 1]);
	}
})()

const LaunchSettings = {
	path: path.join(app.getPath('userData'), 'launch_settings.json'),
	settings: {},
	get(key) {
		return this.settings[key]
	},
	set(key, value) {
		this.settings[key] = value;
		let content = JSON.stringify(this.settings, null, '\t');
		fs.writeFileSync(this.path, content);
	},
	load() {
		try {
			if (fs.existsSync(this.path)) {
				let content = fs.readFileSync(this.path, 'utf-8');
				this.settings = JSON.parse(content);
			}
		} catch (error) {}
		return this;
	}
}.load();

if (LaunchSettings.get('hardware_acceleration') == false) {
	app.disableHardwareAcceleration();
}

function createWindow(second_instance, options = {}) {
	if (app.requestSingleInstanceLock && !app.requestSingleInstanceLock()) {
		app.quit()
		return;
	}
	let win_options = {
		icon: 'icon.ico',
		show: false,
		backgroundColor: '#21252b',
		frame: LaunchSettings.get('native_window_frame') === true,
		titleBarStyle: 'hidden',
		minWidth: 640,
		minHeight: 480,
		width: 1080,
		height: 720,
		webPreferences: {
			webgl: true,
			webSecurity: true,
			nodeIntegration: true,
			contextIsolation: false,
			enableRemoteModule: true
		}
	};
	if (options.position) {
		win_options.x = options.position[0] - 300;
		win_options.y = Math.max(options.position[1] - 100, 0);
	}
	let win = new BrowserWindow(win_options)
	if (!orig_win) orig_win = win;
	all_wins.push(win);

	remote.enable(win.webContents)

	if (process.platform === 'darwin') {

		let template = [
			{
				"label": "Blockbench",
				"submenu": [
					{
						"role": "hide"
					},
					{
						"role": "hideothers"
					},
					{
						"role": "unhide"
					},
					{
						"type": "separator"
					},
					{
                        "role": "quit"
					}
				]
			},
			{
				"label": "Edit",
				"submenu": [
					{
						"role": "cut"
					},
					{
						"role": "copy"
					},
					{
						"role": "paste"
					},
					{
						"role": "selectall"
					}
				]
			},
			{
				"label": "Window",
				"role": "window",
				"submenu": [
					{
						"label": "Toggle Full Screen",
						"accelerator": "Ctrl+Command+F"
					},
					{
						"role": "minimize"
					},
					{
						"role": "close"
					},
					{
						"type": "separator"
					},
					{
						"role": "front"
					}
				]
			}
		]


		var osxMenu = Menu.buildFromTemplate(template);
		Menu.setApplicationMenu(osxMenu)
	} else {
		win.setMenu(null);
	}
	
	if (options.maximize !== false) win.maximize()
	win.show()

	var index_path = path.join(__dirname, './../index.html')
	win.loadURL(url.format({
		pathname: index_path,
		protocol: 'file:',
		slashes: true
	}))

	// [Popout] 开发模式下主窗口也自动开分离式 devtools,方便和弹出窗口一起调试。
	if (!app.isPackaged) {
		win.webContents.once('did-finish-load', () => {
			if (!win.isDestroyed()) win.webContents.openDevTools({mode: 'detach'});
		});
	}
	win.on('closed', () => {
		all_wins.splice(all_wins.indexOf(win), 1);
		// [Popout] 级联关闭该窗口名下所有弹出的面板/预览格窗口，防止孤儿窗口
		for (let [popout_id, entry] of popout_wins) {
			if (entry.ownerWinId == win.id && !entry.win.isDestroyed()) {
				entry.win.close();
			}
		}
		win = null;
	})
	if (second_instance === true) {
		win.webContents.second_instance = true;
	}
	return win;
}

// [Popout] 面板/预览格弹出为主窗口的子窗口(child window,parent=主窗口)。
// 窗口仍加载同一个 index.html+bundle.js
// (全量资源，不做精简entry —— Panel/Preview实例是各业务模块顶层side-effect
// 创建的，无法在模块粒度切割出子集)，通过 additionalArguments 传入
// --popout-kind=/--popout-target=，渲染进程侧的 boot_loader.js 在完整启动流程
// 跑完后读取这两个参数做一次性的视觉裁剪(applyPanelPopout/applyPreviewPopout)。
// 无边框(frame:false)+隐藏原生titlebar，标题栏/拖拽区/置顶按钮由渲染进程自绘，
// 跟主窗口风格一致。
function createPopoutWindow(owner_win, {kind, targetId, width, height, x, y}) {
	let win_options = {
		icon: 'icon.ico',
		show: false,
		backgroundColor: '#21252b',
		frame: false,
		titleBarStyle: 'hidden',
		// [Popout] 作为主窗口的子窗口(而非独立顶层窗口):始终浮在主窗口之上,
		// 随主窗口最小化而隐藏,主窗口关闭时一并关闭。这也是级联关闭逻辑的兜底。
		parent: owner_win,
		minWidth: 280,
		minHeight: 200,
		width: width || 480,
		height: height || 480,
		webPreferences: {
			webgl: true,
			webSecurity: true,
			nodeIntegration: true,
			contextIsolation: false,
			enableRemoteModule: true,
			additionalArguments: [
				`--popout-kind=${kind}`,
				`--popout-target=${targetId}`,
				`--popout-owner-window-id=${owner_win.id}`,
			]
		}
	};
	// [Popout] 恢复上次记忆的位置(x,y 由渲染进程从 StateMemory 读出后传入)。
	// 只有两个值都是有限数才应用,否则交给 OS 默认居中放置。
	if (Number.isFinite(x) && Number.isFinite(y)) {
		win_options.x = x;
		win_options.y = y;
	}
	let win = new BrowserWindow(win_options);
	remote.enable(win.webContents);
	win.setMenu(null);
	win.show();

	// [Popout] 开发模式下把弹出窗口 renderer 的 console、崩溃、加载失败事件转发到
	// 主进程终端,便于调试(弹出窗口不再自己开 devtools —— 一闪而过时看不到,而且
	// 会干扰;需要时在主窗口终端看转发日志即可)。
	if (!app.isPackaged) {
		// Electron 40 的 console-message 事件签名从 (event,level,message,line,sourceId)
		// 改成了单个 details 对象;两种都兼容一下,避免打出 undefined。
		win.webContents.on('console-message', (...a) => {
			let msg, src, line;
			if (a[0] && typeof a[0] == 'object' && 'message' in a[0]) {
				msg = a[0].message; src = a[0].sourceId; line = a[0].lineNumber;
			} else {
				msg = a[2]; line = a[3]; src = a[4];
			}
			console.log(`[popout ${kind}:${targetId}] ${msg}  (${src}:${line})`);
		});
		win.webContents.on('render-process-gone', (e, details) => {
			console.error(`[popout ${kind}:${targetId}] render-process-gone:`, details);
		});
		win.webContents.on('did-fail-load', (e, code, desc, u) => {
			console.error(`[popout ${kind}:${targetId}] did-fail-load ${code} ${desc} ${u}`);
		});
		win.on('closed', () => console.log(`[popout ${kind}:${targetId}] window closed`));
	}

	let index_path = path.join(__dirname, './../index.html');
	win.loadURL(url.format({
		pathname: index_path,
		protocol: 'file:',
		slashes: true
	}));

	let popout_id = ++popout_win_id_counter;
	popout_wins.set(popout_id, {win, kind, targetId, ownerWinId: owner_win.id});

	// [Popout] 主进程一次性创建 MessageChannelMain 并把两端分发给双方，比“双方各自
	// 请求、主进程转发”更简单且没有竞态：port1 立即发给已经在运行的主窗口，
	// port2 等popout窗口 did-finish-load(此时 popout.ts 的 IPC 监听已经注册好)
	// 后再发，避免消息在监听器就位前就发出而丢失。
	let channel = new MessageChannelMain();
	if (!owner_win.isDestroyed()) {
		owner_win.webContents.postMessage('popout-provide-message-port', {popoutWindowId: win.id}, [channel.port1]);
	}
	win.webContents.once('did-finish-load', () => {
		if (!win.isDestroyed()) {
			win.webContents.postMessage('popout-provide-message-port', {ownerWindowId: owner_win.id}, [channel.port2]);
		}
	});

	win.on('closed', () => {
		let bounds_before_close = popout_wins.get(popout_id)?.last_bounds;
		popout_wins.delete(popout_id);
		if (!owner_win.isDestroyed()) {
			owner_win.webContents.send('popout-closed', {kind, targetId, bounds: bounds_before_close, popoutWindowId: win.id});
		}
	});
	// Track last known bounds so they can be reported back on close, without
	// needing a high-frequency IPC round trip while the window is open.
	let bounds_update = () => {
		let entry = popout_wins.get(popout_id);
		if (entry) entry.last_bounds = win.getBounds();
	};
	win.on('resize', bounds_update);
	win.on('move', bounds_update);

	return win;
}

app.commandLine.appendSwitch('ignore-gpu-blacklist')
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('enable-accelerated-video')

app.on('second-instance', function (event, argv, cwd) {
	process.argv = argv;
	let win = all_wins.find(win => !win.isDestroyed());
	if (win && argv[argv.length-1 || 1] && argv[argv.length-1 || 1].substr(0, 2) !== '--') {
		win.webContents.send('open-model', argv[argv.length-1 || 1]);
		win.focus();
	} else {
		createWindow(true);
	}
})
app.on('open-file', function (event, path) {
	process.argv[process.argv.length-1 || 1] = path;
	let win = all_wins.find(win => !win.isDestroyed());
	if (win) {
		win.webContents.send('open-model', path);
	}
})

ipcMain.on('edit-launch-setting', (event, arg) => {
	LaunchSettings.set(arg.key, arg.value);
})
ipcMain.handle('get-launch-setting', (event, arg) => {
	return LaunchSettings.get(arg.key);
})
ipcMain.on('add-recent-project', (event, path) => {
	app.addRecentDocument(path);
})
ipcMain.on('dragging-tab', (event, value) => {
	all_wins.forEach(win => {
		if (win.isDestroyed() || win.id == event.sender.id) return;
		win.webContents.send('accept-detached-tab', JSON.parse(value));
	})
})
ipcMain.on('new-window', (event, data, position) => {
	if (typeof data == 'string') load_project_data = JSON.parse(data);
	if (position) {
		position = JSON.parse(position)
		let place_in_window = all_wins.find(win => {
			if (win.isDestroyed() || win.webContents == event.sender || win.isMinimized()) return false;
			let pos = win.getPosition();
			let size = win.getSize();
			return (position.offset[0] >= pos[0] && position.offset[0] <= pos[0] + size[0]
				 && position.offset[1] >= pos[1] && position.offset[1] <= pos[1] + size[1]);
		})
		if (place_in_window) {
			place_in_window.send('load-tab', load_project_data);
			place_in_window.focus();
			load_project_data = null;
		} else {
			createWindow(true, {
				maximize: false,
				position: position.offset
			});
		}
	} else {
		createWindow(true);
	}
})
ipcMain.on('close-detached-project', async (event, window_id, uuid) => {
	let window = all_wins.find(win => win.id == window_id);
	if (window) window.send('close-detached-project', uuid);
})
// [Popout] 面板/预览格弹出为独立窗口。数据同步的 MessagePort 由主进程在
// createPopoutWindow 内部直接推送给双方，不依赖这里的返回值，所以用 .on/send
// 而不是 handle/invoke。
ipcMain.on('popout-request', (event, {kind, targetId, width, height, x, y}) => {
	let owner_win = BrowserWindow.fromWebContents(event.sender);
	if (!owner_win) return;
	// 避免同一个面板/预览格重复弹出多个窗口：如果已存在则聚焦已有窗口
	let existing = [...popout_wins.values()].find(entry => (
		entry.kind == kind && entry.targetId == targetId && entry.ownerWinId == owner_win.id && !entry.win.isDestroyed()
	));
	if (existing) {
		existing.win.focus();
		return;
	}
	createPopoutWindow(owner_win, {kind, targetId, width, height, x, y});
})
ipcMain.on('request-color-picker', async (event, arg) => {
	const ColorPicker = await import('electron-color-picker');
	const color = await ColorPicker.getColorHexRGB().catch((error) => {
		console.warn('[Error] Failed to pick color', error)
		return ''
	})
	if (color) {
		// [Popout] 始终把取色结果回发给发起请求的窗口本身(event.sender)——
		// 弹出窗口在 popout_wins 里、不在 all_wins 里,原来只遍历 all_wins 的
		// 写法会让弹出窗口里取的色永远回不来。sync 模式下再额外广播给其它
		// 主窗口(多开工程共享主色)。
		event.sender.send('set-main-color', color);
		if (arg.sync) {
			all_wins.forEach(win => {
				if (win.isDestroyed() || win.webContents.id == event.sender.id) return;
				win.webContents.send('set-main-color', color)
			})
		}
	}
})
ipcMain.on('show-item-in-folder', async (event, path) => {
	shell.showItemInFolder(path);
})
ipcMain.on('open-in-default-app', async (event, path) => {
	shell.openPath(path);
})

app.on('ready', () => {

	const dev_mode = process.execPath && process.execPath.match(/node_modules[\\\/]electron/);

	if (dev_mode) {

		// Timeout to avoid race condition of Blockbench opening before esbuild finishes. Needs proper solution long-term
		setTimeout(() => {
			createWindow()
		}, 1000);

	} else {

		createWindow()
		
	}

	let app_was_loaded = false;
	ipcMain.on('app-loaded', () => {

		if (load_project_data) {
			all_wins[all_wins.length-1].send('load-tab', load_project_data);
			load_project_data = null;
		}

		if (app_was_loaded) {
			console.log('[Blockbench] App reloaded or new window opened')
			return;
		}

		app_was_loaded = true;
		if (dev_mode) {

			console.log('[Blockbench] App launched in development mode')
	
		} else {
	
			autoUpdater.autoInstallOnAppQuit = true;
			autoUpdater.autoDownload = false;
			if (LaunchSettings.get('update_to_prereleases') === true) {
				autoUpdater.allowPrerelease = true;
				//autoUpdater.channel = 'beta';
			}
	
			autoUpdater.on('update-available', (a) => {
				console.log('update-available', a)
				ipcMain.on('allow-auto-update', () => {
					autoUpdater.downloadUpdate()
				})
				if (!orig_win.isDestroyed()) orig_win.webContents.send('update-available', a);
			})
			autoUpdater.on('update-downloaded', (a) => {
				console.log('update-downloaded', a)
				if (!orig_win.isDestroyed()) orig_win.webContents.send('update-downloaded', a)
			})
			autoUpdater.on('error', (a) => {
				console.log('update-error', a)
				if (!orig_win.isDestroyed()) orig_win.webContents.send('update-error', a)
			})
			autoUpdater.on('download-progress', (a) => {
				console.log('update-progress', a)
				if (!orig_win.isDestroyed()) orig_win.webContents.send('update-progress', a)
			})
			autoUpdater.checkForUpdates().catch(err => {})
		}
	})
})

app.on('window-all-closed', () => {
	app.quit()
})
