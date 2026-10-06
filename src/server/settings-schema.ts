import { z } from "zod";
import { SETTINGS, type SettingKey, type SettingSpec, type TypedSettings } from "../shared/settings.js";
import { defaultSetting, getAllSettings } from "./config.js";

export { settingError, SECRET_SETTING_KEYS, SETTINGS } from "../shared/settings.js";
export type { SettingKey, TypedSettings } from "../shared/settings.js";

/**
 * The typed reader. Each field parses the stored string the way the table
 * says and, when a stored value is not what the table expects (an old
 * config.json, a hand edit), falls back to the shipped default instead of
 * failing, which is what the string-parsing readers it replaces did.
 */
function fieldSchema(key: SettingKey, spec: SettingSpec, fallback: string): z.ZodType<unknown> {
  switch (spec.kind) {
    case "flag":
      return z.string().transform((v) => v === "1");
    case "int":
      return z
        .string()
        .regex(/^-?\d+$/)
        .transform(Number)
        .pipe(z.number().int().min(spec.min).max(spec.max))
        .catch(Number(fallback));
    case "float":
      return z
        .string()
        .regex(/^-?(\d+(\.\d*)?|\.\d+)$/)
        .transform(Number)
        .pipe(z.number().min(spec.min).max(spec.max))
        .catch(Number(fallback));
    case "enum":
      return z.enum(spec.values as [string, ...string[]]).catch(fallback);
    default:
      return z.string().catch(fallback);
  }
}

let schema: z.ZodType<TypedSettings> | null = null;

function settingsSchema(): z.ZodType<TypedSettings> {
  if (schema) return schema;
  const shape: Record<string, z.ZodType<unknown>> = {};
  for (const [key, spec] of Object.entries(SETTINGS) as [SettingKey, SettingSpec][]) {
    shape[key] = fieldSchema(key, spec, defaultSetting(key));
  }
  schema = z.object(shape) as unknown as z.ZodType<TypedSettings>;
  return schema;
}

/** Every setting as its typed value: flags as booleans, numbers in range, enums narrowed. */
export function readSettings(): TypedSettings {
  return settingsSchema().parse(getAllSettings());
}
