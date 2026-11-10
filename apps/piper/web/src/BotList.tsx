// 左栏业务组件：bot 列表（主 bot 置顶为后端返回顺序，本组件保持该顺序）、状态点（闲/忙）、
// 新建入口与全局待批收件箱入口。借鉴 assistant-ui ThreadList 的「列表 + 当前项高亮」组织方式，业务自研。
import { useEffect, useState } from "react";
import { listApprovals } from "./api";
import type { Bot } from "./model";

export type BotListProps = {
	bots: Bot[];
	currentBotId: string | null;
	busyBotIds: ReadonlySet<string>;
	onSelect: (id: string) => void;
	onNew: () => void;
	onEdit: (bot: Bot) => void;
};

export function BotList({ bots, currentBotId, busyBotIds, onSelect, onNew, onEdit }: BotListProps) {
	const [approvals, setApprovals] = useState<unknown[]>([]);
	const [inboxOpen, setInboxOpen] = useState(false);

	useEffect(() => {
		listApprovals()
			.then(setApprovals)
			.catch(() => setApprovals([]));
	}, []);

	return (
		<div className="botlist">
			<h3 className="botlist-title">Bots</h3>
			<div className="botlist-items">
				{bots.map((b) => (
					<div
						key={b.id}
						className={`bot-item${b.id === currentBotId ? " active" : ""}`}
						onClick={() => onSelect(b.id)}
						onDoubleClick={() => onEdit(b)}
					>
						<span className={`dot${busyBotIds.has(b.id) ? " busy" : ""}`} title={busyBotIds.has(b.id) ? "干活中" : "空闲"} />
						<span className="bot-name">
							{b.isMain ? "📌 " : ""}
							{b.name}
						</span>
						{b.repos.length ? <span className="muted bot-repos">{b.repos.length} 仓</span> : null}
						<button
							type="button"
							className="bot-edit"
							title="编辑"
							onClick={(e) => {
								e.stopPropagation();
								onEdit(b);
							}}
						>
							编辑
						</button>
					</div>
				))}
			</div>
			<button type="button" className="wide-btn" onClick={onNew}>
				＋ 新建 Bot
			</button>
			<div className="botlist-foot">
				<button type="button" className="wide-btn" onClick={() => setInboxOpen((v) => !v)}>
					待批收件箱{approvals.length ? ` (${approvals.length})` : ""}
				</button>
				{inboxOpen ? (
					<div className="inbox-panel muted">
						{approvals.length
							? `${approvals.length} 条待批请求（雏形占位）。`
							: "暂无待批请求。权限网关在后续迭代接入，写操作请求会汇集到这里。"}
					</div>
				) : null}
			</div>
		</div>
	);
}
