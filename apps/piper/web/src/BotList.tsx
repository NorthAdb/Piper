// 左栏业务组件：品牌区 + bot 列表（主 bot 置顶为后端返回顺序，本组件保持该顺序）、
// 状态点（闲/忙）、新建与编辑入口、全局待批收件箱入口（P1-5 起为独立整页视图）。
// 视觉走设计系统（sidebar 令牌）。
import { BellIcon, BotIcon, InboxIcon, PencilIcon, PinIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { getNotifications, listApprovals } from "./api";
import type { Approval } from "./model";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { Bot } from "./model";

export type BotListProps = {
	bots: Bot[];
	currentBotId: string | null;
	busyBotIds: ReadonlySet<string>;
	onSelect: (id: string) => void;
	onNew: () => void;
	onEdit: (bot: Bot) => void;
	onOpenInbox: () => void;
	onOpenSettings: () => void;
	onOpenNotifications: () => void;
};

export function BotList({ bots, currentBotId, busyBotIds, onSelect, onNew, onEdit, onOpenInbox, onOpenSettings, onOpenNotifications }: BotListProps) {
	const [approvals, setApprovals] = useState<Approval[]>([]);
	const [notifUnread, setNotifUnread] = useState(0);

	useEffect(() => {
		listApprovals()
			.then(({ approvals: pending }) => setApprovals(pending))
			.catch(() => setApprovals([]));
		getNotifications()
			.then((r) => setNotifUnread(r.unread))
			.catch(() => setNotifUnread(0));
	}, []);

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
				<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
					<BotIcon className="size-4.5" />
				</span>
				<div className="min-w-0 flex-1 leading-tight">
					<div className="truncate text-sm font-semibold tracking-tight">Piper</div>
					<div className="truncate text-xs text-muted-foreground">Personal Agent 控制台</div>
				</div>
				<Button type="button" size="icon-sm" variant="ghost" title="新建 Bot" onClick={onNew}>
					<PlusIcon />
					<span className="sr-only">新建 Bot</span>
				</Button>
			</div>

			<div className="flex items-center justify-between px-4 pt-1 pb-2">
				<span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">Bots</span>
				<span className="text-[11px] text-muted-foreground tabular-nums">{bots.length}</span>
			</div>

			<ScrollArea className="min-h-0 flex-1 px-2">
				<div className="flex flex-col gap-0.5 pb-2">
					{bots.map((b) => {
						const busy = busyBotIds.has(b.id);
						const active = b.id === currentBotId;
						return (
							<div
								key={b.id}
								className={cn(
									"group flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors duration-150",
									active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60",
								)}
								onClick={() => onSelect(b.id)}
								onDoubleClick={() => onEdit(b)}
							>
								<span
									className={cn(
										"flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
										b.isMain ? "bg-primary/15 text-primary" : "bg-secondary text-secondary-foreground",
									)}
								>
									{(b.name.trim()[0] ?? "?").toUpperCase()}
								</span>
								<span className="min-w-0 flex-1 leading-tight">
									<span className="flex items-center gap-1 truncate font-medium">
										<span className="truncate">{b.name}</span>
										{b.isMain ? <PinIcon className="size-3 shrink-0 text-primary" /> : null}
									</span>
									<span className="block truncate text-xs text-muted-foreground">
										{b.isMain ? "主 bot" : b.repos.length ? `绑定 ${b.repos.length} 个仓库` : "未绑定仓库"}
									</span>
								</span>
								<span className="relative flex size-8 shrink-0 items-center justify-center">
									<span
										className={cn(
											"size-2 rounded-full transition-opacity duration-150 group-hover:opacity-0",
											busy ? "animate-pulse bg-amber-400" : "bg-muted-foreground/40",
										)}
										title={busy ? "干活中" : "空闲"}
									/>
									<Button
										type="button"
										size="icon-sm"
										variant="ghost"
										title="编辑"
										className="absolute inset-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100"
										onClick={(e) => {
											e.stopPropagation();
											onEdit(b);
										}}
									>
										<PencilIcon />
										<span className="sr-only">编辑</span>
									</Button>
								</span>
							</div>
						);
					})}
				</div>
			</ScrollArea>

			<div className="px-3 pt-1 pb-2">
				<Button type="button" variant="outline" className="w-full border-dashed text-muted-foreground hover:text-foreground" onClick={onNew}>
					<PlusIcon />
					新建 Bot
				</Button>
			</div>

			<Separator />
			<div className="flex flex-col gap-0.5 p-3">
				<Button type="button" variant="ghost" className="w-full justify-start px-2.5" onClick={onOpenInbox}>
					<InboxIcon />
					待批收件箱
					{approvals.length ? (
						<Badge className="ml-auto h-5 min-w-5 px-1.5 text-[11px]" variant="secondary">
							{approvals.length}
						</Badge>
					) : null}
				</Button>
				<Button type="button" variant="ghost" className="w-full justify-start px-2.5" onClick={onOpenNotifications}>
					<BellIcon />
					通知
					{notifUnread ? (
						<Badge className="ml-auto h-5 min-w-5 px-1.5 text-[11px]" variant="secondary">
							{notifUnread}
						</Badge>
					) : null}
				</Button>
				<Button type="button" variant="ghost" className="w-full justify-start px-2.5" onClick={onOpenSettings}>
					<SettingsIcon />
					设置
				</Button>
			</div>
		</div>
	);
}
