# Restore guide

1. Clone this repository.
2. Treat `source/` as the exact V9 project root; preserve all paths and filenames.
3. Install dependencies declared in `source/package.json`.
4. Run the test command defined in that package file from `source/`.
5. Run `source/tools/validate_v9.py` with Python 3.
6. For deployment restore, publish the contents of `source/` using the deployment workflow preserved under `source/.github/workflows/`.

Verify the pinned source commit and Git blob SHAs against `SOURCE-BASELINE.md` and `FILE-MANIFEST.txt` before accepting a restored copy. Do not reconstruct the system from another repository's adapted copy.
