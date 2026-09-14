/**
 * pdf2zh 在 translator.py 中为每个翻译服务固定声明了 envs 键名。
 * BaseTranslator.set_envs 会用配置文件中该服务的 envs 整表替换内置默认表，
 * 且只遍历替换后仍存在的键去读取 os.environ；因此托管配置必须保留 API key 的
 * 键名（值可以是 null），否则插件注入的环境变量会被忽略，pdf2zh 会在初始化时
 * 直接抛 KeyError: 'DEEPSEEK_API_KEY' 之类的错误。
 */

/** 服务名 → pdf2zh 实际使用的凭据类环境变量键名（大小写必须一致）。 */
const PDF2ZH_CREDENTIAL_KEYS: Record<string, readonly string[]> = {
  deepl: ["DEEPL_AUTH_KEY"],
  deeplx: ["DEEPLX_ACCESS_TOKEN"],
  openai: ["OPENAI_API_KEY"],
  "azure-openai": ["AZURE_OPENAI_API_KEY"],
  zhipu: ["ZHIPU_API_KEY"],
  modelscope: ["MODELSCOPE_API_KEY"],
  silicon: ["SILICON_API_KEY"],
  gemini: ["GEMINI_API_KEY"],
  grok: ["GROK_API_KEY"],
  groq: ["GROQ_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  openailiked: ["OPENAILIKED_API_KEY"],
  dify: ["DIFY_API_KEY"],
  anythingllm: ["AnythingLLM_APIKEY"],
  azure: ["AZURE_API_KEY"],
  tencent: ["TENCENTCLOUD_SECRET_ID", "TENCENTCLOUD_SECRET_KEY"],
  "qwen-mt": ["ALI_API_KEY"],
};

/** 少数服务的模型键名不能按 <服务名>_MODEL 推导。 */
const MODEL_KEY_OVERRIDES: Record<string, string> = { "qwen-mt": "ALI_MODEL" };

const CREDENTIAL_KEY_SET = new Set(Object.values(PDF2ZH_CREDENTIAL_KEYS).flat());
const CREDENTIAL_KEY_BY_UPPER = new Map([...CREDENTIAL_KEY_SET].map(key => [key.toUpperCase(), key]));
const SECRET_PATTERN = /(api[_-]?key|secret|token|password|passwd|凭据|密钥)/i;

export function pdf2zhCredentialKeys(service: string): readonly string[] {
  return PDF2ZH_CREDENTIAL_KEYS[service.trim().toLowerCase()] ?? [];
}

export function pdf2zhRequiresSecret(service: string): boolean {
  return pdf2zhCredentialKeys(service).length > 0;
}

/** 单密钥服务在设置界面使用的键名；多密钥服务返回第一个。 */
export function pdf2zhPrimarySecretKey(service: string): string {
  return pdf2zhCredentialKeys(service)[0] ?? "";
}

/** 还原 pdf2zh 声明的大小写（例如 AnythingLLM_APIKEY 不能写成全大写）。 */
export function canonicalSecretEnvKey(key: string): string {
  const clean = key.trim();
  return CREDENTIAL_KEY_BY_UPPER.get(clean.toUpperCase()) ?? clean.toUpperCase();
}

export function pdf2zhModelEnvKey(service: string): string {
  const name = service.trim().toLowerCase();
  return MODEL_KEY_OVERRIDES[name] ?? `${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_MODEL`;
}

export function isSecretKey(key: string): boolean {
  return CREDENTIAL_KEY_SET.has(key) || SECRET_PATTERN.test(key);
}

function translatorEnvRecord(entry: unknown): Record<string, unknown> {
  const envs = entry && typeof entry === "object" && !Array.isArray(entry)
    ? (entry as Record<string, unknown>).envs
    : undefined;
  return envs && typeof envs === "object" && !Array.isArray(envs) ? { ...(envs as Record<string, unknown>) } : {};
}

/** 保留已有值，只为缺失的凭据键补 null 占位，使 pdf2zh 能读取进程环境变量。 */
export function withCredentialPlaceholders(envs: Record<string, unknown>, service: string): Record<string, unknown> {
  const next = { ...envs };
  for (const key of pdf2zhCredentialKeys(service)) if (!(key in next)) next[key] = null;
  return next;
}

/** 在完整配置对象中为指定服务补齐凭据占位，未知字段与其它服务条目保持原样。 */
export function ensureCredentialPlaceholders(config: Record<string, unknown>, service: string): Record<string, unknown> {
  const name = service.trim().toLowerCase();
  if (!name || !pdf2zhRequiresSecret(name)) return config;
  const result = structuredClone(config);
  const list = Array.isArray(result.translators) ? [...(result.translators as unknown[])] : [];
  const index = list.findIndex(entry => entry && typeof entry === "object" && !Array.isArray(entry)
    && String((entry as Record<string, unknown>).name ?? "").toLowerCase() === name);
  if (index >= 0) {
    const entry = { ...(list[index] as Record<string, unknown>) };
    entry.envs = withCredentialPlaceholders(translatorEnvRecord(entry), name);
    list[index] = entry;
  } else {
    list.push({ name, envs: withCredentialPlaceholders({}, name) });
  }
  result.translators = list;
  return result;
}

/** 密钥不落盘：命中密钥名的字符串值改为 null，保留键名作为占位。 */
export function redactSecretValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecretValues);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    isSecretKey(key) && typeof item === "string" && item ? null : redactSecretValues(item),
  ]));
}
