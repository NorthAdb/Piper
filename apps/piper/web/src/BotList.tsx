// 左栏业务组件：品牌区 + bot 列表（主 bot 置顶为后端返回顺序，本组件保持该顺序）、
// 状态点（闲/忙）、新建与编辑入口、全局待批收件箱入口。视觉走设计系统（sidebar 令牌）。
import { BellIcon, BotIcon, InboxIcon, PencilIcon, PinIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { getNotifications, listApprovals } from "./api";
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
	onOpenSettings: () => void;
	onOpenNotifications: () => void;
};

export function BotList({ bots, currentBotId, busyBotIds, onSelect, onNew, onEdit, onOpenSettings, onOpenNotifications }: BotListProps) {
	const [approvals, setApprovals] = useState<unknown[]>([]);
	const [inboxOpen, setInboxOpen] = useState(false);
	const [notifUnread, setNotifUnread] = useState(0);

	useEffect(() => {
		listApprovals()
			.then(setApprovals)
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
				<span className="text-xs font-medium tracking-wider text-muted-foreground uppercase">Bots</span>
				<Badge variant="outline" className="text-[11px]">
					{bots.length}
				</Badge>
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
									"group flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
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
								<span
									className={cn("size-2 shrink-0 rounded-full", busy ? "animate-pulse bg-amber-400" : "bg-muted-foreground/40")}
									title={busy ? "干活中" : "空闲"}
								/>
								<Button
									type="button"
									size="icon-sm"
									variant="ghost"
									title="编辑"
									className={cn("shrink-0", active ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-100")}
									onClick={(e) => {
										e.stopPropagation();
										onEdit(b);
									}}
								>
									<PencilIcon />
									<span className="sr-only">编辑</span>
								</Button>
							</div>
						);
					})}
				</div>
			</ScrollArea>

			<div className="px-3 pt-1 pb-2">
				<Button type="button" variant="outline" className="w-full" onClick={onNew}>
					<PlusIcon />
					新建 Bot
				</Button>
			</div>

			<Separator />
			<div className="p-3">
				<Button type="button" variant="ghost" className="w-full justify-start" onClick={() => setInboxOpen((v) => !v)}>
					<InboxIcon />
					待批收件箱
					{approvals.length ? (
						<Badge className="ml-auto" variant="secondary">
							{approvals.length}
						</Badge>
					) : null}
				</Button>
				{inboxOpen ? (
					<div className="mt-2 rounded-lg border bg-card px-3 py-2.5 text-sm text-muted-foreground">
						{approvals.length
							? `${approvals.length} 条待批请求（雏形占位）。`
							: "暂无待批请求。权限网关在后续迭代接入，写操作请求会汇集到这里。"}
					</div>
				) : null}
				<Button type="button" variant="ghost" className="mt-1 w-full justify-start" onClick={onOpenNotifications}>
					<BellIcon />
					通知
					{notifUnread ? (
						<Badge className="ml-auto" variant="secondary">
							{notifUnread}
						</Badge>
					) : null}
				</Button>
				<Button type="button" variant="ghost" className="mt-1 w-full justify-start" onClick={onOpenSettings}>
					<SettingsIcon />
					设置
				</Button>
			</div>
		</div>
	);
}
