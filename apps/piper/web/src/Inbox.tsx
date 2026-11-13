// 待批收件箱（P1-5 独立视图 + P1-6 网关执行）：「拍板」的主界面——列出带 writeIntent
// 的待批 Finding（类型 / 仓库 / 证据 / 建议 / 完整写参数 / 过期时间）。
// 批准后经薄网关执行写入（给指定 PR 或 Issue 发模板评论），结果当场可见：
// 成功给出评论链接；失败保持已批准状态、显示原因、可再次点批准重试。驳回不产生写操作。
// 失败可恢复切片（P1-7 试用复盘）：驳回改为两步确认（误点代价是 14 天去重冷却，
// 必须让用户在点下前看清后果）；下方加「已关闭」历史区（被驳回 / 被对账退役 /
// 已执行的事项带原因留痕，不再无声消失）；通知里的「查看事项」经 focusId 直达
// 本页对应条目并高亮（在已关闭区时自动展开该区）。
// 人的介入面（P2-4）：同一收件箱并列对话工具待批（kind:"tool_call"，bot 在
// 对话里经循环闸提出的写操作）——两类都能看全参数快照、批准、驳回、改
// 评论正文；工具待批的批准只触发对话里继续执行，结果回流到本页与对话。
import { ArrowLeftIcon, CheckIcon, ChevronDownIcon, ExternalLinkIcon, InboxIcon, PencilIcon, RotateCcwIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	approveApproval,
	approveToolApproval,
	createAdHocApproval,
	editApprovalBody,
	editToolApprovalBody,
	listApprovals,
	rejectApproval,
	rejectToolApproval,
	UnauthorizedError,
} from "./api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { Approval, Bot, InboxItem, ToolApprovalItem } from "./model";

const TYPE_LABEL: Record<string, string> = {
	ci_failed: "CI 失败",
	pr_needs_review: "PR 待审查",
	issue_untriaged: "Issue 待分诊",
};

// 写意图的评论目标（PR 或 Issue），批准回执与写操作框共用。
function intentTarget(a: Approval): string {
	return a.writeIntent.kind === "issue_comment" ? `Issue #${a.writeIntent.issueNumber}` : `PR #${a.writeIntent.prNumber}`;
}

const CLOSED_STATUS_LABEL: Record<string, string> = {
	executed: "已执行",
	rejected: "已驳回",
	expired: "已过期",
	cancelled: "已取消",
	failed: "执行失败",
};

// 工具待批（kind:"tool_call"）与 Finding 待批在同一列表里按 kind 分流渲染
const isToolItem = (a: InboxItem): a is ToolApprovalItem => a.kind === "tool_call";

function toolTitle(t: ToolApprovalItem): string {
	return `对话写操作：${t.toolName}`;
}

// 工具待批的评论目标（快照里的 repo + 编号），批准回执与写操作框共用
function toolTarget(t: ToolApprovalItem): string {
	const s = t.argsSnapshot;
	if (!s || typeof s.number !== "number") return "目标信息不完整";
	return `${s.repo ?? ""} 的 ${s.kind === "issue_comment" ? "Issue" : "PR"} #${s.number}`;
}

// 关闭原因（后端给的是审计 reason 原文）→ 给人看的说明。
function closeReasonText(a: Approval): string {
	const reason = a.closeReason;
	if (reason === "rejected_by_user")
		return a.type === "issue_untriaged"
			? "由你驳回关闭。14 天内同一 Issue 不会再开新事项。"
			: "由你驳回关闭。同一 PR 头部未变时 14 天内不会再开新事项，有新提交则可重开。";
	if (reason === "reconciled:pr_merged") return "PR 已合并，扫描对账时自动关闭。";
	if (reason === "reconciled:pr_closed") return "PR 已关闭，扫描对账时自动关闭。";
	if (reason === "reconciled:pr_draft") return "PR 已转为草稿，扫描对账时自动关闭。";
	if (reason === "reconciled:pr_approved") return "PR 已获得批准，扫描对账时自动关闭。";
	if (reason === "reconciled:ci_green") return "CI 已转绿，扫描对账时自动关闭。";
	if (reason === "reconciled:ci_superseded") return "已被更新的 CI 运行取代，扫描对账时自动关闭。";
	if (reason === "reconciled:issue_closed") return "Issue 已关闭，扫描对账时自动关闭。";
	if (reason === "reconciled:issue_triaged") return "Issue 已有人评论、打标签或认领，扫描对账时自动关闭。";
	if (reason) return `关闭原因：${reason}`;
	if (a.status === "expired") return "已超过有效期，自动关闭。";
	return "";
}

