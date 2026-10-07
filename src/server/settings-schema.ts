import { SETTINGS, type SettingKey, type SettingSpec, type TypedSettings } from "../shared/settings.js";
import { defaultSetting, getAllSettings } from "./config.js";

export { settingError, SECRET_SETTING_KEYS, SETTINGS } from "../shared/settings.js";
export type { SettingKey, TypedSettings } from "../shared/settings.js";

const INT_RE = /^-?\d+$/;
const FLOAT_RE = /^-?(\d+(\.\d*)?|\.\d+)$/;

/**
 * One stored string as its typed value, the way the table says. A value that
 * is not what the table expects (an old config.json, a hand edit) becomes the
 * shipped default instead of failing, which is what the string-parsing
 * readers this replaces did.
 */
function typedValue(spec: SettingSpec, stored: string | undefined, fallback: string): unknown {
  const value = stored ?? fallback;
  switch (spec.kind) {
    case "flag":
      return value === "1";
    case "int": {
      const n = Number(value);
      return INT_RE.test(value) && Number.isInteger(n) && n >= spec.min && n <= spec.max ? n : Number(fallback);
    }
    case "float": {
      const n = Number(value);
      return FLOAT_RE.test(value) && n >= spec.min && n <= spec.max ? n : Number(fallback);
    }
    case "enum":
      return (spec.values as readonly string[]).includes(value) ? value : fallback;
    default:
      return value;
  }
}

/** Every setting as its typed value: flags as booleans, numbers in range, enums narrowed. */
export function readSettings(): TypedSettings {
  const stored = getAllSettings();
  const typed: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(SETTINGS) as [SettingKey, SettingSpec][]) {
    typed[key] = typedValue(spec, stored[key], defaultSetting(key));
  }
  return typed as TypedSettings;
}
