import { describe, expect, it } from "vitest";
import {
  canonicalSecretEnvKey, ensureCredentialPlaceholders, isSecretKey,
  pdf2zhCredentialKeys, pdf2zhModelEnvKey, pdf2zhPrimarySecretKey,
  pdf2zhRequiresSecret, redactSecretValues, withCredentialPlaceholders,
} from "../src/services/pdf2zh-secrets";

describe("pdf2zh credential key names", () => {
  it("maps services to the exact env keys pdf2zh declares", () => {
    expect(pdf2zhCredentialKeys("deepseek")).toEqual(["DEEPSEEK_API_KEY"]);
    expect(pdf2zhCredentialKeys("Azure-OpenAI")).toEqual(["AZURE_OPENAI_API_KEY"]);
    expect(pdf2zhCredentialKeys("qwen-mt")).toEqual(["ALI_API_KEY"]);
    expect(pdf2zhCredentialKeys("deepl")).toEqual(["DEEPL_AUTH_KEY"]);
    expect(pdf2zhCredentialKeys("anythingllm")).toEqual(["AnythingLLM_APIKEY"]);
    expect(pdf2zhCredentialKeys("tencent")).toEqual(["TENCENTCLOUD_SECRET_ID", "TENCENTCLOUD_SECRET_KEY"]);
  });

  it("reports keyless services as not needing a secret", () => {
    for (const service of ["google", "bing", "ollama", "xinference", "argos"]) {
      expect(pdf2zhRequiresSecret(service)).toBe(false);
    }
    for (const service of ["deepseek", "deepl", "deeplx", "dify", "azure"]) {
      expect(pdf2zhRequiresSecret(service)).toBe(true);
    }
  });

  it("uses the first credential key as the settings-panel key", () => {
    expect(pdf2zhPrimarySecretKey("deepseek")).toBe("DEEPSEEK_API_KEY");
    expect(pdf2zhPrimarySecretKey("qwen-mt")).toBe("ALI_API_KEY");
    expect(pdf2zhPrimarySecretKey("google")).toBe("");
  });

  it("restores pdf2zh's declared casing and derives model keys", () => {
    expect(canonicalSecretEnvKey("anythingllm_apikey")).toBe("AnythingLLM_APIKEY");
    expect(canonicalSecretEnvKey("deepseek_api_key")).toBe("DEEPSEEK_API_KEY");
    expect(canonicalSecretEnvKey("CUSTOM_TOKEN")).toBe("CUSTOM_TOKEN");
    expect(pdf2zhModelEnvKey("qwen-mt")).toBe("ALI_MODEL");
    expect(pdf2zhModelEnvKey("azure-openai")).toBe("AZURE_OPENAI_MODEL");
    expect(pdf2zhModelEnvKey("deepseek")).toBe("DEEPSEEK_MODEL");
  });

  it("recognizes secret-looking keys so values are never persisted", () => {
    expect(isSecretKey("DEEPSEEK_API_KEY")).toBe(true);
    expect(isSecretKey("DEEPL_AUTH_KEY")).toBe(true);
    expect(isSecretKey("AnythingLLM_APIKEY")).toBe(true);
    expect(isSecretKey("PDF2ZH_LANG_FROM")).toBe(false);
    expect(isSecretKey("DEEPSEEK_MODEL")).toBe(false);
  });
});

describe("credential placeholders", () => {
  it("adds null placeholders for a service without dropping existing values", () => {
    expect(withCredentialPlaceholders({ DEEPSEEK_MODEL: "deepseek-flash" }, "deepseek"))
      .toEqual({ DEEPSEEK_MODEL: "deepseek-flash", DEEPSEEK_API_KEY: null });
  });

  it("adds a missing translator entry when the config has none", () => {
    const config = { translators: [{ name: "google", envs: {} }] };
    expect(ensureCredentialPlaceholders(config, "qwen-mt")).toEqual({
      translators: [{ name: "google", envs: {} }, { name: "qwen-mt", envs: { ALI_API_KEY: null } }],
    });
  });

  it("patches the matching translator case-insensitively and preserves unknown fields", () => {
    const config = { theme: "dark", translators: [{ name: "DeepSeek", envs: { DEEPSEEK_MODEL: "deepseek-flash" } }] };
    expect(ensureCredentialPlaceholders(config, "deepseek")).toEqual({
      theme: "dark",
      translators: [{ name: "DeepSeek", envs: { DEEPSEEK_MODEL: "deepseek-flash", DEEPSEEK_API_KEY: null } }],
    });
  });

  it("leaves keyless services untouched", () => {
    const config = { translators: [{ name: "google", envs: {} }] };
    expect(ensureCredentialPlaceholders(config, "google")).toEqual(config);
  });
});

describe("redactSecretValues", () => {
  it("blanks string secret values while keeping key names as placeholders", () => {
    expect(redactSecretValues({ translators: [{ name: "deepseek", envs: {
      DEEPSEEK_API_KEY: "sk-live-secret", DEEPSEEK_MODEL: "deepseek-flash",
    } }] })).toEqual({ translators: [{ name: "deepseek", envs: {
      DEEPSEEK_API_KEY: null, DEEPSEEK_MODEL: "deepseek-flash",
    } }] });
  });

  it("keeps null placeholders and non-secret strings intact", () => {
    expect(redactSecretValues({ DEEPSEEK_API_KEY: null, NOTO_FONT_PATH: "/app/font.ttf" }))
      .toEqual({ DEEPSEEK_API_KEY: null, NOTO_FONT_PATH: "/app/font.ttf" });
  });
});
