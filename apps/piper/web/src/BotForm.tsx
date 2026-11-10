// Bot 新建 / 编辑表单（界面填卡入口）：字段与规格二的 Bot 卡一致，保存走 POST/PUT /api/bots。
// 视觉用 shadcn Dialog + Input/Textarea/Label，行为与上一版一致（含删除二次确认）。
import { useState } from "react";
import type { FormEvent } from "react";
import { createBot, deleteBot, updateBot } from "./api";
import type { BotInput } from "./api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="sm:max-w-lg">
				<form onSubmit={onSave} className="flex flex-col gap-4">
					<DialogHeader>
						<DialogTitle>{initial ? `编辑「${initial.name}」` : "新建 Bot"}</DialogTitle>
						<DialogDescription>字段与 Bot 卡规格一致，保存后立即生效。</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-4">
						<div className="flex flex-col gap-2">
							<Label htmlFor="bot-name">名字</Label>
							<Input id="bot-name" value={name} onChange={(e) => setName(e.target.value)} required />
						</div>
						<div className="flex flex-col gap-2">
							<Label htmlFor="bot-prompt">职责描述（system prompt 主体）</Label>
							<Textarea id="bot-prompt" rows={4} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
						</div>
						<div className="flex flex-col gap-2">
							<Label htmlFor="bot-tools">可用工具集（逗号分隔）</Label>
							<Input id="bot-tools" value={tools} onChange={(e) => setTools(e.target.value)} placeholder="github.read" />
						</div>
						<div className="flex flex-col gap-2">
							<Label htmlFor="bot-memory">记忆范围</Label>
							<Input id="bot-memory" value={memoryScope} onChange={(e) => setMemoryScope(e.target.value)} placeholder="self+about-me" />
						</div>
						<div className="flex flex-col gap-2">
							<Label htmlFor="bot-repos">绑定仓库（逗号分隔，owner/repo）</Label>
							<Input id="bot-repos" value={repos} onChange={(e) => setRepos(e.target.value)} placeholder="NorthAdb/LinkForge" />
						</div>
					</div>
					{err ? <p className="text-sm text-destructive">{err}</p> : null}
					<DialogFooter>
						{initial && !initial.isMain ? (
							<Button type="button" variant="destructive" className="sm:mr-auto" disabled={busy} onClick={onDelete}>
								删除
							</Button>
						) : null}
						<Button type="button" variant="outline" onClick={onClose}>
							取消
						</Button>
						<Button type="submit" disabled={busy}>
							保存
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
