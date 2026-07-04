import { Blockbench } from "./api";
import { updateStreamerModeNotification } from "./interface/setup_settings";
import { loadThemes } from "./interface/themes";
import { translateUI } from "./languages";
import { loadInstalledPlugins } from "./plugin_loader";
import { animate } from "./preview/preview";
import { ipcRenderer, SystemInfo } from "./native_apis";
import { initializeDesktopApp, loadOpenWithBlockbenchFile } from "./desktop";
import { AutoBackup } from "./auto_backup";
import { initReferenceImages } from "./preview/reference_images";
import { initPopoutMode } from "./interface/popout";
import { registerPanelStateSync } from "./io/popout_sync_hub";

Interface.page_wrapper = document.getElementById('page_wrapper');
Interface.work_screen = document.getElementById('work_screen');
Interface.center_screen = document.getElementById('center');
Interface.right_bar = document.getElementById('right_bar');
Interface.left_bar = document.getElementById('left_bar');
Interface.preview = document.getElementById('preview');

CustomTheme.setup();

StateMemory.init('dialog_paths', 'object')

initCanvas()
animate()

Blockbench.browser = 'electron'
if (isApp === false) {
	if (navigator.userAgent.toLowerCase().indexOf('firefox') > -1) {
		Blockbench.browser = 'firefox'
	} else if (!!window.chrome && !!window.chrome.webstore) {
		Blockbench.browser = 'chrome'
	} else if ((!!window.opr && !!opr.addons) || !!window.opera || navigator.userAgent.indexOf(' OPR/') >= 0) {
		Blockbench.browser = 'opera'
	} else if (/constructor/i.test(window.HTMLElement) || (function (p) { return p.toString() === "[object SafariRemoteNotification]"; })(!window['safari'] || (typeof safari !== 'undefined' && safari.pushNotification))) {
		Blockbench.browser = 'safari'
	} else if (!!document.documentMode) {
		Blockbench.browser = 'internet_explorer'
	} else if (!!window.chrome && window.navigator.userAgent.toLowerCase().includes('edg')) {
		Blockbench.browser = 'edge'
	} else if (!!window.StyleMedia) {
		Blockbench.browser = 'proprietary_edge'
	} else if (!!window.chrome && !window.chrome.webstore) {
		Blockbench.browser = 'chromium'
	}
	if (navigator.appVersion.indexOf("Win") != -1) 	 Blockbench.operating_system = 'Windows';
	if (navigator.appVersion.indexOf("Mac") != -1) 	 Blockbench.operating_system = 'MacOS';
	if (navigator.appVersion.indexOf("Linux") != -1) Blockbench.operating_system = 'Linux';
	if (['proprietary_edge', 'internet_explorer'].includes(Blockbench.browser)) {
		alert(capitalizeFirstLetter(Blockbench.browser)+' does not support Blockbench')
	}
	$('.local_only').remove()
} else {
	$('.web_only').remove()
}
BARS.setupActions()
BARS.setupToolbars()
BARS.setupVue()
MenuBar.setup()
translateUI()
loadThemes()
initReferenceImages()

console.log(`Three.js r${THREE.REVISION}`)
console.log('%cBlockbench ' + Blockbench.version + (isApp
	? (' Desktop (' + Blockbench.operating_system + ', ' + SystemInfo.arch +')')
	: (' Web ('+capitalizeFirstLetter(Blockbench.browser) + (Blockbench.isPWA ? ', PWA)' : ')'))),
	'border: 2px solid #3e90ff; padding: 4px 8px; font-size: 1.2em;'
)
Blockbench.startup_count = parseInt(localStorage.getItem('startups')||0) + 1;
localStorage.setItem('startups', Blockbench.startup_count);

document.getElementById('blackout').addEventListener('click', event => {
	if (typeof open_interface.cancel == 'function' && open_interface.cancel_on_click_outside !== false) {
		open_interface.cancel(event);
	} else if (typeof open_interface == 'string' && open_dialog) {
		$('dialog#'+open_dialog).find('.cancel_btn:not([disabled])').trigger('click');
	}
})

if (isApp) {
	updateRecentProjects()
}

if (!isApp) {
	async function registerSW() {
		if ('serviceWorker' in navigator) {
			try {
				await navigator.serviceWorker.register('./service_worker.js');
			} catch (err) {
				console.log(err)
			}
		}
	}
	registerSW();
}

if (!Blockbench.isWeb || !Blockbench.isPWA) {
	$.ajaxSetup({ cache: false });
}

if (Blockbench.startup_count == 1) {
	try {
		jQuery.ajax({
			url: 'https://blckbn.ch/api/event/new_installation',
			type: 'POST',
			data: {}
		})
	} catch (err) {
		console.error(err);
	}
}
if (Blockbench.startup_count == 3) {
	try {
		jQuery.ajax({
			url: 'https://blckbn.ch/api/event/recurring_user',
			type: 'POST',
			data: {}
		})
	} catch (err) {
		console.error(err);
	}
}

Blockbench.on('before_closing', (event) => {
	if (!Blockbench.hasFlag('no_localstorage_saving')) {
		Settings.saveLocalStorages()
	}
})

updateProjectResolution()

setupInterface()
setupDragHandlers()

onVueSetup.funcs.forEach((func) => {
	if (typeof func === 'function') {
		func()
	}
})

if (settings.streamer_mode.value) {
	updateStreamerModeNotification();
}

AutoBackup.initialize();

if (isApp) {
	initializeDesktopApp();
} else {
	initializeWebApp();
}

localStorage.setItem('last_version', Blockbench.version);

(function() {
	// Promise.any workaround
	let proceeded = false;
	function proceed() {
		if (proceeded) return;

		Settings.saveLocalStorages();
		if (isApp) {
			loadOpenWithBlockbenchFile();
			ipcRenderer.send('app-loaded');
		} else {
			loadInfoFromURL();
		}
		proceeded = true;
	}
	// [Popout] loadInstalledPlugins() 内部把返回的 Promise 存到了
	// Plugins.install_promise，供 popout.ts 在弹出窗口里"目标面板由插件注册但
	// 尚未就位"时复用等待(不能重新调用 loadInstalledPlugins()，它不是幂等的，
	// 会重复执行一遍插件安装/加载副作用)。这里额外等它 resolve 后补扫一次
	// registerPanelStateSync()，把迟到的插件面板的跨窗口同步订阅补上。
	let install_promise = loadInstalledPlugins();
	install_promise.then(() => registerPanelStateSync());
	install_promise.then(proceed);
	setTimeout(proceed, 1200);
})()

setStartScreen(true);

if (Blockbench.isMobile) {
	// Reselect tool to update transform toolbar in status bar on mobile
	Toolbox.selected = null;
	BarItems.move_tool.select();
}

document.getElementById('page_wrapper').classList.remove('invisible');

// [Popout] 在完整启动流程跑完后做一次性的SoloMode检测与视觉裁剪，
// 或(非popout窗口下)注册收回监听
initPopoutMode();

Blockbench.setup_successful = true;
