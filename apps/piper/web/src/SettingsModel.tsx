// 设置页「模型」组真表单：参照 Pi 的 provider 选择——先选服务商（目录预置
// baseUrl 与模型名），再用该服务商的 API Key 接入；只实现 API Key 方式，
// 不做账号 / OAuth 登录。自定义端点保留为兜底。
// 目录只是预置便利，不是白名单：baseUrl 与模型名都能改填任意值。非 custom
// 服务商下改动了预置 baseUrl，保存时按「自定义端点」归属（provider 存 custom），
// 让读回的归属与实际端点一致。保存即热生效（后端设置文件优先于环境变量）；
// Key 只在输入框出现，读回只有末四位掩码。输入框留空保存 = 不修改 Key；
// 「清除 Key」单独发送空串清除。
import { CheckCircle2Icon, Loader2Icon, PlugZapIcon, SaveIcon, Trash2Icon, XCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { getModelProviders, getModelSettings, saveModelSettings, testModelSettings, UnauthorizedError } from "./api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ModelProvider, ModelSettings } from "./model";

type TestState = { kind: "idle" } | { kind: "testing" } | { kind: "ok" } | { kind: "fail"; error: string };

const CUSTOM_OPTION = "__custom__";
const FALLBACK_PROVIDERS: ModelProvider[] = [{ id: "custom", name: "自定义端点", baseUrl: "", models: [] }];

const normalizeUrl = (u: string) => u.trim().replace(/\/+$/, "");

export function ModelSettingsForm({ onSaved, onUnauthorized }: { onSaved: () => void; onUnauthorized: () => void }) {
	const [view, setView] = useState<ModelSettings | null>(null);
	const [providers, setProviders] = useState<ModelProvider[]>(FALLBACK_PROVIDERS);
	const [provider, setProvider] = useState("custom");
	const [baseUrl, setBaseUrl] = useState("");
	const [modelId, setModelId] = useState("");
	const [modelCustom, setModelCustom] = useState(true);
	const [apiKey, setApiKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState("");
	const [test, setTest] = useState<TestState>({ kind: "idle" });

	const applyView = (v: ModelSettings, catalog: ModelProvider[]) => {
		setView(v);
		setProvider(v.provider);
		setBaseUrl(v.baseUrl);
		setModelId(v.modelId);
		setApiKey("");
		const entry = catalog.find((p) => p.id === v.provider);
		setModelCustom(!(entry && entry.models.includes(v.modelId)));
		onSaved();
	};

	useEffect(() => {
		Promise.all([
			getModelProviders()
				.then((r) => r.providers)
				.catch((e) => {
					if (e instanceof UnauthorizedError) throw e;
					return FALLBACK_PROVIDERS;
				}),
			getModelSettings(),
		])
			.then(([catalog, v]) => {
				setProviders(catalog.length ? catalog : FALLBACK_PROVIDERS);
				applyView(v, catalog.length ? catalog : FALLBACK_PROVIDERS);
			})
			.catch((e) => {
				if (e instanceof UnauthorizedError) onUnauthorized();
			});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onUnauthorized]);

	const currentProvider = providers.find((p) => p.id === provider) ?? FALLBACK_PROVIDERS[0];
	const diverged = provider !== "custom" && normalizeUrl(baseUrl) !== normalizeUrl(currentProvider.baseUrl);
	const effectiveProvider = diverged ? "custom" : provider;

	const onProviderChange = (id: string) => {
		setProvider(id);
		const entry = providers.find((p) => p.id === id);
		if (entry && id !== "custom") {
			setBaseUrl(entry.baseUrl);
			if (entry.models.length) {
				setModelId(entry.models[0]);
				setModelCustom(false);
			}
		} else {
			setModelCustom(true);
		}
	};

	const onModelSelect = (value: string) => {
		if (value === CUSTOM_OPTION) {
			setModelCustom(true);
		} else {
			setModelCustom(false);
			setModelId(value);
		}
	};

	const onSave = async (e: FormEvent) => {
		e.preventDefault();
		setBusy(true);
		setNotice("");
		try {
			const v = await saveModelSettings({
				provider: effectiveProvider,
				baseUrl: baseUrl.trim(),
				modelId: modelId.trim(),
				...(apiKey ? { apiKey } : {}),
			});
			applyView(v, providers);
			setNotice("已保存，立即生效。");
		} catch (err) {
			if (err instanceof UnauthorizedError) onUnauthorized();
			else setNotice(`保存失败：${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setBusy(false);
		}
	};

	const onClearKey = async () => {
		setBusy(true);
		setNotice("");
		try {
			const v = await saveModelSettings({ apiKey: "" });
			applyView(v, providers);
			setNotice("已清除 Key，回到未配置状态。");
		} catch (err) {
			if (err instanceof UnauthorizedError) onUnauthorized();
			else setNotice(`清除失败：${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setBusy(false);
		}
	};

	const onTest = async () => {
		setTest({ kind: "testing" });
		try {
			const r = await testModelSettings({
				baseUrl: baseUrl.trim() || undefined,
				modelId: modelId.trim() || undefined,
				...(apiKey ? { apiKey } : {}),
			});
			setTest(r.ok ? { kind: "ok" } : { kind: "fail", error: r.error || "连接失败" });
		} catch (err) {
			if (err instanceof UnauthorizedError) onUnauthorized();
			setTest({ kind: "fail", error: err instanceof Error ? err.message : String(err) });
		}
	};

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center gap-2">
					<CardTitle className="text-base">模型</CardTitle>
					{view ? (
						<Badge variant={view.configured ? "default" : "outline"}>{view.configured ? "已配置" : "未配置"}</Badge>
					) : null}
				</div>
				<CardDescription>
					先选服务商，再填该服务商的 API Key 接入（只支持 API Key，不做账号登录）。保存后立即生效、不必重启；Key
					只存本地设置文件，读回只显示末四位。
				</CardDescription>
			</CardHeader>
			<CardContent>
				<form onSubmit={onSave} className="flex flex-col gap-4">
					<div className="flex flex-col gap-2">
						<Label htmlFor="model-provider">服务商（provider）</Label>
						<Select value={provider} onValueChange={onProviderChange}>
							<SelectTrigger id="model-provider" className="w-full">
								<SelectValue placeholder="选择服务商" />
							</SelectTrigger>
							<SelectContent>
								{providers.map((p) => (
									<SelectItem key={p.id} value={p.id}>
										{p.name}
										{view && view.provider === p.id && view.configured ? "（已配置）" : ""}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="model-base-url">端点 URL（baseUrl）</Label>
						<Input
							id="model-base-url"
							placeholder={currentProvider.baseUrl || "https://api.openai.com/v1"}
							value={baseUrl}
							onChange={(e) => setBaseUrl(e.target.value)}
						/>
						{diverged ? (
							<p className="text-xs text-muted-foreground">端点已改动，与所选服务商的预置地址不同，保存后按自定义端点处理。</p>
						) : null}
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="model-id">模型名（modelId）</Label>
						{currentProvider.models.length ? (
							<>
								<Select value={modelCustom ? CUSTOM_OPTION : modelId} onValueChange={onModelSelect}>
									<SelectTrigger id="model-id-select" className="w-full">
										<SelectValue placeholder="选择模型" />
									</SelectTrigger>
									<SelectContent>
										{currentProvider.models.map((m) => (
											<SelectItem key={m} value={m}>
												{m}
											</SelectItem>
										))}
										<SelectItem value={CUSTOM_OPTION}>自定义模型名…</SelectItem>
									</SelectContent>
								</Select>
								{modelCustom ? (
									<Input
										id="model-id"
										placeholder="输入任意模型名"
										value={modelId}
										onChange={(e) => setModelId(e.target.value)}
									/>
								) : null}
							</>
						) : (
							<Input
								id="model-id"
								placeholder="输入任意模型名"
								value={modelId}
								onChange={(e) => setModelId(e.target.value)}
							/>
						)}
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="model-api-key">API Key</Label>
						<Input
							id="model-api-key"
							type="password"
							autoComplete="off"
							placeholder={view?.configured ? `已配置（${view.apiKeyHint}），留空表示不修改` : "粘贴 API Key"}
							value={apiKey}
							onChange={(e) => setApiKey(e.target.value)}
						/>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Button type="submit" disabled={busy}>
							{busy ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
							保存
						</Button>
						<Button type="button" variant="outline" onClick={onTest} disabled={test.kind === "testing"}>
							{test.kind === "testing" ? <Loader2Icon className="animate-spin" /> : <PlugZapIcon />}
							测试连接
						</Button>
						{view?.configured ? (
							<Button type="button" variant="ghost" onClick={onClearKey} disabled={busy}>
								<Trash2Icon />
								清除 Key
							</Button>
						) : null}
						{test.kind === "ok" ? (
							<span className="flex items-center gap-1 text-sm text-emerald-400">
								<CheckCircle2Icon className="size-4" />
								连接可用
							</span>
						) : null}
						{test.kind === "fail" ? (
							<span className="flex items-center gap-1 text-sm text-destructive">
								<XCircleIcon className="size-4" />
								连接失败：{test.error}
							</span>
						) : null}
					</div>
					{notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
				</form>
			</CardContent>
		</Card>
	);
}
