// 设置页「通知」组：应用内通知列表（文件持久化，新在前），可逐条或全部标记已读。
// 来源：例程（routine.completed / routine.failed）与待批写操作（approval.pending /
// approval.executed / approval.failed）。
import { BellRingIcon, CheckCheckIcon, CheckIcon, CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { getNotifications, markNotificationsRead, UnauthorizedError } from "./api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { NotificationEntry } from "./model";

const TYPE_META: Record<NotificationEntry["type"], { label: string; icon: typeof CircleCheckIcon }> = {
	"routine.completed": { label: "例程完成", icon: CircleCheckIcon },
	"routine.failed": { label: "例程失败", icon: CircleAlertIcon },
	"approval.pending": { label: "待批事项", icon: BellRingIcon },
	"approval.executed": { label: "写操作已执行", icon: CircleCheckIcon },
	"approval.failed": { label: "写操作失败", icon: CircleAlertIcon },
};

export function NotificationsSettings({
	onUnauthorized,
	onOpenFinding,
}: {
	onUnauthorized: () => void;
	onOpenFinding?: (findingId: string) => void;
}) {
	const [items, setItems] = useState<NotificationEntry[] | null>(null);
	const [unread, setUnread] = useState(0);
	const [loadError, setLoadError] = useState("");

	const apply = (r: { notifications: NotificationEntry[]; unread: number }) => {
		setItems(r.notifications);
		setUnread(r.unread);
	};

	useEffect(() => {
		getNotifications()
			.then(apply)
			.catch((e) => {
				if (e instanceof UnauthorizedError) onUnauthorized();
				else setLoadError(e instanceof Error ? e.message : String(e));
			});
	}, [onUnauthorized]);

	const mark = async (ids?: string[]) => {
		try {
			apply(await markNotificationsRead(ids));
		} catch (e) {
			if (e instanceof UnauthorizedError) onUnauthorized();
		}
	};

	if (loadError) return <p className="text-sm text-destructive">通知加载失败：{loadError}</p>;
	return (
		<Card>
			<CardHeader>
				<div className="flex items-center gap-2">
					<CardTitle className="text-base">通知</CardTitle>
					{unread ? <Badge>{unread} 条未读</Badge> : <Badge variant="outline">无未读</Badge>}
					{items?.length ? (
						<Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={() => void mark()} disabled={!unread}>
							<CheckCheckIcon />
							全部标记已读
						</Button>
					) : null}
				</div>
				<CardDescription>例程完成 / 失败、待批写操作的出现与执行结果会写到这里（文件持久化，重启不丢）。外部消息渠道尚未接入，接入后同一事件会同步推送出去。</CardDescription>
			</CardHeader>
			<CardContent>
				{items === null ? (
					<p className="text-sm text-muted-foreground">加载通知…</p>
				) : items.length === 0 ? (
					<p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
						暂无通知。跑一次晨间仓库扫描，这里会出现完成或失败记录。
					</p>
				) : (
					<div className="flex flex-col divide-y">
						{items.map((n) => {
							const meta = TYPE_META[n.type] ?? TYPE_META["routine.completed"];
							const Icon = meta.icon;
							return (
								<div key={n.id} className={`flex items-start gap-3 py-3 ${n.read ? "opacity-60" : ""}`}>
									<Icon className={`mt-0.5 size-4 shrink-0 ${n.type === "routine.failed" || n.type === "approval.failed" ? "text-destructive" : "text-emerald-400"}`} />
									<div className="min-w-0 flex-1">
										<div className="flex flex-wrap items-center gap-2">
											<span className="text-sm font-medium">{n.title}</span>
											<Badge variant="outline" className="text-[11px]">
												{meta.label}
											</Badge>
											<span className="text-xs text-muted-foreground">{new Date(n.createdAt).toLocaleString()}</span>
										</div>
										{n.body ? <p className="mt-0.5 text-sm text-muted-foreground">{n.body}</p> : null}
									</div>
									<div className="flex shrink-0 flex-col items-end gap-1">
										{(n.findingId ?? n.toolApprovalId) && onOpenFinding ? (
											<Button type="button" size="sm" variant="ghost" onClick={() => onOpenFinding((n.findingId ?? n.toolApprovalId) as string)}>
												查看事项
											</Button>
										) : null}
										{n.read ? null : (
											<Button type="button" size="sm" variant="ghost" onClick={() => void mark([n.id])}>
												<CheckIcon />
												标已读
											</Button>
										)}
									</div>
								</div>
							);
						})}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
