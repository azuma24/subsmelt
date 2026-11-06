# Releasing

Coordinated releases ship the SubSmelt Docker image and the Windows and macOS
Whisper backend packages with the same version number.

Push version tags to start publishing. A push to `main` starts CI.

| Tag | Workflow | Publishes |
|---|---|---|
| `v<version>` | `.github/workflows/docker-publish.yml` | `ghcr.io/azuma24/subsmelt`, **including re-pointing `latest`** |
| `whisper-v<version>` | `.github/workflows/windows-whisper-build.yml` | Windows installer (~1 GB) on the backend GitHub release |
| `whisper-v<version>` | `.github/workflows/macos-whisper-build.yml` | Apple Silicon zip on the same backend GitHub release |

All three also accept `workflow_dispatch`.

---

## Cutting a release

**1. Bump the app and backend versions together.**

- `package.json` → `"version"`
- `package-lock.json` → top-level `"version"` and `packages[""].version`
- `backend-whisper/app/version.py` → `_DEFAULT_VERSION`
- `backend-whisper/packaging/windows/installer.iss` → `#define MyAppVersion`

The Windows control GUI and macOS bundle read their version from `app/version.py`.
The macOS workflow checks that this version matches the backend tag.

**2. Move `## [Unreleased]` into a dated section** in `CHANGELOG.md`, and put
the new number in `README.md` (the "Current release" line and the pinned image
tag in Quick Start).

**3. Verify before tagging.** Use a supported Node version and a Python 3.13
environment with the backend test dependencies. The lint commands below use
Ruff 0.17.3, the version pinned in CI. See [dependency reproducibility](dependency-reproducibility.md).

```bash
npm ci
npm run lint && npm test && npm run build
cd backend-whisper
uvx ruff@0.17.3 check . && uvx ruff@0.17.3 format --check . && python -m pytest tests -q
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

**6. Write the app's release notes by hand.** The `whisper-v*` workflows publish
the backend GitHub release with both installers. Use the corresponding changelog
section for the app's GitHub release and link to the backend release for downloads.
Set `--latest=false` on the app's release to keep GitHub's Latest link on the
backend downloads.

---

## App-only releases

When `backend-whisper` has not changed, a release may ship the app alone: bump
`package.json`, `package-lock.json`, `README.md` and `CHANGELOG.md`, push only
`v<version>`, and create the app's GitHub release with `--latest=false`. Say in
the notes which backend release to keep using.
The backend's version files stay at its last release.

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
- **A green build is not a working installer by itself.** The Windows workflow's
  smoke tests (frozen server `/health` and a Whisper `tiny` transcription) are
  the gate; they run on CPU only, so GPU paths need a check on real hardware.
- **Installer dependencies are locked** in
  `backend-whisper/packaging/windows/constraints.txt`. Bump a version there on
  purpose; never unpin to "get the latest".
- **Replacing a published installer** (same version): dispatch the workflow with
  that version, download the artifact, `gh release upload whisper-v<ver> <exe>
  --clobber`, and add a dated note with the new SHA-256 to the release.
- **The installer is ~1 GB** because the cuDNN and cuBLAS wheels are bundled. No
  model weights are included; the model manager downloads those on first use.

---
