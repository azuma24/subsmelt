# Dependency reproducibility

The app uses `npm ci` and `package-lock.json`. The supported Node range is `>=22.14.0 <23 || >=24 <25`; CI tests Node 22.14.0, 24.0.0 and the latest Node 24 patch. Locked AI SDK packages and better-sqlite3 require Node >=22, and Vite requires >=22.12.0 on Node 22. However, better-sqlite3 13.0.3's bundled native addon segfaults on Node 22.12.0 on macOS arm64 and Linux amd64; 22.13.1 also failed on macOS arm64, while 22.14.0 passed SQLite smoke tests on both. Node 23 is excluded rather than claimed as supported without CI coverage. CI does not test every patch or platform.

The Python base `requirements.txt` pins direct dependencies, not the entire transitive graph. CI uses `backend-whisper/requirements-ci-linux-py313.txt`, generated from `requirements-ci.in` for Linux x86_64 and Python 3.13, with the existing smoke-tested Windows packaging constraints as a starting point. It includes pytest, Ruff and httpx, but excludes optional URL and diarization extras. Regenerate from the repository root with uv 0.13.6:

```sh
uv pip compile backend-whisper/requirements-ci.in \
  -c backend-whisper/packaging/windows/constraints.txt \
  --python-version 3.13 --python-platform x86_64-manylinux_2_28 \
  --no-header -o backend-whisper/requirements-ci-linux-py313.txt
```

Review the diff and run the backend CI suite after updates. CI installs both the lock and input requirements and runs `pip check`, so conflicting direct changes fail; a newly introduced dependency can still resolve without a lock entry. Regenerate and review the complete graph whenever inputs change. This is a version lock, not a hash lock: it does not pin Python or pip patch versions, indexes, artifacts, OS images, or protect against replaced distributions. It does not lock the Docker backend, macOS or Windows builds, CUDA, model downloads, or optional extras. Windows has separate packaging constraints; macOS packaging uses those constraints where applicable. CI's Linux lock is not a claim those platforms are reproducible.
