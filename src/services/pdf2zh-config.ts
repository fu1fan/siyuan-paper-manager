import { withoutConfigLanguages } from "../types/settings";
import { ensureCredentialPlaceholders, isSecretKey, pdf2zhModelEnvKey, redactSecretValues } from "./pdf2zh-secrets";

export const HIDDEN_SECRET = "••••••••（已隐藏）";

/**
 * 渲染到 JSON 文本域前隐藏明文密钥。只替换密钥键上的字符串值，
 * 其余字段原样保留，用户不会在界面上看到已保存的真实密钥。
 */
export function maskSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    isSecretKey(key) && typeof item === "string" && item ? HIDDEN_SECRET : maskSecrets(item),
  ]));
}

/** 用隐藏前的原值还原占位符；用户新填写的值不受影响。 */
export function restoreMaskedSecrets(value: unknown, original: unknown): unknown {
  if (Array.isArray(value)) return value.map((item, i) => restoreMaskedSecrets(item, Array.isArray(original) ? original[i] : undefined));
  if (!value || typeof value !== "object") return value === HIDDEN_SECRET ? original : value;
  const source = original && typeof original === "object" ? original as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    isSecretKey(key) && item === HIDDEN_SECRET ? source[key] : restoreMaskedSecrets(item, source[key]),
  ]));
}

export function cloneConfig(config: Record<string, unknown> | undefined): Record<string, unknown> {
  return structuredClone(config ?? {});
}

export function firstTranslator(config: Record<string, unknown>): Record<string, unknown> | undefined {
  const list = config.translators;
  const first = Array.isArray(list) ? list[0] : undefined;
  return first && typeof first === "object" && !Array.isArray(first) ? first as Record<string, unknown> : undefined;
}

/** 生成落盘前的安全托管配置：清除明文密钥，同时为当前服务保留凭据键名占位。 */
export function secretSafeConfig(config: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactSecretValues(config) as Record<string, unknown>;
  return ensureCredentialPlaceholders(redacted, configTranslatorValue(redacted));
}

/** 归一化为单条 translators 条目；兼容旧版的顶层 translator 字符串。 */
export function canonicalPdf2zhConfig(config: Record<string, unknown>): Record<string, unknown> {
  // 语言属于 CLI 参数（-li/-lo）而非配置：无论是读取系统配置还是用户手填 JSON，
  // 都统一剔除，避免这些无效键被写回托管配置。
  const result = withoutConfigLanguages(cloneConfig(config));
  const legacy = typeof result.translator === "string" ? result.translator : "";
  const first = firstTranslator(result);
  const service = (first && typeof first.name === "string" ? first.name : legacy) || "google";
  result.translators = [{ ...(first ?? {}), name: service, envs: first?.envs && typeof first.envs === "object" ? { ...(first.envs as Record<string, unknown>) } : {} }];
  delete result.translator;
  return result;
}

export function configTranslatorValue(config: Record<string, unknown>): string {
  return (firstTranslator(config)?.name as string | undefined) || (typeof config.translator === "string" ? config.translator : "google");
}

export function modelEnvKey(service: string): string {
  return pdf2zhModelEnvKey(service);
}

/** 读取当前服务的模型名；精确键缺失时回退到任意 *_MODEL 键。 */
export function configModelValue(config: Record<string, unknown>): string {
  const first = firstTranslator(config);
  const envs = first?.envs && typeof first.envs === "object" ? first.envs as Record<string, unknown> : {};
  const exact = envs[modelEnvKey(configTranslatorValue(config))];
  if (typeof exact === "string") return exact;
  const fallback = Object.keys(envs).find(key => /_MODEL$/i.test(key));
  return fallback && typeof envs[fallback] === "string" ? envs[fallback] as string : "";
}
