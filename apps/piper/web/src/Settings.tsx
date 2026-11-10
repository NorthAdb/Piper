// 设置视图（L0-1 骨架 + L0-2 模型组真接入）：独立整页，四组——模型 / 基础资料 / 连接器 / 通知。
// 模型组已是真表单（SettingsModel.tsx，保存热生效）；其余三组仍为占位空状态，后续切片接入。
import { ArrowLeftIcon, BellIcon, BlocksIcon, SlidersHorizontalIcon, UserRoundIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ModelSettingsForm } from "./SettingsModel";

function PendingGroup({ title, description, note }: { title: string; description: string; note: string }) {
	return (
		<Card>
			<CardHeader>
				<div className="flex items-center gap-2">
					<CardTitle className="text-base">{title}</CardTitle>
					<Badge variant="outline">尚未配置</Badge>
				</div>
				<CardDescription>{description}</CardDescription>
			</CardHeader>
			<CardContent>
				<p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">{note}</p>
			</CardContent>
		</Card>
	);
}

export function Settings({
	onBack,
	onModelSaved,
	onUnauthorized,
}: {
	onBack: () => void;
	onModelSaved: () => void;
	onUnauthorized: () => void;
}) {
	return (
		<div className="flex h-dvh flex-col bg-background">
			<header className="flex h-13 shrink-0 items-center gap-3 border-b px-5">
				<Button type="button" variant="ghost" size="sm" onClick={onBack}>
					<ArrowLeftIcon />
					返回
				</Button>
				<span className="text-sm font-semibold">设置</span>
				<span className="hidden text-xs text-muted-foreground sm:block">模型、基础资料、连接器与通知在这里统一管理。</span>
			</header>

			<div className="mx-auto w-full max-w-3xl min-h-0 flex-1 overflow-y-auto px-5 py-6">
				<Tabs defaultValue="model">
					<TabsList className="mb-4">
						<TabsTrigger value="model">
							<SlidersHorizontalIcon />
							模型
						</TabsTrigger>
						<TabsTrigger value="profile">
							<UserRoundIcon />
							基础资料
						</TabsTrigger>
						<TabsTrigger value="connectors">
							<BlocksIcon />
							连接器
						</TabsTrigger>
						<TabsTrigger value="notifications">
							<BellIcon />
							通知
						</TabsTrigger>
					</TabsList>

					<TabsContent value="model">
						<ModelSettingsForm onSaved={onModelSaved} onUnauthorized={onUnauthorized} />
					</TabsContent>
					<TabsContent value="profile">
						<PendingGroup
							title="基础资料"
							description="称呼、时区与账号级「关于我」（about-me.md）。"
							note="编辑入口即将在后续切片接入；右栏记忆页签目前只读展示同一份「关于我」。"
						/>
					</TabsContent>
					<TabsContent value="connectors">
						<PendingGroup
							title="连接器"
							description="GitHub、网页查询、日历、邮件的统一槽位与状态。"
							note="连接器列表即将在后续切片接入；日历、邮件先以占位卡出现，真连接排在分诊闭环之后。"
						/>
					</TabsContent>
					<TabsContent value="notifications">
						<PendingGroup
							title="通知"
							description="例程完成 / 失败、待批事项等应用内通知。"
							note="通知列表即将在后续切片接入，外部消息渠道不在本批范围。"
						/>
					</TabsContent>
				</Tabs>
			</div>
		</div>
	);
}
