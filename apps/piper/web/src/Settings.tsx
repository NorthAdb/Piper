// 设置视图（L0-1 骨架起，四组均已真接入）：独立整页——模型 / 基础资料 / 连接器 / 通知。
// 左栏「通知」入口以 initialTab="notifications" 直达通知组。
import { ArrowLeftIcon, BellIcon, BlocksIcon, SlidersHorizontalIcon, UserRoundIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConnectorsSettings } from "./SettingsConnectors";
import { ModelSettingsForm } from "./SettingsModel";
import { NotificationsSettings } from "./SettingsNotifications";
import { ProfileSettingsForm } from "./SettingsProfile";

export function Settings({
	onBack,
	onModelSaved,
	onUnauthorized,
	initialTab = "model",
}: {
	onBack: () => void;
	onModelSaved: () => void;
	onUnauthorized: () => void;
	initialTab?: string;
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
				<Tabs defaultValue={initialTab}>
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
						<ProfileSettingsForm onUnauthorized={onUnauthorized} />
					</TabsContent>
					<TabsContent value="connectors">
						<ConnectorsSettings onUnauthorized={onUnauthorized} />
					</TabsContent>
					<TabsContent value="notifications">
						<NotificationsSettings onUnauthorized={onUnauthorized} />
					</TabsContent>
				</Tabs>
			</div>
		</div>
	);
}
