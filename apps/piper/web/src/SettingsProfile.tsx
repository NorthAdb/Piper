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
import { Textarea } from "@/components/ui/textarea";

const COMMON_TIMEZONES = ["Asia/Hong_Kong", "Asia/Shanghai", "Asia/Tokyo", "Asia/Singapore", "UTC", "Europe/London", "America/New_York"];

export function ProfileSettingsForm({ onUnauthorized }: { onUnauthorized: () => void }) {
	const [displayName, setDisplayName] = useState("");
	const [timezone, setTimezone] = useState("Asia/Hong_Kong");
	const [aboutMe, setAboutMe] = useState("");
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState("");

	useEffect(() => {
		Promise.all([getProfileSettings(), getAboutMe()])
			.then(([profile, markdown]) => {
				setDisplayName(profile.displayName);
				setTimezone(profile.timezone);
				setAboutMe(markdown);
			})
			.catch((e) => {
				if (e instanceof UnauthorizedError) onUnauthorized();
			});
	}, [onUnauthorized]);

	const onSave = async (e: FormEvent) => {
		e.preventDefault();
		setBusy(true);
		setNotice("");
		try {
			await saveProfileSettings({ displayName: displayName.trim(), timezone: timezone.trim() });
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
						<Input id="profile-timezone" list="piper-timezones" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
						<datalist id="piper-timezones">
							{COMMON_TIMEZONES.map((tz) => (
								<option key={tz} value={tz} />
							))}
						</datalist>
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
