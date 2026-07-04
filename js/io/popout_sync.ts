// [Popout] 跨窗口数据同步——原地替换 ModelProject 内容 / 轻量选中态同步。
//
// 移植自参考项目已验证的 Spike 结论(behemiron-blockbench-cross-window-sync)：
// 用 Codecs.project.load() 语义("从零构造")做跨窗口同步会导致 ModelProject.all
// 堆积和 Three.js 资源泄漏，改为"原地替换已存在 ModelProject 内容"，复用各类型
// 自身的 remove()(日常删除操作走的同一条路径，已处理好 dispose/Outliner摘除)。
//
// 范围说明(与参考项目一致，有意收窄)：已覆盖 elements/groups/outliner/textures/
// animations + 基础选中态。不处理 animation_controllers/collections/display/
// reference_images/export_options/history —— 弹出窗口场景下这些内容不需要
// 双向实时同步(用户在弹出窗口里通常只做单一面板/预览相关的操作)。
import { ModelProject } from './project';
import { Group } from '../outliner/types/group';
import { Outliner } from '../outliner/outliner';
import { Texture } from '../texturing/textures';
import { Animation } from '../animations/animation';
import { Canvas } from '../preview/canvas';
import { OutlinerElement } from '../outliner/abstract/outliner_element';
import { TickUpdates } from '../misc';

/**
 * 给刚 Codecs.project.load() 出来的工程强制恢复为快照里的稳定 uuid。
 * BB 的 load 走 setupProject() 会生成一个全新的随机 uuid，不会用 model 里的，
 * 必须 load 完立即改回来，否则后续按 uuid 匹配的原地同步永远命中不了。
 *
 * **关键**：ModelProject 构造时用当时的 uuid 在全局 ProjectData 字典里建条目
 * (model_3d: THREE.Object3D / nodes_3d: {})，而 Project.model_3d/nodes_3d 的
 * getter 是 `ProjectData[this.uuid].model_3d`。只改 Project.uuid 而不同步迁移
 * ProjectData 的 key，close()/unselect() 里 `scene.remove(this.model_3d)` 就会
 * 读到 undefined 抛错。这里把旧 key 整体改名到新 key，完整保留已绑定的 THREE 节点。
 */
function rebindProjectUuid(stable_uuid: string) {
	if (!stable_uuid || !Project || Project.uuid === stable_uuid) return;
	const old_uuid = Project.uuid;
	Project.uuid = stable_uuid;
	if (ProjectData && Object.prototype.hasOwnProperty.call(ProjectData, old_uuid)) {
		ProjectData[stable_uuid] = ProjectData[old_uuid];
		delete ProjectData[old_uuid];
	}
}

/**
 * 原地替换目标工程内容。target 由 model.uuid 匹配 ModelProject.all 中已存在的
 * 实例；若目标工程尚不存在(弹出窗口首次收到快照的场景)，回退到完整的
 * Codecs.project.load() 从零构造一份，并把 uuid 重绑定到快照的 uuid，
 * 之后的增量同步就能命中原地替换路径。
 */
export function replaceProjectContentInPlace(model: any): boolean {
	let target = ModelProject.all.find((p: any) => p.uuid === model.uuid);
	if (!target) {
		// [Popout] 首次同步：本窗口还没有这个工程 → 用标准 load 从零构造。
		// load 内部会新建 ModelProject 并 select()，随后把 uuid 对齐到快照，
		// 确保下次收到同一工程的快照能走下面的原地替换分支。
		Codecs.project.load(model, {path: '', no_file: true} as any);
		if (model.uuid) rebindProjectUuid(model.uuid);
		return true;
	}

	const previously_selected = Project;
	target.select();

	// ---- 1. 清空现有内容 ----
	Group.all.filter((g: any) => !(g.parent instanceof Group)).slice().forEach((g: any) => g.remove(false));
	Outliner.elements.filter((el: any) => !(el.parent instanceof Group)).slice().forEach((el: any) => el.remove(false));
	Texture.all.slice().forEach((tex: any) => tex.remove(true));
	Animation.all.slice().forEach((ani: any) => ani.remove(false, false));

	// ---- 2. 按 bbmodel.js parse() 的同等逻辑重新灌入 ----
	if (model.textures) {
		model.textures.forEach((tex: any) => {
			const tex_copy = new (Texture as any)(tex, tex.uuid).add(false);
			if (tex.source && tex.source.substr(0, 5) === 'data:') {
				tex_copy.fromDataURL(tex.source);
			}
		});
	}
	if (model.elements) {
		const default_texture = (Texture as any).getDefault();
		model.elements.forEach((template: any) => {
			const copy: any = (OutlinerElement as any).fromSave(template, true);
			for (const face in copy.faces) {
				if (!Project.format.single_texture && template.faces) {
					const texture = template.faces[face].texture !== null && Texture.all[template.faces[face].texture];
					if (texture) copy.faces[face].texture = texture.uuid;
				} else if (default_texture && copy.faces && copy.faces[face].texture !== null && !Project.format.single_texture_default) {
					copy.faces[face].texture = default_texture.uuid;
				}
			}
			copy.init();
		});
	}
	if (model.groups) {
		model.groups.forEach((template: any) => new (Group as any)(template, template.uuid).init());
	}
	if (model.outliner) {
		(Outliner as any).loadJSON(model.outliner);
	}
	if (model.animations) {
		model.animations.forEach((ani: any) => {
			const base_ani: any = new (Animation as any)();
			base_ani.uuid = ani.uuid;
			base_ani.extend(ani).add();
		});
	}

	(Canvas as any).updateAllBones();
	(Canvas as any).updateAllPositions();
	(Canvas as any).updateAllFaces();

	// ---- 3. 选中态(轻量版) ----
	if (model.editor_state) {
		const state = model.editor_state;
		Project.selected_elements = [];
		(state.selected_elements || []).forEach((uuid: string) => {
			const el = Outliner.elements.find((el2: any) => el2.uuid === uuid);
			if (el) Project.selected_elements.push(el);
		});
		if (state.selected_groups) {
			Group.multi_selected = state.selected_groups
				.map((uuid: string) => Group.all.find((g: any) => g.uuid === uuid))
				.filter((g: any) => g instanceof Group);
		}
		// 只改 Project.selected_elements/Group.multi_selected 这两个原始数据，
		// 交给下一次 animate() 里的 TickUpdates.Run() 触发 updateSelection()，
		// 跟 BB 自己"删除"/"复制"等操作改完选中态后的收尾方式一致。
		TickUpdates.selection = true;
	}

	// 恢复调用前的活动工程，避免"应用同步"意外切走用户当前正在看的标签。
	if (previously_selected && previously_selected !== target && ModelProject.all.includes(previously_selected)) {
		previously_selected.select();
	}

	return true;
}

/**
 * 轻量选中态同步：只改 Project.selected_elements / Group.multi_selected 引用 +
 * 触发 updateSelection() 收尾，不走 replaceProjectContentInPlace 的"清空重灌"。
 * 选中态变化(点大纲树节点/3D 视口点选)如果也走整份重灌，会有肉眼可见的闪烁
 * 和不必要的开销——双方工程结构没变时，原地对号入座就够了。
 */
export function applySelectionOnly(elementUuids: string[], groupUuids: string[]): boolean {
	if (!Project) return false;
	Project.selected_elements = Outliner.elements.filter((el: any) => elementUuids.includes(el.uuid));
	Group.multi_selected = Group.all.filter((g: any) => groupUuids.includes(g.uuid));
	TickUpdates.selection = true;
	return true;
}
