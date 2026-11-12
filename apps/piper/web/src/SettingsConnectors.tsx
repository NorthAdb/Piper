// 设置页「连接器」组：统一槽位卡片列表。
// GitHub 可配置令牌（PAT 粘贴保存，读回只有末四位掩码，保存后扫描立即使用）；
// 网页查询可启用只读抓取并配置搜索端点（密钥读回只有掩码）；
// 日历 / 邮件是占位卡，点开能看到「尚未接入」与既定口径，不冒充已接好。
import { ChevronDownIcon, Loader2Icon, SaveIcon, ShieldCheckIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { checkGithubToken, getConnectors, saveGithubToken, saveWebSettings, UnauthorizedError } from "./api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Connector, GithubSelfCheck } from "./model";

const TOKEN_KIND_LABEL: Record<string, string> = {
	"fine-grained": "fine-grained PAT（仓库级授权）",
	classic: "classic PAT（scope 授权）",
	oauth: "OAuth 令牌",
	installation: "GitHub App 安装令牌",
	unknown: "种类未识别",
};

const STATUS_LABEL: Record<Connector["status"], string> = {
	connected: "已连接",
	unconfigured: "未配置",
	placeholder: "尚未接入",
};

const ACCESS_LABEL: Record<string, string> = {
	read: "只读",
	"read-approved-comment": "读 + 经收件箱批准的评论",
	"read-write-gated": "读写（写经网关）",
};

function GithubTokenForm({ connector, onChanged, onUnauthorized }: { connector: Connector; onChanged: () => void; onUnauthorized: () => void }) {
	const [token, setToken] = useState("");
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState("");
	const [checking, setChecking] = useState(false);
	const [check, setCheck] = useState<GithubSelfCheck | null>(null);

	const runCheck = async () => {
		setChecking(true);
		try {
			setCheck(await checkGithubToken());
		} catch (err) {
			if (err instanceof UnauthorizedError) onUnauthorized();
			else setCheck({ configured: true, login: null, tokenKind: null, repos: [], error: `自检请求失败：${err instanceof Error ? err.message : String(err)}` });
		} finally {
			setChecking(false);
		}
	};

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
			{connector.status === "connected" ? (
				<div className="flex flex-col gap-2">
					<div className="flex items-center gap-2">
						<Button type="button" size="sm" variant="outline" disabled={checking} onClick={() => void runCheck()}>
							{checking ? <Loader2Icon className="animate-spin" /> : <ShieldCheckIcon />}
							令牌自检
						</Button>
						<span className="text-xs text-muted-foreground">只读验证：令牌是谁的、每个绑定仓库够不够得着、能不能写评论。</span>
					</div>
					{check ? (
						check.error ? (
							<p className="rounded-lg border px-3 py-2 text-sm text-destructive">{check.error}</p>
						) : (
							<div className="flex flex-col gap-1.5 rounded-lg border px-3 py-2.5 text-sm">
								<p>
									身份：{check.login ?? "（未取到登录名）"}
									{check.tokenKind ? <span className="text-muted-foreground"> · {TOKEN_KIND_LABEL[check.tokenKind] ?? check.tokenKind}</span> : null}
								</p>
								{check.repos.length === 0 ? <p className="text-muted-foreground">当前没有绑定任何仓库的 bot，无可对账的仓库。</p> : null}
								{check.repos.map((r) => (
									<p key={r.repo} className="flex flex-wrap items-baseline gap-x-2">
										<span className="font-mono text-xs">{r.repo}</span>
										{r.reachable ? (
											<span className="text-muted-foreground">
												可访问 · 写权限：{r.canPush === true ? "可写（评论可发送）" : r.canPush === false ? "只读（批准后的评论会 403，请补 Pull requests 读写）" : "未知"}
											</span>
										) : (
											<span className="text-destructive">够不着（GitHub 回 {r.status ?? "网络错误"}）：令牌未授权这个仓库，或仓库不存在</span>
										)}
									</p>
								))}
								{check.tokenKind === "fine-grained" && check.repos.some((r) => !r.reachable || r.canPush === false) ? (
									<p className="text-xs text-muted-foreground">
										fine-grained PAT 的最小权限清单：Repository access 勾选出问题仓库；Contents 只读、Pull requests 读写、Actions 只读、Metadata 只读（自动）。改完在 GitHub 侧保存，再回这里覆盖令牌并重新自检。
									</p>
								) : null}
							</div>
						)
					) : null}
				</div>
			) : null}
		</div>
	);
}

function WebSettingsForm({ connector, onChanged, onUnauthorized }: { connector: Connector; onChanged: () => void; onUnauthorized: () => void }) {
	const [endpoint, setEndpoint] = useState(connector.searchEndpoint ?? "");
	const [searchKey, setSearchKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState("");

	useEffect(() => {
		setEndpoint(connector.searchEndpoint ?? "");
	}, [connector.searchEndpoint]);

	const run = async (patch: { fetchEnabled?: boolean; searchEndpoint?: string; searchApiKey?: string }, okText: string) => {
		setBusy(true);
		setNotice("");
		try {
			await saveWebSettings(patch);
			setSearchKey("");
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
		<div className="flex flex-col gap-3 border-t pt-3">
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-sm">网页抓取：{connector.fetchEnabled ? "已启用" : "未启用"}</span>
				<Button
					type="button"
					size="sm"
					variant={connector.fetchEnabled ? "ghost" : "default"}
					disabled={busy}
					onClick={() => run({ fetchEnabled: !connector.fetchEnabled }, connector.fetchEnabled ? "已关闭网页抓取。" : "已启用网页抓取，可用范围内的 bot 现在可以只读打开公开网页。")}
				>
					{busy ? <Loader2Icon className="animate-spin" /> : null}
					{connector.fetchEnabled ? "关闭" : "启用"}
				</Button>
			</div>
			<div className="flex flex-col gap-2">
				<Label htmlFor="web-search-endpoint">搜索端点（可选，填了还需密钥才启用搜索）</Label>
				<Input
					id="web-search-endpoint"
					type="url"
					autoComplete="off"
					className="max-w-md"
					placeholder="https://search.example.com/query"
					value={endpoint}
					onChange={(e) => setEndpoint(e.target.value)}
				/>
				<Label htmlFor="web-search-key">搜索密钥</Label>
				<div className="flex flex-wrap items-center gap-2">
					<Input
						id="web-search-key"
						type="password"
						autoComplete="off"
						className="max-w-sm"
						placeholder={connector.searchConfigured ? `已配置（${connector.searchKeyHint ?? ""}），粘贴新密钥可替换` : "粘贴搜索服务密钥"}
						value={searchKey}
						onChange={(e) => setSearchKey(e.target.value)}
					/>
					<Button type="button" size="sm" disabled={busy || (!endpoint && !searchKey)} onClick={() => run({ searchEndpoint: endpoint, ...(searchKey ? { searchApiKey: searchKey } : {}) }, "搜索设置已保存。")}>
						{busy ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
						保存搜索设置
					</Button>
					{connector.searchConfigured ? (
						<Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => run({ searchApiKey: "" }, "已清除搜索密钥，搜索停用。")}>
							<Trash2Icon />
							清除密钥
						</Button>
					) : null}
				</div>
				<p className="text-sm text-muted-foreground">搜索状态：{connector.searchConfigured ? "已配置，可按关键词搜索" : "未配置，暂不能搜索（不会用其他方式冒充搜索）"}</p>
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
				{connector.configurable && connector.id === "web" ? (
					<WebSettingsForm connector={connector} onChanged={onChanged} onUnauthorized={onUnauthorized} />
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
