// 设置页「模型」组真表单（L0-2）：OpenAI 兼容端点、模型名、API Key。
// 保存即热生效（后端设置文件优先于环境变量）；Key 只在输入框出现，读回只有末四位掩码。
// 输入框留空保存 = 不修改 Key；「清除 Key」单独发送空串清除。
import { CheckCircle2Icon, Loader2Icon, PlugZapIcon, SaveIcon, Trash2Icon, XCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { getModelSettings, saveModelSettings, testModelSettings, UnauthorizedError } from "./api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ModelSettings } from "./model";

type TestState = { kind: "idle" } | { kind: "testing" } | { kind: "ok" } | { kind: "fail"; error: string };

export function ModelSettingsForm({ onSaved, onUnauthorized }: { onSaved: () => void; onUnauthorized: () => void }) {
	const [view, setView] = useState<ModelSettings | null>(null);
	const [baseUrl, setBaseUrl] = useState("");
	const [modelId, setModelId] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState("");
	const [test, setTest] = useState<TestState>({ kind: "idle" });

	useEffect(() => {
		getModelSettings()
			.then((v) => {
				setView(v);
				setBaseUrl(v.baseUrl);
				setModelId(v.modelId);
			})
			.catch((e) => {
				if (e instanceof UnauthorizedError) onUnauthorized();
			});
	}, [onUnauthorized]);

	const applyView = (v: ModelSettings) => {
		setView(v);
		setBaseUrl(v.baseUrl);
		setModelId(v.modelId);
		setApiKey("");
		onSaved();
	};

	const onSave = async (e: FormEvent) => {
		e.preventDefault();
		setBusy(true);
		setNotice("");
		try {
			const v = await saveModelSettings({
				baseUrl: baseUrl.trim(),
				modelId: modelId.trim(),
				...(apiKey ? { apiKey } : {}),
			});
			applyView(v);
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
			applyView(v);
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
					只接一个 OpenAI 兼容端点。保存后立即生效、不必重启；Key 只存本地设置文件，读回只显示末四位。
				</CardDescription>
			</CardHeader>
			<CardContent>
				<form onSubmit={onSave} className="flex flex-col gap-4">
					<div className="flex flex-col gap-2">
						<Label htmlFor="model-base-url">端点 URL（baseUrl）</Label>
						<Input
							id="model-base-url"
							placeholder="https://api.openai.com/v1"
							value={baseUrl}
							onChange={(e) => setBaseUrl(e.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="model-id">模型名（modelId）</Label>
						<Input id="model-id" placeholder="gpt-4o-mini" value={modelId} onChange={(e) => setModelId(e.target.value)} />
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
