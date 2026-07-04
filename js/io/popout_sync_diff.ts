// [Popout] 增量 diff-patch 同步系统 (#7.3+7.6)。
//
// 根本解决闪烁 + undo 断裂:不再清空重建,而是按 UUID 匹配现有 elements/groups/
// textures/animations,只更新变化的属性(from/to/rotation/scale/name/faces 等),
// 新增的 init(),删除的 remove()。Outliner 结构稳定,3D 视口无闪烁。
//
// 分阶段实现:
// Phase 1 (MVP):变换编辑(transform-only)——只改 position/rotation/scale/from/to,
//               不改结构(不增删 element/group/texture/animation)。这覆盖最常见的
//               拖拽/旋转/缩放编辑,消除闪烁。结构变化仍回退到 replaceProjectContentInPlace。
// Phase 2:结构编辑(add/remove element/group/texture/animation) + outliner 重排。
// Phase 3:Undo.history 同步——把远端编辑包装成本地 UndoSystem entry,让主窗口 Ctrl+Z 有效。

import { Canvas } from '../preview/canvas';
// [Popout] Undo / settings / OutlinerNode 是运行期全局(见 js/undo.js、
// js/outliner/abstract/outliner_node.ts),跟 popout_sync.ts 里 Project/Codecs/
// ProjectData 一样直接用全局,不 import(import 会因非 ES 导出或循环依赖报错)。
// OutlinerNode.uuids[uuid] 是按 UUID 反查 element/group 实例的全局索引。
declare const Undo: any;
declare const settings: any;
declare const UndoSystem: any;
declare const OutlinerNode: any;
declare const UVEditor: any;

// ---- Phase 1: Transform-only diff ----

interface TransformDiff {
	elementChanges: Map<string, Partial<any>>  // uuid -> changed props
	groupChanges: Map<string, Partial<any>>
	// 结构变化标志:若检测到 add/remove,fallback 到全量同步
	structuralChange: boolean
}

/**
 * 计算当前工程与上次快照之间的变换差异(Phase 1:仅 transform,不处理结构变化)。
 * 若检测到结构变化(element/group/texture/animation 数量不同,或 UUID 集合不匹配),
 * 返回 structuralChange=true,调用方回退到全量 replaceProjectContentInPlace。
 */
export function computeTransformDiff(current_snapshot: any, last_snapshot: any | null): TransformDiff | null {
	if (!last_snapshot) return null;  // 首次同步,必须全量

	let diff: TransformDiff = {
		elementChanges: new Map(),
		groupChanges: new Map(),
		structuralChange: false
	};

	// 检查结构变化:element/group/texture/animation 数量
	let cur_elements = current_snapshot.elements || [];
	let last_elements = last_snapshot.elements || [];
	let cur_groups = current_snapshot.groups || [];
	let last_groups = last_snapshot.groups || [];
	let cur_textures = current_snapshot.textures || [];
	let last_textures = last_snapshot.textures || [];
	let cur_animations = current_snapshot.animations || [];
	let last_animations = last_snapshot.animations || [];

	if (cur_elements.length != last_elements.length ||
		cur_groups.length != last_groups.length ||
		cur_textures.length != last_textures.length ||
		cur_animations.length != last_animations.length) {
		diff.structuralChange = true;
		return diff;
	}

	// UUID 集合匹配检查(简化:只检查 elements,groups 足够判断结构变)
	let cur_el_uuids = new Set(cur_elements.map((e: any) => e.uuid));
	let last_el_uuids = new Set(last_elements.map((e: any) => e.uuid));
	if (cur_el_uuids.size != last_el_uuids.size ||
		![...cur_el_uuids].every(u => last_el_uuids.has(u))) {
		diff.structuralChange = true;
		return diff;
	}

	let cur_gr_uuids = new Set(cur_groups.map((g: any) => g.uuid));
	let last_gr_uuids = new Set(last_groups.map((g: any) => g.uuid));
	if (cur_gr_uuids.size != last_gr_uuids.size ||
		![...cur_gr_uuids].every(u => last_gr_uuids.has(u))) {
		diff.structuralChange = true;
		return diff;
	}

	// 结构未变,比较变换属性:from/to/rotation/origin/name
	let last_el_map = new Map(last_elements.map((e: any) => [e.uuid, e]));
	for (let cur_el of cur_elements) {
		let last_el = last_el_map.get(cur_el.uuid);
		if (!last_el) continue;  // 理论上不会发生(UUID 集合已匹配)
		let changed: any = {};
		let has_change = false;
		// 比较关键变换属性(数组/对象用 JSON 序列化简化比较;生产环境可优化)
		for (let prop of ['from', 'to', 'origin', 'rotation', 'inflate', 'name', 'visibility', 'locked']) {
			if (JSON.stringify(cur_el[prop]) !== JSON.stringify(last_el[prop])) {
				changed[prop] = cur_el[prop];
				has_change = true;
			}
		}
		// faces 变化(贴图/UV 编辑)也属"非结构"编辑,纳入变换 diff
		if ((cur_el as any).faces && (last_el as any).faces && JSON.stringify((cur_el as any).faces) !== JSON.stringify((last_el as any).faces)) {
			changed.faces = (cur_el as any).faces;
			has_change = true;
		}
		if (has_change) diff.elementChanges.set(cur_el.uuid, changed);
	}

	// groups:比较 name/origin/rotation
	let last_gr_map = new Map(last_groups.map((g: any) => [g.uuid, g]));
	for (let cur_gr of cur_groups) {
		let last_gr = last_gr_map.get(cur_gr.uuid);
		if (!last_gr) continue;
		let changed: any = {};
		let has_change = false;
		for (let prop of ['name', 'origin', 'rotation', 'visibility', 'locked']) {
			if (JSON.stringify(cur_gr[prop]) !== JSON.stringify(last_gr[prop])) {
				changed[prop] = cur_gr[prop];
				has_change = true;
			}
		}
		if (has_change) diff.groupChanges.set(cur_gr.uuid, changed);
	}

	return diff;
}

