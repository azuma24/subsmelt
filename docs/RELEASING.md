# Releasing

Two deployables share one version number and ship together: the SubSmelt app
(Docker image) and the Windows Whisper backend (installer + GitHub release).

Publishing is driven **entirely by tags**. Pushing to `main` publishes nothing.

| Tag | Workflow | Publishes |
|---|---|---|
| `v<version>` | `.github/workflows/docker-publish.yml` | `ghcr.io/azuma24/subsmelt`, **including re-pointing `latest`** |
| `whisper-v<version>` | `.github/workflows/windows-whisper-build.yml` | Windows installer (~1 GB) + a GitHub release with it attached |

Both also accept `workflow_dispatch` if you ever need to run one without a tag.

---

## Cutting a release

**1. Bump all three version files together.** They are separate files and
nothing enforces agreement:

- `package.json` → `"version"`
- `backend-whisper/app/version.py` → `_DEFAULT_VERSION`
- `backend-whisper/packaging/windows/installer.iss` → `#define MyAppVersion`

The Windows control GUI reads its version from `app/version.py`, so it follows
automatically — do not add a fourth constant.

**2. Move `## [Unreleased]` into a dated section** in `CHANGELOG.md`.

**3. Verify before tagging.** CI runs all of this, but a failed release tag is
more annoying to undo than a failed push:

```bash
npm ci --legacy-peer-deps   # the flag is required; see HANDOFF.md §3
npm run typecheck && npm test && npm run build
cd backend-whisper && python -m pytest tests -q
```

**4. Commit to `main`.** The convention is a direct commit, not a PR:

```bash
git commit -am "chore(release): <version>"
git push origin main
```

**5. Tag the same commit twice and push both tags:**

```bash
git tag -a v<version>        -m "SubSmelt <version>"
git tag -a whisper-v<version> -m "SubSmelt Whisper backend <version>"
git push origin v<version> whisper-v<version>
```

**6. Write the app's release notes by hand.** The `whisper-v*` workflow creates
its own GitHub release for the installer; the app's notes are not automated.

---

## Known constraints

- **Tag pushes may be rejected for automation.** A GitHub App / CI token can
  hold `contents: write` for branch refs and still get **HTTP 403** on a tag
  ref, typically from a tag protection ruleset. If that happens the branch push
  will have succeeded while the tags failed — check `git ls-remote --tags
  origin` before assuming a release went out. Tagging from a local machine with
  your own credentials is the reliable path.
- **The Windows installer is unsigned**, so SmartScreen warns on every download.
  Tracked in [TODO.md](TODO.md).
- **The installer is ~1 GB** because the cuDNN and cuBLAS wheels are bundled. No
  model weights are included; the model manager downloads those on first use.

---
