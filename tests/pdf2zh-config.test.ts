import { HIDDEN_SECRET, canonicalPdf2zhConfig, cloneConfig, configModelValue, configTranslatorValue, maskSecrets, modelEnvKey, restoreMaskedSecrets, secretSafeConfig } from "../src/services/pdf2zh-config";

describe("secret masking in the JSON editor", () => {
  interface Config { NOTO_FONT_PATH: string; translators: Array<{ name: string; envs: Record<string, unknown> }> }
  const config = (): Config => ({
    NOTO_FONT_PATH: "/fonts",
    translators: [{ name: "deepseek", envs: { DEEPSEEK_API_KEY: "sk-real-value", DEEPSEEK_MODEL: "deepseek-chat" } }],
  });

  it("hides credential values but keeps key names and non-secrets", () => {
    const masked = maskSecrets(config()) as Config;
    expect(masked.translators[0]!.envs.DEEPSEEK_API_KEY).toBe(HIDDEN_SECRET);
    expect(masked.translators[0]!.envs.DEEPSEEK_MODEL).toBe("deepseek-chat");
    expect(masked.NOTO_FONT_PATH).toBe("/fonts");
  });

  it("restores a hidden value from the original and keeps a newly typed one", () => {
    const original = config();
    const edited = maskSecrets(original) as Config;
    edited.translators[0]!.envs.DEEPSEEK_API_KEY = "sk-user-retyped";
    expect((restoreMaskedSecrets(edited, original) as Config).translators[0]!.envs.DEEPSEEK_API_KEY).toBe("sk-user-retyped");

    const untouched = maskSecrets(original) as Config;
    expect((restoreMaskedSecrets(untouched, original) as Config).translators[0]!.envs.DEEPSEEK_API_KEY).toBe("sk-real-value");
  });

  it("restores secrets nested inside arrays and leaves plain values untouched", () => {
    const original = { translators: [{ name: "openai", envs: { OPENAI_API_KEY: "sk-one" } }, { name: "zhipu", envs: { ZHIPU_API_KEY: "sk-two" } }] };
    const edited = maskSecrets(original) as typeof original;
    expect(edited.translators[0]!.envs.OPENAI_API_KEY).toBe(HIDDEN_SECRET);
    edited.translators[1]!.envs.ZHIPU_API_KEY = "sk-retyped";
    const restored = restoreMaskedSecrets(edited, original) as typeof original;
    expect(restored.translators[0]!.envs.OPENAI_API_KEY).toBe("sk-one");
    expect(restored.translators[1]!.envs.ZHIPU_API_KEY).toBe("sk-retyped");
  });
});

describe("canonical pdf2zh config", () => {
  it("keeps one translators entry and migrates a legacy top-level translator string", () => {
    expect(canonicalPdf2zhConfig({ translator: "zhipu" })).toMatchObject({
      translators: [{ name: "zhipu", envs: {} }],
    });
    expect("translator" in canonicalPdf2zhConfig({ translator: "zhipu" })).toBe(false);
  });

  it("preserves unknown fields and existing envs while dropping later translator entries", () => {
    const result = canonicalPdf2zhConfig({
      UNKNOWN_SETTING: 3,
      translators: [
        { name: "openai", envs: { OPENAI_MODEL: "gpt-4o" }, custom: true },
        { name: "google", envs: {} },
      ],
    });
    expect(result.UNKNOWN_SETTING).toBe(3);
    expect(result.translators).toEqual([{ name: "openai", envs: { OPENAI_MODEL: "gpt-4o" }, custom: true }]);
  });

  it("defaults to google when neither shape is present", () => {
    expect(configTranslatorValue({})).toBe("google");
    expect(configTranslatorValue({ translators: [{ name: "" }] })).toBe("google");
  });

  it("reads the model for the current service with a *_MODEL fallback", () => {
    expect(configModelValue({ translators: [{ name: "qwen-mt", envs: { ALI_MODEL: "qwen-mt-turbo" } }] })).toBe("qwen-mt-turbo");
    // A stale model key from another service still surfaces rather than being hidden.
    expect(configModelValue({ translators: [{ name: "openai", envs: { OTHER_MODEL: "legacy" } }] })).toBe("legacy");
    expect(configModelValue({})).toBe("");
  });

  it("uses the service-specific model key when both exist", () => {
    const config = { translators: [{ name: "qwen-mt", envs: { ALI_MODEL: "right", SOMETHING_MODEL: "wrong" } }] };
    expect(modelEnvKey("qwen-mt")).toBe("ALI_MODEL");
    expect(configModelValue(config)).toBe("right");
  });
});

describe("config written to disk", () => {
  it("redacts inline secrets and keeps a null placeholder for the current service", () => {
    const safe = secretSafeConfig({ translators: [{ name: "deepseek", envs: { DEEPSEEK_API_KEY: "sk-plaintext", DEEPSEEK_MODEL: "deepseek-chat" } }] });
    expect(safe).toEqual({ translators: [{ name: "deepseek", envs: { DEEPSEEK_API_KEY: null, DEEPSEEK_MODEL: "deepseek-chat" } }] });
    expect(JSON.stringify(safe)).not.toContain("sk-plaintext");
  });

  it("does not mutate the input config", () => {
    const input = { translators: [{ name: "deepseek", envs: { DEEPSEEK_API_KEY: "sk-plaintext" } }] };
    secretSafeConfig(input);
    cloneConfig(input);
    expect(input.translators[0]!.envs.DEEPSEEK_API_KEY).toBe("sk-plaintext");
  });
});

describe("language keys are not part of the managed config", () => {
  it("strips language keys when canonicalizing, including from an imported system config", () => {
    // 语言由 -li/-lo 传入；系统配置里带有的语言键不应被写进托管配置。
    const result = canonicalPdf2zhConfig({
      PDF2ZH_LANG_FROM: "English", PDF2ZH_LANG_TO: "Simplified Chinese",
      NOTO_FONT_PATH: "/font.ttf",
      translators: [{ name: "deepseek", envs: { DEEPSEEK_API_KEY: null } }],
    });
    expect(result.PDF2ZH_LANG_FROM).toBeUndefined();
    expect(result.PDF2ZH_LANG_TO).toBeUndefined();
    expect(result.NOTO_FONT_PATH).toBe("/font.ttf");
    expect(result.translators).toEqual([{ name: "deepseek", envs: { DEEPSEEK_API_KEY: null } }]);
  });

  it("leaves other config keys untouched", () => {
    const result = canonicalPdf2zhConfig({ PDF2ZH_VFONT: "a.ttf", CUSTOM: 1, translators: [] });
    expect(result.PDF2ZH_VFONT).toBe("a.ttf");
    expect(result.CUSTOM).toBe(1);
  });
});