export function Inbox({
	bots,
	onBack,
	onUnauthorized,
	focusId = null,
}: {
	bots: Bot[];
	onBack: () => void;
	onUnauthorized: () => void;
	focusId?: string | null;
}) {
	const [items, setItems] = useState<InboxItem[] | null>(null);
	const [closed, setClosed] = useState<InboxItem[]>([]);
	const [closedOpen, setClosedOpen] = useState(false);
	const [confirmRejectId, setConfirmRejectId] = useState<string | null>(null);
	const [highlightId, setHighlightId] = useState<string | null>(null);
	// 正文编辑（切片二）：正在编辑的事项 id 与草稿文本
	const [editId, setEditId] = useState<string | null>(null);
	const [editText, setEditText] = useState("");
	// 即席开单（切片二）：仓库 + PR 号表单与本地定位目标（新建/既有事项开单后高亮）
	const boundRepos = [...new Set(bots.flatMap((b) => b.repos ?? []))];
	const [adHocRepo, setAdHocRepo] = useState("");
	const [adHocPr, setAdHocPr] = useState("");
	const [adHocBusy, setAdHocBusy] = useState(false);
	const [localFocusId, setLocalFocusId] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [err, setErr] = useState("");
	const [notice, setNotice] = useState("");
	const cardRefs = useRef(new Map<string, HTMLDivElement | null>());

	const load = useCallback(() => {
		listApprovals()
			.then(({ approvals, closed: closedItems }) => {
				setItems(approvals);
				setClosed(closedItems);
			})
			.catch((e) => {
				if (e instanceof UnauthorizedError) onUnauthorized();
				else setErr(e instanceof Error ? e.message : String(e));
			});
	}, [onUnauthorized]);

	useEffect(() => {
		load();
	}, [load]);

	// 定位高亮：通知直达（focusId）与即席开单结果（localFocusId）共用——命中待批项
	// 直接滚动高亮；命中已关闭项先展开历史区再定位。
	const focusTarget = focusId ?? localFocusId;
	useEffect(() => {
		if (!focusTarget || items === null) return;
		const inClosed = !items.some((a) => a.id === focusTarget) && closed.some((a) => a.id === focusTarget);
		if (inClosed) setClosedOpen(true);
		const t = setTimeout(() => {
			const el = cardRefs.current.get(focusTarget);
			if (el) {
				el.scrollIntoView({ block: "center", behavior: "smooth" });
				setHighlightId(focusTarget);
			}
		}, inClosed ? 80 : 0);
		return () => clearTimeout(t);
	}, [focusTarget, items, closed]);

	const act = async (a: InboxItem, action: "approve" | "reject") => {
		setBusyId(a.id);
		setErr("");
		setNotice("");
		try {
			if (isToolItem(a)) {
				// 工具待批：批准只触发对话里继续执行（接口不等待执行完），结果
				// 回流到对话工具卡与本页状态；驳回不产生任何写操作。
				if (action === "approve") {
					await approveToolApproval(a.id);
					setNotice(
						a.status === "approved"
							? `已再次触发「${toolTitle(a)}」的执行，完成后状态会更新到这里。`
							: `已批准「${toolTitle(a)}」，将在对话里继续执行，完成后状态会更新到这里。`,
					);
				} else {
					await rejectToolApproval(a.id);
					setConfirmRejectId(null);
					setNotice(
						a.status === "approved"
							? `已驳回「${toolTitle(a)}」，将不再重试这条写操作。该事项已移入下方「已关闭」区。`
							: `已驳回「${toolTitle(a)}」，不会执行任何写操作。该事项已移入下方「已关闭」区。`,
					);
				}
			} else if (action === "approve") {
				const { execution } = await approveApproval(a.id, a.intentHash);
				if (execution.ok) {
					setNotice(`已执行「${a.title}」，评论已发到 ${a.repo} 的 ${intentTarget(a)}${execution.commentUrl ? `：${execution.commentUrl}` : ""}`);
				} else {
					setNotice(`「${a.title}」已批准但执行未成功（${execution.reason ?? execution.result}），保持已批准状态，可再次点批准重试。`);
				}
			} else {
				await rejectApproval(a.id);
				setConfirmRejectId(null);
				setNotice(`已驳回「${a.title}」，不会执行任何写操作。该事项已移入下方「已关闭」区。`);
			}
			load();
		} catch (e) {
			if (e instanceof UnauthorizedError) onUnauthorized();
			else setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusyId(null);
		}
	};

	const saveEdit = async (a: InboxItem) => {
		setBusyId(a.id);
		setErr("");
		setNotice("");
		try {
			if (isToolItem(a)) {
				await editToolApprovalBody(a.id, editText);
				setEditId(null);
				setNotice(`已保存「${toolTitle(a)}」的新正文，批准时将按这份正文执行。`);
			} else {
				const wasApproved = a.status === "approved";
				await editApprovalBody(a.id, editText);
				setEditId(null);
				setNotice(
					wasApproved
						? `已保存「${a.title}」的新正文。原批准已作废，请按新正文重新批准。`
						: `已保存「${a.title}」的新正文，批准时将按这份正文冻结执行。`,
				);
			}
			load();
		} catch (e) {
			if (e instanceof UnauthorizedError) onUnauthorized();
			else setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusyId(null);
		}
	};

	const submitAdHoc = async () => {
		const repo = adHocRepo || boundRepos[0] || "";
		const prNumber = Number(adHocPr);
		if (!repo || !Number.isInteger(prNumber) || prNumber <= 0) {
			setErr("即席开单需要选择仓库并填写正整数 PR 号。");
			return;
		}
		setAdHocBusy(true);
		setErr("");
		setNotice("");
		try {
			const { approval, existing } = await createAdHocApproval(repo, prNumber);
			setNotice(existing ? `该 PR 已有事项「${approval.title}」，已为你定位。` : `已即席开单「${approval.title}」，可在下方改好正文再批准。`);
			setLocalFocusId(approval.id);
			load();
		} catch (e) {
			if (e instanceof UnauthorizedError) onUnauthorized();
			else setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setAdHocBusy(false);
		}
	};

	const botName = (id: string) => bots.find((b) => b.id === id)?.name ?? id;
	const cardRef = (id: string) => (el: HTMLDivElement | null) => {
		cardRefs.current.set(id, el);
	};

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
				{boundRepos.length > 0 ? (
					<div className="mb-5 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2.5">
						<span className="text-sm font-medium">即席开单</span>
						<span className="text-xs text-muted-foreground">不用等扫描：指定一个 PR，立即取证开一条待审事项（正文可改，批准后照样走网关）。</span>
						<div className="ml-auto flex items-center gap-2">
							<Select value={adHocRepo || boundRepos[0]} onValueChange={setAdHocRepo}>
								<SelectTrigger className="h-8 w-48">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{boundRepos.map((r) => (
										<SelectItem key={r} value={r}>
											{r}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<Input className="h-8 w-24" placeholder="PR 号" inputMode="numeric" value={adHocPr} onChange={(e) => setAdHocPr(e.target.value)} />
							<Button type="button" size="sm" disabled={adHocBusy} onClick={() => void submitAdHoc()}>
								开单
							</Button>
						</div>
					</div>
				) : null}
				{items === null ? (
					<p className="text-sm text-muted-foreground">加载待批项…</p>
				) : (
					<>
						{items.length === 0 ? (
							<div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-10 text-center">
								<InboxIcon className="size-6 text-muted-foreground" />
								<p className="text-sm text-muted-foreground">现在没有需要你批准的写操作。</p>
							</div>
						) : (
							<div className="flex flex-col gap-4">
								{items.map((a) =>
									isToolItem(a) ? (
										<ToolApprovalCard
											key={a.id}
											item={a}
											botName={botName(a.botId)}
											highlighted={highlightId === a.id}
											cardRef={cardRef(a.id)}
											busy={busyId === a.id}
											editing={editId === a.id}
											editText={editText}
											confirmingReject={confirmRejectId === a.id}
											onEditStart={() => {
												setEditId(a.id);
												setEditText(a.argsSnapshot?.body ?? "");
											}}
											onEditTextChange={setEditText}
											onEditSave={() => void saveEdit(a)}
											onEditCancel={() => setEditId(null)}
											onApprove={() => void act(a, "approve")}
											onAskReject={() => setConfirmRejectId(a.id)}
											onCancelReject={() => setConfirmRejectId(null)}
											onConfirmReject={() => void act(a, "reject")}
										/>
									) : (
										<Card
										key={a.id}
										ref={cardRef(a.id)}
										className={cn("gap-0 py-0 shadow-none", highlightId === a.id && "ring-2 ring-primary")}
									>
										<CardHeader className="flex flex-row items-center gap-2 px-4 py-3">
											<CardTitle className="min-w-0 flex-1 truncate text-sm">{a.title}</CardTitle>
											<Badge variant="outline">{TYPE_LABEL[a.type] ?? a.type}</Badge>
											<Badge variant={a.status === "approved" ? "default" : "secondary"}>
												{a.status === "approved" ? "已批准 · 待执行" : a.status === "executing" ? "执行中" : "待批准"}
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
											{a.detail ? (
												<div className="flex flex-col gap-2 rounded-lg border px-3 py-2.5 text-sm">
													<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
														{a.detail.headRef || a.detail.baseRef ? (
															<span>
																分支：{a.detail.headRef || "?"} → {a.detail.baseRef || "?"}
															</span>
														) : null}
														<span>
															改动：{a.detail.changedFiles} 个文件 · +{a.detail.additions} / −{a.detail.deletions} 行
														</span>
													</div>
													{a.detail.reviewers.length > 0 ? (
														<div className="flex flex-wrap items-center gap-1.5">
															<span className="text-xs text-muted-foreground">审查态势：</span>
															{a.detail.reviewers.map((r) => (
																<Badge key={r.login} variant={r.state === "CHANGES_REQUESTED" ? "destructive" : "outline"} className="text-[11px]">
																	{r.login}：{r.state === "CHANGES_REQUESTED" ? "要求修改" : r.stale ? "已批准（旧提交）" : "已批准"}
																</Badge>
															))}
														</div>
													) : (
														<p className="text-xs text-muted-foreground">审查态势：尚无人表态。</p>
													)}
													{a.detail.bodyExcerpt ? (
														<div>
															<p className="pb-1 text-xs font-medium tracking-wider text-muted-foreground uppercase">PR 描述（摘录）</p>
															<pre className="font-mono text-xs break-words whitespace-pre-wrap">{a.detail.bodyExcerpt}</pre>
														</div>
													) : null}
													{a.detail.files.length > 0 ? (
														<div>
															<p className="pb-1 text-xs font-medium tracking-wider text-muted-foreground uppercase">变更文件（前 {a.detail.files.length} 个）</p>
															<ul className="flex flex-col gap-0.5 font-mono text-xs">
																{a.detail.files.slice(0, 8).map((f) => (
																	<li key={f.filename} className="flex items-baseline justify-between gap-3">
																		<span className="min-w-0 truncate">{f.filename}</span>
																		<span className="shrink-0 text-muted-foreground">
																			+{f.additions} / −{f.deletions}
																		</span>
																	</li>
																))}
																{a.detail.files.length > 8 ? <li className="text-muted-foreground">…… 其余 {a.detail.files.length - 8} 个见 GitHub</li> : null}
															</ul>
														</div>
													) : null}
												</div>
											) : null}
											{a.issueDetail ? (
												<div className="flex flex-col gap-2 rounded-lg border px-3 py-2.5 text-sm">
													<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
														{a.issueDetail.authorLogin ? <span>作者：{a.issueDetail.authorLogin}</span> : null}
														<span>开单时评论数：{a.issueDetail.commentCount}</span>
														<span>标签：{a.issueDetail.labels.length > 0 ? a.issueDetail.labels.join("、") : "无"}</span>
														<span>认领人：{a.issueDetail.assignees.length > 0 ? a.issueDetail.assignees.join("、") : "无"}</span>
													</div>
													{a.issueDetail.bodyExcerpt ? (
														<div>
															<p className="pb-1 text-xs font-medium tracking-wider text-muted-foreground uppercase">Issue 正文（摘录）</p>
															<pre className="font-mono text-xs break-words whitespace-pre-wrap">{a.issueDetail.bodyExcerpt}</pre>
														</div>
													) : null}
												</div>
											) : null}
											<div className="rounded-lg border bg-card px-3 py-2.5">
												<div className="flex items-center pb-1.5">
													<p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">批准后将执行的写操作</p>
													{editId !== a.id ? (
														<Button
															type="button"
															size="sm"
															variant="ghost"
															className="ml-auto h-6 px-2 text-xs"
															disabled={busyId === a.id || a.status === "executing"}
															onClick={() => {
																setEditId(a.id);
																setEditText(a.writeIntent.body);
															}}
														>
															<PencilIcon />
															改正文
														</Button>
													) : null}
												</div>
												<p className="text-sm">
													在 {a.repo} 的 {intentTarget(a)} 下发表评论：
												</p>
												{editId === a.id ? (
													<div className="flex flex-col gap-2 pt-1.5">
														<Textarea value={editText} onChange={(e) => setEditText(e.target.value)} rows={5} className="font-mono text-xs" />
														{a.status === "approved" ? (
															<p className="text-xs text-amber-500">本事项已批准：保存新正文会作废这次批准，需要按新正文重新批准后才会执行。</p>
														) : (
															<p className="text-xs text-muted-foreground">批准时按这份正文冻结，网关只发批准的那一版。</p>
														)}
														<div className="flex gap-2">
															<Button type="button" size="sm" disabled={busyId === a.id || !editText.trim()} onClick={() => void saveEdit(a)}>
																保存正文
															</Button>
															<Button type="button" size="sm" variant="outline" disabled={busyId === a.id} onClick={() => setEditId(null)}>
																取消
															</Button>
														</div>
													</div>
												) : (
													<pre className="pt-1.5 font-mono text-xs break-words whitespace-pre-wrap">{a.writeIntent.body}</pre>
												)}
											</div>
											{a.status === "approved" && a.lastError ? (
												<p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
													上次执行未成功：{a.lastError}。问题解决后点「再次执行」重试，或驳回关闭本事项。
												</p>
											) : null}
											{confirmRejectId === a.id ? (
												<div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
													<p className="flex items-start gap-2 text-sm">
														<TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
														<span>
															{a.type === "issue_untriaged" ? (
																<>
																	驳回后本事项立即关闭：<strong>14 天内同一 Issue 不会再开新事项</strong>。只是暂时不想处理的话，不要驳回，留着即可。
																</>
															) : (
																<>
																	驳回后本事项立即关闭：同一 PR 头部未变时，<strong>14 天内不会再开新事项</strong>（PR 有新提交则可重开）。只是暂时不想处理的话，不要驳回，留着即可。
																</>
															)}
														</span>
													</p>
													<div className="flex gap-2">
														<Button type="button" size="sm" variant="destructive" disabled={busyId === a.id} onClick={() => void act(a, "reject")}>
															<XIcon />
															确认驳回
														</Button>
														<Button type="button" size="sm" variant="outline" disabled={busyId === a.id} onClick={() => setConfirmRejectId(null)}>
															取消
														</Button>
													</div>
												</div>
											) : (
												<div className="flex gap-2">
													<Button type="button" size="sm" disabled={busyId === a.id || a.status === "executing"} onClick={() => void act(a, "approve")}>
														{a.status === "approved" ? <RotateCcwIcon /> : <CheckIcon />}
														{a.status === "approved" ? "再次执行" : "批准并执行"}
													</Button>
													<Button type="button" size="sm" variant="outline" disabled={busyId === a.id || a.status === "executing"} onClick={() => setConfirmRejectId(a.id)}>
														<XIcon />
														驳回
													</Button>
												</div>
											)}
										</CardContent>
									</Card>
								))}
							</div>
						)}

						{closed.length > 0 ? (
							<div className="mt-8">
								<button
									type="button"
									className="flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
									onClick={() => setClosedOpen((v) => !v)}
									aria-expanded={closedOpen}
								>
									<ChevronDownIcon className={cn("size-4 transition-transform", closedOpen && "rotate-180")} />
									已关闭（{closed.length}）
									<span className="text-xs font-normal">被驳回、被扫描对账关闭或已执行的事项都在这里，带关闭原因。</span>
								</button>
								{closedOpen ? (
									<div className="mt-3 flex flex-col gap-3">
										{closed.map((a) =>
											isToolItem(a) ? (
												<Card
													key={a.id}
													ref={cardRef(a.id)}
													className={cn("gap-0 py-0 opacity-80 shadow-none", highlightId === a.id && "opacity-100 ring-2 ring-primary")}
												>
													<CardHeader className="flex flex-row items-center gap-2 px-4 py-3">
														<CardTitle className="min-w-0 flex-1 truncate text-sm">{toolTitle(a)}</CardTitle>
														<Badge variant="outline">对话工具</Badge>
														<Badge variant="secondary">{CLOSED_STATUS_LABEL[a.status] ?? a.status}</Badge>
													</CardHeader>
													<CardContent className="flex flex-col gap-1.5 px-4 pb-4 text-sm text-muted-foreground">
														<span className="text-xs">
															Bot：{botName(a.botId)} · 目标：{toolTarget(a)} · 关闭于 {new Date(a.updatedAt).toLocaleString()}
														</span>
														{a.status === "cancelled" ? <p>随对话 run 中止而取消，未执行。</p> : null}
														{a.error ? <p>原因：{a.error}</p> : null}
													</CardContent>
												</Card>
											) : (
												<Card
												key={a.id}
												ref={cardRef(a.id)}
												className={cn("gap-0 py-0 opacity-80 shadow-none", highlightId === a.id && "opacity-100 ring-2 ring-primary")}
											>
												<CardHeader className="flex flex-row items-center gap-2 px-4 py-3">
													<CardTitle className="min-w-0 flex-1 truncate text-sm">{a.title}</CardTitle>
													<Badge variant="outline">{TYPE_LABEL[a.type] ?? a.type}</Badge>
													<Badge variant="secondary">{CLOSED_STATUS_LABEL[a.status] ?? a.status}</Badge>
												</CardHeader>
												<CardContent className="flex flex-col gap-1.5 px-4 pb-4 text-sm text-muted-foreground">
													<span className="text-xs">
														Bot：{botName(a.botId)} · 仓库：{a.repo}
														{a.closedAt ? ` · 关闭于 ${new Date(a.closedAt).toLocaleString()}` : ""}
													</span>
													{closeReasonText(a) ? <p>{closeReasonText(a)}</p> : null}
													{a.status === "executed" && a.commentUrl ? (
														<a className="inline-flex items-center gap-1 underline underline-offset-2" href={a.commentUrl} target="_blank" rel="noreferrer">
															查看已发出的评论
															<ExternalLinkIcon className="size-3" />
														</a>
													) : null}
												</CardContent>
											</Card>
										))}
									</div>
								) : null}
							</div>
						) : null}
					</>
				)}
			</div>
		</div>
	);
}

// 对话工具待批卡（P2-4）：与 Finding 卡同一版式语言——标题 + 种类/状态徽章、
// 所属 bot 与目标、完整参数快照（写操作框）、批准 / 驳回。评论正文可在
// 待批准时改（仓库、种类、编号是锁定字段，界面上就不给改，服务端也会拒）。
// 批准只触发对话里继续执行，卡片随列表刷新变状态（执行完进「已关闭」区）。
function ToolApprovalCard({
	item: t,
	botName,
	highlighted,
	cardRef,
	busy,
	editing,
	editText,
	confirmingReject,
	onEditStart,
	onEditTextChange,
	onEditSave,
	onEditCancel,
	onApprove,
	onAskReject,
	onCancelReject,
	onConfirmReject,
}: {
	item: ToolApprovalItem;
	botName: string;
	highlighted: boolean;
	cardRef: (el: HTMLDivElement | null) => void;
	busy: boolean;
	editing: boolean;
	editText: string;
	confirmingReject: boolean;
	onEditStart: () => void;
	onEditTextChange: (v: string) => void;
	onEditSave: () => void;
	onEditCancel: () => void;
	onApprove: () => void;
	onAskReject: () => void;
	onCancelReject: () => void;
	onConfirmReject: () => void;
}) {
	const body = typeof t.argsSnapshot?.body === "string" ? t.argsSnapshot.body : null;
	return (
		<Card ref={cardRef} className={cn("gap-0 py-0 shadow-none", highlighted && "ring-2 ring-primary")}>
			<CardHeader className="flex flex-row items-center gap-2 px-4 py-3">
				<CardTitle className="min-w-0 flex-1 truncate text-sm">{toolTitle(t)}</CardTitle>
				<Badge variant="outline">对话工具</Badge>
				<Badge variant={t.status === "approved" ? "default" : "secondary"}>{t.status === "approved" ? "已批准 · 待执行" : "待批准"}</Badge>
			</CardHeader>
			<CardContent className="flex flex-col gap-3 px-4 pb-4">
				<div className="flex flex-col gap-1 text-xs text-muted-foreground">
					<span>
						Bot：{botName} · 工具：{t.toolName}
					</span>
					<span>提出时间：{new Date(t.createdAt).toLocaleString()}</span>
				</div>
				<div className="rounded-lg border bg-card px-3 py-2.5">
					<div className="flex items-center pb-1.5">
						<p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">批准后将执行的写操作</p>
						{body !== null && t.status === "pending" && !editing ? (
							<Button type="button" size="sm" variant="ghost" className="ml-auto h-6 px-2 text-xs" disabled={busy} onClick={onEditStart}>
								<PencilIcon />
								改正文
							</Button>
						) : null}
					</div>
					{body !== null ? (
						<>
							<p className="text-sm">在 {toolTarget(t)} 下发表评论：</p>
							{editing ? (
								<div className="flex flex-col gap-2 pt-1.5">
									<Textarea value={editText} onChange={(e) => onEditTextChange(e.target.value)} rows={5} className="font-mono text-xs" />
									<p className="text-xs text-muted-foreground">批准时按这份正文冻结，网关只发批准的那一版。仓库、种类与编号不可改。</p>
									<div className="flex gap-2">
										<Button type="button" size="sm" disabled={busy || !editText.trim()} onClick={onEditSave}>
											保存正文
										</Button>
										<Button type="button" size="sm" variant="outline" disabled={busy} onClick={onEditCancel}>
											取消
										</Button>
									</div>
								</div>
							) : (
								<pre className="pt-1.5 font-mono text-xs break-words whitespace-pre-wrap">{body}</pre>
							)}
						</>
					) : (
						<pre className="font-mono text-xs break-words whitespace-pre-wrap">{JSON.stringify(t.argsSnapshot, null, 2)}</pre>
					)}
				</div>
				{t.status === "approved" && t.error ? (
					<p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
						上次执行未成功：{t.error}。问题解决后点「再次执行」重试，或驳回关闭本事项。
					</p>
				) : null}
				{confirmingReject ? (
					<div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
						<p className="flex items-start gap-2 text-sm">
							<TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
							<span>
								{t.status === "approved"
									? "这条写操作已批准：若正在执行，驳回会被拒绝（已发出的写按真实结果落账）；若在等重试，驳回后不再重试。"
									: "驳回后这次工具调用不会执行，对话里会记为已拒绝。bot 之后仍可在对话中重新提出。"}
							</span>
						</p>
						<div className="flex gap-2">
							<Button type="button" size="sm" variant="destructive" disabled={busy} onClick={onConfirmReject}>
								<XIcon />
								确认驳回
							</Button>
							<Button type="button" size="sm" variant="outline" disabled={busy} onClick={onCancelReject}>
								取消
							</Button>
						</div>
					</div>
				) : (
					<div className="flex gap-2">
						<Button type="button" size="sm" disabled={busy} onClick={onApprove}>
							{t.status === "approved" ? <RotateCcwIcon /> : <CheckIcon />}
							{t.status === "approved" ? "再次执行" : "批准并执行"}
						</Button>
						<Button type="button" size="sm" variant="outline" disabled={busy} onClick={onAskReject}>
							<XIcon />
							驳回
						</Button>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
