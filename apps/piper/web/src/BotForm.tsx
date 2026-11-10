// Bot 新建 / 编辑表单（界面填卡入口）：字段与规格二的 Bot 卡一致，保存走 POST/PUT /api/bots。
import { useState } from "react";
import type { FormEvent } from "react";
import { createBot, deleteBot, updateBot } from "./api";
import type { BotInput } from "./api";
import type { Bot } from "./model";

export type BotFormProps = {
	initial: Bot | null; // null = 新建
	onClose: () => void;
	onSaved: (bot: Bot) => void;
	onDeleted: (id: string) => void;
};

function splitCsv(s: string): string[] {
	return s
		.split(",")
		.map((x) => x.trim())
		.filter(Boolean);
}

export function BotForm({ initial, onClose, onSaved, onDeleted }: BotFormProps) {
	const [name, setName] = useState(initial?.name ?? "");
	const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? "");
	const [tools, setTools] = useState((initial?.tools ?? []).join(", "));
	const [memoryScope, setMemoryScope] = useState(initial?.memoryScope ?? "self+about-me");
	const [repos, setRepos] = useState((initial?.repos ?? []).join(", "));
	const [err, setErr] = useState("");
	const [busy, setBusy] = useState(false);

	const onSave = async (e: FormEvent) => {
		e.preventDefault();
		const input: BotInput = {
			name,
			systemPrompt,
			tools: splitCsv(tools),
			memoryScope,
			repos: splitCsv(repos),
		};
		setBusy(true);
		setErr("");
		try {
			onSaved(initial ? await updateBot(initial.id, input) : await createBot(input));
		} catch (e2) {
			setErr(e2 instanceof Error ? e2.message : String(e2));
			setBusy(false);
		}
	};

	const onDelete = async () => {
		if (!initial || !window.confirm("确认删除这个 bot？")) return;
		setBusy(true);
		try {
			await deleteBot(initial.id);
			onDeleted(initial.id);
		} catch (e2) {
			setErr(e2 instanceof Error ? e2.message : String(e2));
			setBusy(false);
		}
	};

	return (
		<div className="modal">
			<form className="modal-box" onSubmit={onSave}>
				<h3>{initial ? `编辑「${initial.name}」` : "新建 Bot"}</h3>
				<label>名字</label>
				<input value={name} onChange={(e) => setName(e.target.value)} required />
				<label>职责描述（system prompt 主体）</label>
				<textarea rows={4} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
				<label>可用工具集（逗号分隔）</label>
				<input value={tools} onChange={(e) => setTools(e.target.value)} placeholder="github.read" />
				<label>记忆范围</label>
				<input value={memoryScope} onChange={(e) => setMemoryScope(e.target.value)} placeholder="self+about-me" />
				<label>绑定仓库（逗号分隔，owner/repo）</label>
				<input value={repos} onChange={(e) => setRepos(e.target.value)} placeholder="NorthAdb/LinkForge" />
				{err ? <p className="form-err">{err}</p> : null}
				<div className="modal-actions">
					{initial && !initial.isMain ? (
						<button type="button" className="danger" disabled={busy} onClick={onDelete}>
							删除
						</button>
					) : null}
					<span className="spacer" />
					<button type="button" onClick={onClose}>
						取消
					</button>
					<button type="submit" className="primary" disabled={busy}>
						保存
					</button>
				</div>
			</form>
		</div>
	);
}
