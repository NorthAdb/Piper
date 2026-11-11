// 模型服务商目录（单一数据源）：参照 Pi 的 provider 选择——先选服务商，
// 再用该服务商的 API Key 接入（只实现 API Key 方式，不做账号 / OAuth 登录）。
// 目录只是预置便利：baseUrl 与模型名都允许用户改填任意值，不是白名单。
// 内核不读本模块——它仍按 settings-model.json 里的 baseUrl + modelId + apiKey
// 建 OpenAI 兼容 provider；目录的职责是给设置页与读回视图提供预置与归属判定。
export const MODEL_PROVIDERS = [
	{
		id: "deepseek",
		name: "DeepSeek",
		baseUrl: "https://api.deepseek.com/v1",
		models: ["deepseek-chat", "deepseek-reasoner"],
	},
	{
		id: "openai",
		name: "OpenAI",
		baseUrl: "https://api.openai.com/v1",
		models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
	},
	{
		id: "moonshot",
		name: "Moonshot / Kimi",
		baseUrl: "https://api.moonshot.cn/v1",
		models: ["moonshot-v1-8k", "moonshot-v1-32k", "kimi-k2-turbo-preview"],
	},
	{
		id: "zhipu",
		name: "智谱 GLM",
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		models: ["glm-4.6", "glm-4.5"],
	},
	{
		id: "dashscope",
		name: "通义千问",
		baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		models: ["qwen-plus", "qwen-turbo", "qwen-max"],
	},
	{
		id: "siliconflow",
		name: "SiliconFlow",
		baseUrl: "https://api.siliconflow.cn/v1",
		models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct"],
	},
	{
		id: "openrouter",
		name: "OpenRouter",
		baseUrl: "https://openrouter.ai/api/v1",
		models: ["openai/gpt-4o-mini", "deepseek/deepseek-chat"],
	},
	{
		id: "custom",
		name: "自定义端点",
		baseUrl: "",
		models: [],
	},
];

export function getModelProvider(id) {
	return MODEL_PROVIDERS.find((p) => p.id === id) ?? null;
}

export function isKnownModelProvider(id) {
	return typeof id === "string" && MODEL_PROVIDERS.some((p) => p.id === id);
}

// 一份已保存的模型设置归属哪个服务商：文件里有合法 provider 就用它；
// 旧文件没有 provider 字段（或值不认识）一律按 custom 读——不猜、不丢原值。
export function resolveModelProviderId(saved) {
	const id = saved && typeof saved.provider === "string" ? saved.provider : "";
	return isKnownModelProvider(id) ? id : "custom";
}