/**
 * 应用变换 diff:按 UUID 找到 Outliner.elements/Group.all 里已存在的实例,
 * 直接更新其属性(Object.assign),不清空不重建。Three.js 节点原地更新,无闪烁。
 *
 * [Popout] (#7.2) Undo 同步:应用远端 diff 前后记录状态变化,推入本地 Undo.history,
 * 让主窗口 Ctrl+Z 能撤销子窗口的编辑。只记录变化的 elements/groups,避免过大。
 */
export function applyTransformDiff(diff: TransformDiff, createUndoEntry: boolean = true) {
	if (diff.structuralChange) {
		throw new Error('[applyTransformDiff] structural change detected, should fallback to full sync');
	}

	// [Popout] (#7.2) Undo:收集变化的 elements/groups 到 aspects。
	// **关键**:UndoSystem.save.fromState() 期望 aspects.elements/groups 是**实例**
	// (会调 obj.uuid / obj.getUndoCopy / group.getChildlessCopy),不是 UUID 字符串。
	// 必须先按 UUID 反查出实例。
	let changed_element_instances = Array.from(diff.elementChanges.keys())
		.map(uuid => (OutlinerNode as any).uuids[uuid])
		.filter(Boolean);
	let changed_group_instances = Array.from(diff.groupChanges.keys())
		.map(uuid => (OutlinerNode as any).uuids[uuid])
		.filter(Boolean);
	let aspects: any = {};
	if (changed_element_instances.length > 0) aspects.elements = changed_element_instances;
	if (changed_group_instances.length > 0) aspects.groups = changed_group_instances;

	let before_save: any = null;
	if (createUndoEntry && (aspects.elements || aspects.groups)) {
		// 应用前快照(before)
		before_save = new UndoSystem.save(aspects);
	}

	// [Popout] (#15) 按变化的属性精确决定要刷新哪些 aspect,只更新变化的 element,
	// 不再无脑 updateAll*(那会遍历场景里所有 element,UV 高频编辑时明显卡顿)。
	//   from/to/origin/rotation/inflate -> transform + geometry
	//   faces                           -> faces + uv(UV 编辑改的就是 faces.uv)
	//   visibility                      -> visibility
	//   name/locked                     -> 无需 3D 刷新
	let el_aspects = {transform: false, geometry: false, faces: false, uv: false, visibility: false, painting_grid: false};
	let faces_changed = false;

	// elements:先原地写入属性,同时累积需要刷新的 aspect
	for (let [uuid, props] of diff.elementChanges) {
		let el = (OutlinerNode as any).uuids[uuid];
		if (!el) continue;  // 不应发生
		Object.assign(el, props);
		if ('from' in props || 'to' in props || 'origin' in props || 'rotation' in props || 'inflate' in props) {
			el_aspects.transform = true;
			el_aspects.geometry = true;
		}
		if ('faces' in props) {
			el_aspects.faces = true;
			el_aspects.uv = true;
			faces_changed = true;
		}
		if ('visibility' in props) {
			el_aspects.visibility = true;
		}
	}

	// groups:transform 变化用 adaptObjectPosition 原地更新其 mesh
	for (let [uuid, props] of diff.groupChanges) {
		let gr = (OutlinerNode as any).uuids[uuid];
		if (!gr) continue;
		Object.assign(gr, props);
		if (gr.mesh) {
			Canvas.adaptObjectPosition(gr.mesh, gr);
		}
	}

	// [Popout] (#15) 只对变化的 element 做定向 updateView,避免全场景刷新。
	if (changed_element_instances.length > 0 &&
		(el_aspects.transform || el_aspects.geometry || el_aspects.faces || el_aspects.uv || el_aspects.visibility)) {
		Canvas.updateView({
			elements: changed_element_instances,
			element_aspects: el_aspects,
		} as any);
	}
	if (changed_group_instances.length > 0) {
		Canvas.updateAllBones(changed_group_instances);
	}

	// [Popout] (#15) faces/UV 变化时刷新 UV 编辑器面板,否则弹出窗口的 UV 视图
	// 停在旧数据上("逻辑不顺畅")。仅当 UV 面板存在且已初始化时刷新。
	if (faces_changed && typeof UVEditor != 'undefined' && (UVEditor as any).vue) {
		(UVEditor as any).loadData();
	}

	// [Popout] (#7.2) Undo:应用后快照(post),推入 history
	if (createUndoEntry && before_save && (aspects.elements || aspects.groups)) {
		let post_save = new UndoSystem.save(aspects);
		let entry = {
			before: before_save,
			post: post_save,
			action: 'Remote Edit',  // 用户在 undo 列表里看到的名字
			type: 'edit',
			time: Date.now()
		};
		if (Undo.history.length > Undo.index) {
			Undo.history.length = Undo.index;
		}
		Undo.history.push(entry);
		if (Undo.history.length > (settings as any).undo_limit.value) {
			Undo.history.shift();
		}
		Undo.index = Undo.history.length;
	}
}
