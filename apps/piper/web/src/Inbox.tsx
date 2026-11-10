// 待批收件箱（P1-5）：独立整页视图，是「拍板」的主界面——列出带 writeIntent 的待批
// Finding（类型 / 仓库 / 证据 / 建议 / 完整写参数 / 过期时间），批准 / 驳回写回状态。
// P1-5 阶段批准只记录决定（状态 approved），不执行任何对外写操作；批准后经网关执行
// 写入是 P1-6 的接入点，卡面文案如实标注，不声称已发送。
import { ArrowLeftIcon, CheckIcon, ExternalLinkIcon, InboxIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { approveApproval, listApprovals, rejectApproval, UnauthorizedError } from "./api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Approval, Bot } from "./model";

const TYPE_LABEL: Record<string, string> = {
	ci_failed: "CI 失败",
	pr_needs_review: "PR 待审查",
};

export function Inbox({
	bots,
	onBack,
	onUnauthorized,
}: {
	bots: Bot[];
	onBack: () => void;
	onUnauthorized: () => void;
}) {
	const [items, setItems] = useState<Approval[] | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [err, setErr] = useState("");
	const [notice, setNotice] = useState("");

	const load = useCallback(() => {
		listApprovals()
			.then(setItems)
			.catch((e) => {
				if (e instanceof UnauthorizedError) onUnauthorized();
				else setErr(e instanceof Error ? e.message : String(e));
			});
	}, [onUnauthorized]);

	useEffect(() => {
		load();
	}, [load]);

	const act = async (a: Approval, action: "approve" | "reject") => {
		setBusyId(a.id);
		setErr("");
		setNotice("");
		try {
			if (action === "approve") {
				await approveApproval(a.id);
				setNotice(`已批准「${a.title}」。写入会经网关执行（网关接入后生效），当前尚未向 GitHub 发送任何内容。`);
			} else {
				await rejectApproval(a.id);
				setNotice(`已驳回「${a.title}」，不会执行任何写操作。`);
			}
			load();
		} catch (e) {
			if (e instanceof UnauthorizedError) onUnauthorized();
			else setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusyId(null);
		}
	};

	const botName = (id: string) => bots.find((b) => b.id === id)?.name ?? id;

	return (
		<div className="flex h-dvh flex-col bg-background">
			<header className="flex h-13 shrink-0 items-center gap-3 border-b px-5">
				<Button type="button" variant="ghost" size="sm" onClick={onBack}>
					<ArrowLeftIcon />
					返回
				</Button>
				<span className="text-sm font-semibold">待批收件箱</span>
				<span className="hidden text-xs text-muted-foreground sm:block">需要你拍板的写操作都在这里，批准后经网关执行。</span>
				{items ? (
					<Badge variant="outline" className="ml-auto">
						{items.length} 条待处理
					</Badge>
				) : null}
			</header>

			<div className="mx-auto w-full max-w-3xl min-h-0 flex-1 overflow-y-auto px-5 py-6">
				{err ? <p className="mb-4 text-sm text-destructive">{err}</p> : null}
				{notice ? <p className="mb-4 rounded-lg border px-3 py-2 text-sm text-muted-foreground">{notice}</p> : null}
				{items === null ? (
					<p className="text-sm text-muted-foreground">加载待批项…</p>
				) : items.length === 0 ? (
					<div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-10 text-center">
						<InboxIcon className="size-6 text-muted-foreground" />
						<p className="text-sm text-muted-foreground">现在没有需要你批准的写操作。</p>
					</div>
				) : (
					<div className="flex flex-col gap-4">
						{items.map((a) => (
							<Card key={a.id} className="gap-0 py-0 shadow-none">
								<CardHeader className="flex flex-row items-center gap-2 px-4 py-3">
									<CardTitle className="min-w-0 flex-1 truncate text-sm">{a.title}</CardTitle>
									<Badge variant="outline">{TYPE_LABEL[a.type] ?? a.type}</Badge>
									<Badge variant={a.status === "approved" ? "default" : "secondary"}>
										{a.status === "approved" ? "已批准 · 待执行" : "待批准"}
									</Badge>
								</CardHeader>
								<CardContent className="flex flex-col gap-3 px-4 pb-4">
									<div className="flex flex-col gap-1 text-xs text-muted-foreground">
										<span>
											Bot：{botName(a.botId)} · 仓库：{a.repo}
										</span>
										<span>
											证据：
											<a className="inline-flex items-center gap-1 underline underline-offset-2" href={a.evidenceUrl} target="_blank" rel="noreferrer">
												{a.evidenceUrl}
												<ExternalLinkIcon className="size-3" />
											</a>
										</span>
										{a.expiresAt ? <span>过期时间：{new Date(a.expiresAt).toLocaleString()}</span> : null}
									</div>
									{a.summary ? <p className="text-sm">{a.summary}</p> : null}
									{a.suggestedAction ? <p className="text-sm text-muted-foreground">建议：{a.suggestedAction}</p> : null}
									<div className="rounded-lg border bg-card px-3 py-2.5">
										<p className="pb-1.5 text-xs font-medium tracking-wider text-muted-foreground uppercase">批准后将执行的写操作</p>
										<p className="text-sm">
											在 {a.repo} 的 PR #{a.writeIntent.prNumber} 下发表评论：
										</p>
										<pre className="pt-1.5 font-mono text-xs break-words whitespace-pre-wrap">{a.writeIntent.body}</pre>
									</div>
									<div className="flex gap-2">
										<Button type="button" size="sm" disabled={busyId === a.id || a.status === "approved"} onClick={() => void act(a, "approve")}>
											<CheckIcon />
											{a.status === "approved" ? "已批准" : "批准"}
										</Button>
										<Button type="button" size="sm" variant="outline" disabled={busyId === a.id} onClick={() => void act(a, "reject")}>
											<XIcon />
											驳回
										</Button>
									</div>
								</CardContent>
							</Card>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
