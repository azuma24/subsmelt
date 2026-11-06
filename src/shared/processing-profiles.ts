import { z } from "zod";

const folder = z
  .string()
  .max(1024)
  .refine((value) => {
    if (!value) return true;
    return (
      !value.includes("\\") &&
      !value.includes("\0") &&
      value.split("/").every((part) => part && part !== "." && part !== "..")
    );
  }, "Use a folder relative to the media root");
const identifier = z.string().trim().min(1).max(100);
const profileSchema = z.strictObject({
  id: identifier,
  name: identifier,
  folder,
  model: z.string().trim().min(1).max(250).optional(),
  language: z
    .string()
    .regex(/^(auto|[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})?)$/)
    .optional(),
  outputFormat: z.enum(["srt", "vtt", "ass", "txt"]).optional(),
  maxCueDuration: z.number().min(0).max(60).optional(),
  maxLineWidth: z.number().int().min(1).max(200).optional(),
  maxReadingSpeed: z.number().min(1).max(100).optional(),
  correctionListIds: z.array(identifier).max(50).optional(),
  targetTaskIds: z.array(z.number().int().positive()).max(50).optional(),
  review: z.boolean().optional(),
  exportNote: z.boolean().optional(),
});
const profilesSchema = z
  .array(profileSchema)
  .max(50)
  .superRefine((profiles, context) => {
    const ids = new Set<string>();
    const folders = new Set<string>();
    profiles.forEach((profile, index) => {
      if (ids.has(profile.id))
        context.addIssue({ code: "custom", message: "Duplicate profile ID", path: [index, "id"] });
      if (folders.has(profile.folder))
        context.addIssue({ code: "custom", message: "Duplicate profile folder", path: [index, "folder"] });
      ids.add(profile.id);
      folders.add(profile.folder);
    });
  });

export type ProcessingProfile = z.infer<typeof profileSchema>;

export function parseProcessingProfiles(raw: string | undefined): ProcessingProfile[] {
  return profilesSchema.parse(JSON.parse(raw || "[]"));
}

export function matchProcessingProfile(
  profiles: readonly ProcessingProfile[],
  folderPath: string,
): ProcessingProfile | undefined {
  let matched: ProcessingProfile | undefined;
  for (const profile of profiles) {
    if (profile.folder && profile.folder !== folderPath && !folderPath.startsWith(`${profile.folder}/`)) continue;
    if (!matched || profile.folder.length > matched.folder.length) matched = profile;
  }
  return matched;
}
