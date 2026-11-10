// 设置页「连接器」组（L0-4）：统一槽位卡片列表。
// GitHub 是唯一可配置项（PAT 粘贴保存，读回只有末四位掩码，保存后扫描立即使用）；
// 网页查询待 L0-6；日历 / 邮件是占位卡，点开能看到「尚未接入」与既定口径，不冒充已接好。
import { ChevronDownIcon, Loader2Icon, SaveIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { getConnectors, saveGithubToken, UnauthorizedError } from "./api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Connector } from "./model";

const STATUS_LABEL: Record<Connector["status"], string> = {
	connected: "已连接",
	unconfigured: "未配置",
	placeholder: "尚未接入",
};

const ACCESS_LABEL: Record<string, string> = {
	read: "只读",
	"read-write-gated": "读写（写经网关）",
};

function GithubTokenForm({ connector, onChanged, onUnauthorized }: { connector: Connector; onChanged: () => void; onUnauthorized: () => void }) {
	const [token, setToken] = useState("");
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState("");

	const save = async (value: string, okText: string) => {
		setBusy(true);
		setNotice("");
		try {
			await saveGithubToken(value);
			setToken("");
			setNotice(okText);
			onChanged();
		} catch (err) {
			if (err instanceof UnauthorizedError) onUnauthorized();
			else setNotice(`保存失败：${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-col gap-2 border-t pt-3">
			<Label htmlFor="github-token">GitHub 令牌（PAT）</Label>
			<div className="flex flex-wrap items-center gap-2">
				<Input
					id="github-token"
					type="password"
					autoComplete="off"
					className="max-w-sm"
					placeholder={connector.status === "connected" ? `已配置（${connector.tokenHint ?? ""}），粘贴新令牌可替换` : "粘贴 GitHub PAT"}
					value={token}
					onChange={(e) => setToken(e.target.value)}
				/>
				<Button type="button" size="sm" disabled={busy || !token} onClick={() => save(token, "已保存，扫描将使用该令牌。")}>
					{busy ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
					保存令牌
				</Button>
				{connector.status === "connected" ? (
					<Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => save("", "已清除令牌，回到公开只读。")}>
						<Trash2Icon />
						清除
					</Button>
				) : null}
			</div>
			{notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
		</div>
	);
}

function ConnectorCard({ connector, onChanged, onUnauthorized }: { connector: Connector; onChanged: () => void; onUnauthorized: () => void }) {
	const [open, setOpen] = useState(false);
	return (
		<Card>
			<CardHeader>
				<div className="flex items-center gap-2">
					<CardTitle className="text-base">{connector.name}</CardTitle>
					<Badge variant={connector.status === "connected" ? "default" : "outline"}>{STATUS_LABEL[connector.status]}</Badge>
					<Badge variant="secondary">{ACCESS_LABEL[connector.access] ?? connector.access}</Badge>
				</div>
				<CardDescription>{connector.purpose}</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				<button
					type="button"
					className="flex items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
					onClick={() => setOpen((v) => !v)}
					aria-expanded={open}
				>
					<ChevronDownIcon className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} />
					{open ? "收起说明" : "查看状态与口径"}
				</button>
				{open ? (
					<div className="flex flex-col gap-2 text-sm text-muted-foreground">
						<p>{connector.statusNote}</p>
						<p>可用范围：{connector.bots.length ? connector.bots.join("、") : "暂无 bot（接入后再分配）"}</p>
					</div>
				) : null}
				{connector.configurable && connector.id === "github" ? (
					<GithubTokenForm connector={connector} onChanged={onChanged} onUnauthorized={onUnauthorized} />
				) : null}
			</CardContent>
		</Card>
	);
}

export function ConnectorsSettings({ onUnauthorized }: { onUnauthorized: () => void }) {
	const [connectors, setConnectors] = useState<Connector[] | null>(null);
	const [loadError, setLoadError] = useState("");

	const reload = () => {
		getConnectors()
			.then(setConnectors)
			.catch((e) => {
				if (e instanceof UnauthorizedError) onUnauthorized();
				else setLoadError(e instanceof Error ? e.message : String(e));
			});
	};

	useEffect(reload, [onUnauthorized]);

	if (loadError) return <p className="text-sm text-destructive">连接器列表加载失败：{loadError}</p>;
	if (!connectors) return <p className="text-sm text-muted-foreground">加载连接器列表…</p>;
	return (
		<div className="flex flex-col gap-4">
			{connectors.map((c) => (
				<ConnectorCard key={c.id} connector={c} onChanged={reload} onUnauthorized={onUnauthorized} />
			))}
		</div>
	);
}
