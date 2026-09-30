process.env.DATA_DIR = process.argv[2];
const db = await import("../../src/server/db.ts");
for (const status of ["pending", "pending", "translating", "done", "done", "skipped", "error"]) {
  db.createJob({ task_id: 1, srt_path: `/media/${status}-${Math.random()}.srt`, output_path: "/media/x.eng.srt", video_path: null, status });
}
console.log("seeded", db.getJobs().length);
