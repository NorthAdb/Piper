// 设置页「基础资料」组真表单（L0-3）：称呼、时区、账号级「关于我」。
// 「关于我」只有一份 about-me.md：本表单、右栏记忆页签、GET /api/about-me、对话注入读的都是它。
// 超过后端上限（20000 字符）保存会被拒绝并显示原因，原文件不会被写坏。
import { Loader2Icon, SaveIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { getAboutMe, getProfileSettings, saveAboutMe, saveProfileSettings, UnauthorizedError } from "./api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const FALLBACK_TIMEZONES = ["Asia/Hong_Kong", "Asia/Shanghai", "Asia/Tokyo", "Asia/Singapore", "UTC", "Europe/London", "America/New_York"];

// 时区下拉给全量 IANA 列表（R3）：避免用户手打错别字把非法时区存进设置、进而让
// 调度在启动时崩溃。仍保留手动输入（填了优先），但提交前先在前端校验一次。
const ALL_TIMEZONES: string[] = (() => {
	try {
		return Intl.supportedValuesOf("timeZone");
	} catch {
		return FALLBACK_TIMEZONES;
	}
})();

function isValidTimezone(value: string): boolean {
	try {
		new Intl.DateTimeFormat(undefined, { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

export function ProfileSettingsForm({ onUnauthorized }: { onUnauthorized: () => void }) {
	const [displayName, setDisplayName] = useState("");
	const [timezone, setTimezone] = useState("Asia/Hong_Kong");
	const [customTimezone, setCustomTimezone] = useState("");
	const [aboutMe, setAboutMe] = useState("");
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState("");

	useEffect(() => {
		Promise.all([getProfileSettings(), getAboutMe()])
			.then(([profile, markdown]) => {
				setDisplayName(profile.displayName);
				if (ALL_TIMEZONES.includes(profile.timezone)) {
					setTimezone(profile.timezone);
					setCustomTimezone("");
				} else {
					// 不在下拉列表里的存量值（含手改文件写坏的值）放进手动输入框，
					// 让用户看得见、改得掉，而不是被悄悄替换。
					setTimezone("Asia/Hong_Kong");
					setCustomTimezone(profile.timezone);
				}
				setAboutMe(markdown);
			})
			.catch((e) => {
				if (e instanceof UnauthorizedError) onUnauthorized();
			});
	}, [onUnauthorized]);

	const onSave = async (e: FormEvent) => {
		e.preventDefault();
		const effectiveTimezone = customTimezone.trim() || timezone;
		if (!isValidTimezone(effectiveTimezone)) {
			setNotice(`保存失败：时区「${effectiveTimezone}」不是合法的 IANA 时区名，请从下拉中选择或检查拼写。未保存任何内容。`);
			return;
		}
		setBusy(true);
		setNotice("");
		try {
			await saveProfileSettings({ displayName: displayName.trim(), timezone: effectiveTimezone });
			const saved = await saveAboutMe(aboutMe);
			setAboutMe(saved);
			setNotice("已保存。新的「关于我」会注入下一轮对话。");
		} catch (err) {
			if (err instanceof UnauthorizedError) onUnauthorized();
			else setNotice(`保存失败：${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">基础资料</CardTitle>
				<CardDescription>
					称呼与时区（定时调度以后取这里的时区，缺省 Asia/Hong_Kong）；「关于我」是账号级单份文件，全 bot 可读，保存后注入下一轮对话。
				</CardDescription>
			</CardHeader>
			<CardContent>
				<form onSubmit={onSave} className="flex flex-col gap-4">
					<div className="flex flex-col gap-2">
						<Label htmlFor="profile-name">称呼</Label>
						<Input id="profile-name" placeholder="bot 应该怎么称呼你" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="profile-timezone">时区</Label>
						<Select value={timezone} onValueChange={setTimezone}>
							<SelectTrigger id="profile-timezone" className="w-full">
								<SelectValue placeholder="选择时区" />
							</SelectTrigger>
							<SelectContent>
								{ALL_TIMEZONES.map((tz) => (
									<SelectItem key={tz} value={tz}>
										{tz}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Input
							id="profile-timezone-custom"
							placeholder="或手动输入 IANA 时区（如 Asia/Hong_Kong），填了优先于下拉"
							value={customTimezone}
							onChange={(e) => setCustomTimezone(e.target.value)}
						/>
						<p className="text-xs text-muted-foreground">手动输入的时区会在提交前校验，非法时区不会被保存。</p>
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="profile-about-me">关于我（about-me.md）</Label>
						<Textarea
							id="profile-about-me"
							rows={12}
							value={aboutMe}
							onChange={(e) => setAboutMe(e.target.value)}
							placeholder="身份、偏好、作息、主力仓库等——写给所有 bot 看的账号级说明。"
						/>
						<p className="text-xs text-muted-foreground">当前 {aboutMe.length} 字符，上限 20000；超限保存会被拒绝，原内容不受影响。</p>
					</div>
					<div className="flex items-center gap-2">
						<Button type="submit" disabled={busy}>
							{busy ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
							保存
						</Button>
						{notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
					</div>
				</form>
			</CardContent>
		</Card>
	);
}
